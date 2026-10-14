// Sign-in is handled by Cloudflare Access in front of the whole hostname.
// The Worker still verifies the Access token on every API request (defense in depth),
// then looks the person up in the users table to find their role.

import { HttpError, nowISO } from "./util";
import { appendAudit } from "./audit";

export type Role = "admin" | "staff" | "viewer";
export interface User { email: string; role: Role }

const RANK: Record<Role, number> = { viewer: 1, staff: 2, admin: 3 };
export function requireRole(user: User, role: Role): void {
  if (RANK[user.role] < RANK[role]) {
    throw new HttpError(403, role === "admin" ? "Only an admin can do this." : "Your account has view-only access.");
  }
}

/* ---------- Access token verification ---------- */

interface Jwk { kid: string; kty: string; n: string; e: string; alg?: string }
// Public signing keys are cached per isolate. They are not request state and rotate rarely.
let keyCache: { domain: string; fetchedAt: number; keys: Map<string, CryptoKey> } | null = null;

function b64urlToBytes(s: string): Uint8Array {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4 ? 4 - (s.length % 4) : 0;
  const bin = atob(s + "=".repeat(pad));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const b64urlJSON = (s: string) => JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));

async function signingKeys(domain: string, forceRefresh: boolean): Promise<Map<string, CryptoKey>> {
  if (!forceRefresh && keyCache && keyCache.domain === domain && Date.now() - keyCache.fetchedAt < 3600_000) return keyCache.keys;
  const res = await fetch(`${domain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new HttpError(503, "Couldn't reach Cloudflare Access to check your sign-in.");
  const body = (await res.json()) as { keys: Jwk[] };
  const keys = new Map<string, CryptoKey>();
  for (const jwk of body.keys || []) {
    if (jwk.kty !== "RSA") continue;
    const key = await crypto.subtle.importKey("jwk", jwk as JsonWebKey, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    keys.set(jwk.kid, key);
  }
  keyCache = { domain, fetchedAt: Date.now(), keys };
  return keys;
}

function readToken(request: Request): string | null {
  const header = request.headers.get("Cf-Access-Jwt-Assertion");
  if (header) return header;
  const cookie = request.headers.get("Cookie") || "";
  const m = cookie.match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
  return m ? m[1] : null;
}

async function verifyAccessToken(token: string, env: Env): Promise<string> {
  const domain = String(env.ACCESS_TEAM_DOMAIN).replace(/\/+$/, "");
  const aud = String(env.ACCESS_AUD);
  const parts = token.split(".");
  if (parts.length !== 3) throw new HttpError(401, "Your sign-in token is malformed. Sign in again.");
  const header = b64urlJSON(parts[0]);
  const payload = b64urlJSON(parts[1]);
  if (header.alg !== "RS256") throw new HttpError(401, "Unsupported sign-in token.");

  let keys = await signingKeys(domain, false);
  if (!keys.has(header.kid)) keys = await signingKeys(domain, true); // keys may have rotated
  const key = keys.get(header.kid);
  if (!key) throw new HttpError(401, "Your sign-in couldn't be verified. Sign in again.");
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlToBytes(parts[2]), new TextEncoder().encode(parts[0] + "." + parts[1]));
  if (!ok) throw new HttpError(401, "Your sign-in couldn't be verified. Sign in again.");

  const now = Math.floor(Date.now() / 1000);
  const auds: string[] = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(aud)) throw new HttpError(401, "This sign-in is for a different application.");
  if (payload.iss !== domain) throw new HttpError(401, "This sign-in came from an unexpected issuer.");
  if (typeof payload.exp !== "number" || payload.exp < now - 30) throw new HttpError(401, "Your sign-in has expired. Reload the page to sign in again.");
  if (typeof payload.nbf === "number" && payload.nbf > now + 30) throw new HttpError(401, "Your sign-in isn't valid yet.");
  if (!payload.email) throw new HttpError(401, "Your sign-in has no email address. Use a person's login, not a service token.");
  return String(payload.email).toLowerCase();
}

async function identify(request: Request, env: Env): Promise<string> {
  if (String(env.ACCESS_AUD)) {
    const token = readToken(request);
    if (!token) throw new HttpError(401, "You're not signed in. Reload the page to sign in.");
    return verifyAccessToken(token, env);
  }
  // Local development only: with no Access audience configured, accept DEV_USER_EMAIL from localhost.
  const host = new URL(request.url).hostname;
  const dev = (env as unknown as { DEV_USER_EMAIL?: string }).DEV_USER_EMAIL;
  if (dev && (host === "localhost" || host === "127.0.0.1")) return dev.toLowerCase();
  throw new HttpError(500, "Sign-in isn't configured. Set ACCESS_TEAM_DOMAIN and ACCESS_AUD for this Worker.");
}

/* ---------- Users ---------- */

export async function authenticate(request: Request, env: Env, ctx: ExecutionContext): Promise<User> {
  const email = await identify(request, env);
  let row = await env.DB.prepare("SELECT email, role, active, last_seen_at FROM users WHERE email = ?")
    .bind(email).first<{ email: string; role: Role; active: number; last_seen_at: string | null }>();

  if (!row) {
    const admins = String(env.BOOTSTRAP_ADMINS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (!admins.includes(email)) {
      throw new HttpError(403, `${email} doesn't have access to the portal yet. Ask an admin to add you.`);
    }
    const at = nowISO();
    await appendAudit(env.DB, [
      env.DB.prepare("INSERT OR IGNORE INTO users (email, role, active, created_at, created_by, last_seen_at) VALUES (?, 'admin', 1, ?, 'bootstrap', ?)").bind(email, at, at),
    ], [{ actor: email, entity: "user", entityId: email, action: "Admin added", detail: "Added from BOOTSTRAP_ADMINS on first sign-in" }]);
    row = { email, role: "admin", active: 1, last_seen_at: at };
  }
  if (!row.active) throw new HttpError(403, `${email} has been deactivated. Ask an admin if you need access.`);

  // Record activity at most every 15 minutes, without delaying the response.
  if (!row.last_seen_at || Date.now() - Date.parse(row.last_seen_at) > 15 * 60_000) {
    ctx.waitUntil(env.DB.prepare("UPDATE users SET last_seen_at = ? WHERE email = ?").bind(nowISO(), email).run().catch(() => {}));
  }
  return { email: row.email.toLowerCase(), role: row.role };
}
