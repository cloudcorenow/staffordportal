export class HttpError extends Error {
  constructor(public status: number, message: string, public details?: unknown) { super(message); }
}

const SECURITY_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
};

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...SECURITY_HEADERS } });
}
export function withSecurityHeaders(res: Response): Response {
  const r = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) r.headers.set(k, v);
  return r;
}

export const newId = () => crypto.randomUUID();
export const nowISO = () => new Date().toISOString();

/* "Today" as a calendar date in the office's time zone. */
export function todayIn(tz: string): string {
  try { return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()); }
  catch { return new Date().toISOString().slice(0, 10); }
}

export async function readJSON<T>(request: Request, maxBytes = 2_000_000): Promise<T> {
  const len = Number(request.headers.get("Content-Length") || 0);
  if (len > maxBytes) throw new HttpError(413, "That request is too large.");
  try { return (await request.json()) as T; }
  catch { throw new HttpError(400, "The request body isn't valid JSON."); }
}

export const cents = (balance: string) => Math.round(Number(balance) * 100);
export const fromCents = (c: number) => (c / 100).toFixed(2);

/* Split rows into groups whose JSON stays under maxBytes, so each group can be bound as one
   parameter and written with a single INSERT ... SELECT FROM json_each(?) statement. */
export function chunkByJsonSize<T>(rows: T[], maxBytes = 900_000, maxRows = 2000): T[][] {
  const out: T[][] = []; let cur: T[] = []; let size = 2;
  for (const r of rows) {
    const n = JSON.stringify(r).length + 1;
    if (cur.length && (size + n > maxBytes || cur.length >= maxRows)) { out.push(cur); cur = []; size = 2; }
    cur.push(r); size += n;
  }
  if (cur.length) out.push(cur);
  return out;
}
