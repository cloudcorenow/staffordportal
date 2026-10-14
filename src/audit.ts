// Every change is written in one D1 batch (a single transaction) together with its audit rows.
// Each audit row stores the previous row's hash and its own SHA-256 hash, forming a chain.
// prev_hash is UNIQUE, so if two requests race to extend the chain, one batch fails as a whole
// and is retried against the new end of the chain.

import { HttpError, nowISO, chunkByJsonSize } from "./util";

export interface AuditEntry {
  actor: string;
  accountId?: string | null;
  entity: string;
  entityId?: string | null;
  action: string;
  detail?: string;
}

export const GENESIS = "genesis";

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function rowHash(prev: string, r: { at: string; actor: string; account_id: string | null; entity: string; entity_id: string | null; action: string; detail: string }) {
  return sha256Hex(prev + "\n" + JSON.stringify([r.at, r.actor, r.account_id, r.entity, r.entity_id, r.action, r.detail]));
}

export async function appendAudit(db: D1Database, statements: D1PreparedStatement[], entries: AuditEntry[]): Promise<D1Result[]> {
  for (let attempt = 0; attempt < 15; attempt++) {
    const last = await db.prepare("SELECT hash FROM audit_log ORDER BY seq DESC LIMIT 1").first<{ hash: string }>();
    let prev = last?.hash ?? GENESIS;
    const at = nowISO();
    const rows: (string | null)[][] = [];
    for (const e of entries) {
      const row = { at, actor: e.actor, account_id: e.accountId ?? null, entity: e.entity, entity_id: e.entityId ?? null, action: e.action, detail: e.detail ?? "" };
      const hash = await rowHash(prev, row);
      rows.push([row.at, row.actor, row.account_id, row.entity, row.entity_id, row.action, row.detail, prev, hash]);
      prev = hash;
    }
    // Written in bulk, in chain order, so even thousands of entries take only a few statements.
    const auditStatements = chunkByJsonSize(rows).map((chunk) =>
      db.prepare(`INSERT INTO audit_log (at, actor, account_id, entity, entity_id, action, detail, prev_hash, hash)
        SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]'), json_extract(value, '$[4]'),
               json_extract(value, '$[5]'), json_extract(value, '$[6]'), json_extract(value, '$[7]'), json_extract(value, '$[8]')
        FROM json_each(?) ORDER BY key`).bind(JSON.stringify(chunk)));
    try {
      return await db.batch([...statements, ...auditStatements]);
    } catch (err) {
      const msg = String((err as Error)?.message || err);
      if (/UNIQUE constraint failed: audit_log\.prev_hash/i.test(msg)) {
        await new Promise((r) => setTimeout(r, 15 * (attempt + 1) + Math.random() * 60 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
  throw new HttpError(503, "The portal is busy saving other changes. Try again in a moment.");
}

/* Recompute the whole chain. Reports the first row that doesn't match, if any. */
export async function verifyChain(db: D1Database): Promise<{ ok: boolean; rows: number; brokenAt?: number; reason?: string; head?: string }> {
  let prev = GENESIS, after = 0, rows = 0;
  for (;;) {
    const { results } = await db.prepare("SELECT seq, at, actor, account_id, entity, entity_id, action, detail, prev_hash, hash FROM audit_log WHERE seq > ? ORDER BY seq LIMIT 1000")
      .bind(after).all<{ seq: number; at: string; actor: string; account_id: string | null; entity: string; entity_id: string | null; action: string; detail: string; prev_hash: string; hash: string }>();
    if (!results.length) break;
    for (const r of results) {
      if (r.prev_hash !== prev) return { ok: false, rows, brokenAt: r.seq, reason: "A row is missing or out of order before this entry." };
      const expected = await rowHash(prev, r);
      if (expected !== r.hash) return { ok: false, rows, brokenAt: r.seq, reason: "This entry was changed after it was written." };
      prev = r.hash; after = r.seq; rows++;
    }
  }
  return { ok: true, rows, head: prev };
}
