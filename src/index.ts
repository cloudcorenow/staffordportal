import {
  FIELDS, validateAccount, normalizeAccount, checkImportRows, MAX_IMPORT_ROWS, parseDate,
  defaultTemplates, DEFAULT_LETTERHEAD, DEFAULT_BODY, buildLetterHTML, mergeValues, templateLabel, fmtShortDate, UNVERIFIED_MARK,
} from "../public/js/shared.js";
import { authenticate, requireRole, type User, type Role } from "./auth";
import { appendAudit, verifyChain, type AuditEntry } from "./audit";
import { HttpError, json, withSecurityHeaders, newId, nowISO, todayIn, readJSON, cents, fromCents, chunkByJsonSize } from "./util";

/* ---------- Row mapping ---------- */

interface AccountRow {
  id: string; acct_no: string; name: string; addr1: string; addr2: string; city: string; state: string; zip: string;
  creditor: string; cred_acct: string; balance_cents: number; payment_id: string; charge_off: string;
  created_at: string; created_by: string; updated_at: string; updated_by: string;
}
type Account = { id: string; acctNo: string; name: string; addr1: string; addr2: string; city: string; state: string; zip: string; creditor: string; credAcct: string; balance: string; paymentId: string; chargeOff: string; updatedAt?: string; updatedBy?: string };

const toAccount = (r: AccountRow): Account => ({
  id: r.id, acctNo: r.acct_no, name: r.name, addr1: r.addr1, addr2: r.addr2, city: r.city, state: r.state, zip: r.zip,
  creditor: r.creditor, credAcct: r.cred_acct, balance: fromCents(r.balance_cents), paymentId: r.payment_id, chargeOff: r.charge_off,
  updatedAt: r.updated_at, updatedBy: r.updated_by,
});

interface TemplateRow { id: string; name: string; description: string; kind: "layout" | "text"; body: string; placeholder: number; verified: number; verified_by: string | null; verified_at: string | null; sort: number; archived: number; updated_at: string; updated_by: string }
const toTemplate = (r: TemplateRow) => ({
  id: r.id, name: r.name, description: r.description, kind: r.kind, body: r.body, placeholder: !!r.placeholder,
  verified: !!r.verified, verifiedBy: r.verified_by, verifiedAt: r.verified_at, sort: r.sort, archived: !!r.archived, updatedAt: r.updated_at, updatedBy: r.updated_by,
});

const LETTER_META_COLS = "id, account_id, template_id, template_name, template_short, kind, letter_date, batch_id, created_at, created_by, sent_date, sent_entered_at, sent_entered_by";
interface LetterRow { id: string; account_id: string; template_id: string; template_name: string; template_short: string; kind: string; letter_date: string; batch_id: string | null; created_at: string; created_by: string; sent_date: string | null; sent_entered_at: string | null; sent_entered_by: string | null }
interface CorrectionRow { id: string; letter_id: string; prev_date: string; new_date: string; reason: string; at: string; by: string }
const toLetter = (r: LetterRow, corrections: CorrectionRow[] = []) => ({
  id: r.id, accountId: r.account_id, templateId: r.template_id, templateName: r.template_name, templateShort: r.template_short, kind: r.kind,
  letterDate: r.letter_date, batchId: r.batch_id, createdAt: r.created_at, createdBy: r.created_by,
  sentDate: r.sent_date, sentEnteredAt: r.sent_entered_at, sentEnteredBy: r.sent_entered_by,
  corrections: corrections.map((c) => ({ prev: c.prev_date, next: c.new_date, reason: c.reason, at: c.at, by: c.by })),
});

interface LedgerRow { id: string; account_id: string; r2_key: string; filename: string; size: number; content_type: string; uploaded_at: string; uploaded_by: string }
const toLedger = (r: LedgerRow) => ({ id: r.id, accountId: r.account_id, name: r.filename, size: r.size, contentType: r.content_type, at: r.uploaded_at, by: r.uploaded_by });

/* ---------- Helpers ---------- */

const today = (env: Env) => todayIn(String(env.TIMEZONE || "America/Los_Angeles"));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function getAccount(env: Env, id: string): Promise<Account> {
  const r = await env.DB.prepare("SELECT * FROM accounts WHERE id = ?").bind(id).first<AccountRow>();
  if (!r) throw new HttpError(404, "That account no longer exists.");
  return toAccount(r);
}
async function acctNoTaken(env: Env, acctNo: string, exceptId: string | null): Promise<boolean> {
  const r = await env.DB.prepare("SELECT id FROM accounts WHERE acct_no = ? COLLATE NOCASE").bind(acctNo).first<{ id: string }>();
  return !!r && r.id !== exceptId;
}
function fieldErrors(errs: Record<string, string>) {
  if (Object.keys(errs).length) throw new HttpError(422, "Some fields need attention.", { fields: errs });
}
function isUniqueAcctNo(err: unknown) { return /UNIQUE constraint failed: accounts\.acct_no/i.test(String((err as Error)?.message || err)); }

async function ensureSeeded(env: Env) {
  const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM templates").first<{ n: number }>();
  if (n && n.n > 0) return;
  const at = nowISO();
  const stmts = defaultTemplates().map((t) =>
    env.DB.prepare("INSERT OR IGNORE INTO templates (id, name, description, kind, body, placeholder, verified, sort, archived, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, 0, ?, 0, ?, 'system')")
      .bind(t.id, t.name, t.description, t.kind, t.body, t.placeholder ? 1 : 0, t.sort, at));
  stmts.push(env.DB.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('letterhead', ?)").bind(DEFAULT_LETTERHEAD));
  await env.DB.batch(stmts);
}

/* ---------- Route handlers ---------- */

async function bootstrap(env: Env, user: User) {
  await ensureSeeded(env);
  const [accounts, letters, corrections, ledgers, templates, letterhead] = await Promise.all([
    env.DB.prepare("SELECT * FROM accounts ORDER BY name COLLATE NOCASE").all<AccountRow>(),
    env.DB.prepare(`SELECT ${LETTER_META_COLS} FROM letters ORDER BY created_at`).all<LetterRow>(),
    env.DB.prepare("SELECT * FROM sent_corrections ORDER BY at").all<CorrectionRow>(),
    env.DB.prepare("SELECT * FROM ledgers ORDER BY uploaded_at").all<LedgerRow>(),
    env.DB.prepare("SELECT * FROM templates WHERE archived = 0 ORDER BY sort, name").all<TemplateRow>(),
    env.DB.prepare("SELECT value FROM settings WHERE key = 'letterhead'").first<{ value: string }>(),
  ]);
  const byLetter = new Map<string, CorrectionRow[]>();
  for (const c of corrections.results) (byLetter.get(c.letter_id) || byLetter.set(c.letter_id, []).get(c.letter_id)!).push(c);
  return {
    me: user, today: today(env),
    accounts: accounts.results.map(toAccount),
    letters: letters.results.map((l) => toLetter(l, byLetter.get(l.id))),
    ledgers: ledgers.results.map(toLedger),
    templates: templates.results.map(toTemplate),
    letterhead: letterhead?.value ?? DEFAULT_LETTERHEAD,
  };
}

async function createAccount(env: Env, user: User, request: Request) {
  requireRole(user, "staff");
  const body = await readJSON<Record<string, string>>(request);
  const taken = await acctNoTaken(env, String(body.acctNo || "").trim(), null);
  fieldErrors(validateAccount(body, { isDuplicate: () => taken, today: today(env) }));
  const a = normalizeAccount(body);
  const id = newId(), at = nowISO();
  try {
    await appendAudit(env.DB, [
      env.DB.prepare(`INSERT INTO accounts (id, acct_no, name, addr1, addr2, city, state, zip, creditor, cred_acct, balance_cents, payment_id, charge_off, created_at, created_by, updated_at, updated_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(id, a.acctNo, a.name, a.addr1, a.addr2, a.city, a.state, a.zip, a.creditor, a.credAcct, cents(a.balance), a.paymentId, a.chargeOff, at, user.email, at, user.email),
    ], [{ actor: user.email, accountId: id, entity: "account", entityId: id, action: "Account created", detail: "Created manually" }]);
  } catch (e) {
    if (isUniqueAcctNo(e)) fieldErrors({ acctNo: "Already exists in the portal" });
    throw e;
  }
  return getAccount(env, id);
}

async function updateAccount(env: Env, user: User, request: Request, id: string) {
  requireRole(user, "staff");
  const current = await getAccount(env, id);
  const body = await readJSON<Record<string, string>>(request);
  const taken = await acctNoTaken(env, String(body.acctNo || "").trim(), id);
  fieldErrors(validateAccount(body, { isDuplicate: () => taken, today: today(env) }));
  const a = normalizeAccount(body);
  const changed = FIELDS.filter((f) => String(current[f.key] ?? "") !== String(a[f.key] ?? ""));
  if (!changed.length) return current;
  const detail = "Changed: " + changed.map((f) => `${f.label} (${current[f.key] || "blank"} to ${a[f.key] || "blank"})`).join("; ");
  try {
    await appendAudit(env.DB, [
      env.DB.prepare(`UPDATE accounts SET acct_no=?, name=?, addr1=?, addr2=?, city=?, state=?, zip=?, creditor=?, cred_acct=?, balance_cents=?, payment_id=?, charge_off=?, updated_at=?, updated_by=? WHERE id=?`)
        .bind(a.acctNo, a.name, a.addr1, a.addr2, a.city, a.state, a.zip, a.creditor, a.credAcct, cents(a.balance), a.paymentId, a.chargeOff, nowISO(), user.email, id),
    ], [{ actor: user.email, accountId: id, entity: "account", entityId: id, action: "Account updated", detail }]);
  } catch (e) {
    if (isUniqueAcctNo(e)) fieldErrors({ acctNo: "Already exists in the portal" });
    throw e;
  }
  return getAccount(env, id);
}

async function importAccounts(env: Env, user: User, request: Request) {
  requireRole(user, "staff");
  const body = await readJSON<{ rows: { line: number; raw: Record<string, string> }[] }>(request, 20_000_000);
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (!rows.length) throw new HttpError(400, "There are no rows to import.");
  if (rows.length > MAX_IMPORT_ROWS) throw new HttpError(400, `Import up to ${MAX_IMPORT_ROWS} accounts at a time.`);
  const existing = new Set((await env.DB.prepare("SELECT acct_no FROM accounts").all<{ acct_no: string }>()).results.map((r) => r.acct_no.toLowerCase()));
  const checked = checkImportRows(rows.map((r, i) => ({ line: Number(r.line) || i + 2, raw: r.raw || {} })), { existing: (n: string) => existing.has(n.toLowerCase()), today: today(env) });
  const bad = checked.filter((r: { errs: Record<string, string> }) => Object.keys(r.errs).length);
  if (bad.length) throw new HttpError(422, "Some rows need attention. Nothing was imported.", { rows: checked.map((r: { line: number; errs: Record<string, string> }) => ({ line: r.line, errs: r.errs })) });

  const at = nowISO(), batch = newId(), audit: AuditEntry[] = [], ids: string[] = [], rowsOut: unknown[][] = [];
  for (const r of checked) {
    const a = normalizeAccount(r.raw); const id = newId(); ids.push(id);
    rowsOut.push([id, a.acctNo, a.name, a.addr1, a.addr2, a.city, a.state, a.zip, a.creditor, a.credAcct, cents(a.balance), a.paymentId, a.chargeOff]);
    audit.push({ actor: user.email, accountId: id, entity: "account", entityId: id, action: "Account created", detail: `CSV import ${batch.slice(0, 8)}, row ${r.line}` });
  }
  // A few bulk statements, all in one transaction with the history: the whole file imports or none of it does.
  const stmts = chunkByJsonSize(rowsOut).map((chunk) =>
    env.DB.prepare(`INSERT INTO accounts (id, acct_no, name, addr1, addr2, city, state, zip, creditor, cred_acct, balance_cents, payment_id, charge_off, created_at, created_by, updated_at, updated_by)
      SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]'), json_extract(value, '$[4]'),
             json_extract(value, '$[5]'), json_extract(value, '$[6]'), json_extract(value, '$[7]'), json_extract(value, '$[8]'), json_extract(value, '$[9]'),
             json_extract(value, '$[10]'), json_extract(value, '$[11]'), json_extract(value, '$[12]'), ?2, ?3, ?2, ?3
      FROM json_each(?1) ORDER BY key`).bind(JSON.stringify(chunk), at, user.email));
  try { await appendAudit(env.DB, stmts, audit); }
  catch (e) { if (isUniqueAcctNo(e)) throw new HttpError(409, "Another person just added one of these account numbers. Review again."); throw e; }
  const imported: Account[] = [];
  for (const chunk of chunkByJsonSize(ids)) {
    const { results } = await env.DB.prepare(`SELECT * FROM accounts WHERE id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(chunk)).all<AccountRow>();
    imported.push(...results.map(toAccount));
  }
  return { imported };
}

async function accountHistory(env: Env, id: string) {
  const { results } = await env.DB.prepare("SELECT seq, at, actor, action, detail FROM audit_log WHERE account_id = ? ORDER BY seq DESC LIMIT 500").bind(id).all();
  return { history: results };
}

async function generateLetters(env: Env, user: User, request: Request) {
  requireRole(user, "staff");
  const body = await readJSON<{ accountIds: string[]; templateId: string; letterDate: string; batchId?: string }>(request);
  const ids = [...new Set(Array.isArray(body.accountIds) ? body.accountIds.map(String) : [])];
  if (!ids.length) throw new HttpError(400, "Select at least one account.");
  if (ids.length > 100) throw new HttpError(400, "Generate up to 100 letters per request.");
  const letterDate = parseDate(body.letterDate);
  if (!letterDate) throw new HttpError(422, "Choose the date to print on the letter.");
  const tpl = await env.DB.prepare("SELECT * FROM templates WHERE id = ? AND archived = 0").bind(body.templateId).first<TemplateRow>();
  if (!tpl) throw new HttpError(404, "That letter template isn't available.");
  const letterhead = (await env.DB.prepare("SELECT value FROM settings WHERE key = 'letterhead'").first<{ value: string }>())?.value ?? DEFAULT_LETTERHEAD;
  const batchId = ids.length > 1 || body.batchId ? (body.batchId && UUID.test(body.batchId) ? body.batchId : newId()) : null;

  const { results } = await env.DB.prepare("SELECT * FROM accounts WHERE id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(ids)).all<AccountRow>();
  if (results.length !== ids.length) throw new HttpError(404, "One or more accounts no longer exist.");
  const t = today(env);
  const incomplete = results.map(toAccount).filter((a) => Object.keys(validateAccount(a, { today: t })).length);
  if (incomplete.length) throw new HttpError(422, `Complete the account information first: ${incomplete.map((a) => a.acctNo).join(", ")}.`);

  const label = templateLabel(tpl), at = nowISO(), mark = tpl.verified ? "" : UNVERIFIED_MARK;
  const audit: AuditEntry[] = [], newIds: string[] = [], rowsOut: unknown[][] = [];
  for (const r of results) {
    const a = toAccount(r); const id = newId(); newIds.push(id);
    const html = buildLetterHTML({ kind: tpl.kind, body: tpl.body, letterhead }, mergeValues(a, letterDate), mark);
    rowsOut.push([id, a.id, html, JSON.stringify(a)]);
    audit.push({ actor: user.email, accountId: a.id, entity: "letter", entityId: id, action: "Letter generated", detail: `${label}, dated ${fmtShortDate(letterDate)}${batchId ? " (batch)" : ""}${mark ? ". Template not yet verified" : ""}` });
  }
  const stmts = chunkByJsonSize(rowsOut).map((chunk) =>
    env.DB.prepare(`INSERT INTO letters (id, account_id, template_id, template_name, template_short, kind, letter_date, batch_id, html, snapshot, created_at, created_by)
      SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), ?2, ?3, ?4, ?5, ?6, ?7, json_extract(value, '$[2]'), json_extract(value, '$[3]'), ?8, ?9
      FROM json_each(?1) ORDER BY key`).bind(JSON.stringify(chunk), tpl.id, label, tpl.name, tpl.kind, letterDate, batchId, at, user.email));
  await appendAudit(env.DB, stmts, audit);
  const rows = await env.DB.prepare(`SELECT ${LETTER_META_COLS} FROM letters WHERE id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(newIds)).all<LetterRow>();
  return { batchId, letters: rows.results.map((l) => toLetter(l)) };
}

async function letterHtml(env: Env, request: Request) {
  const body = await readJSON<{ ids: string[] }>(request);
  const ids = Array.isArray(body.ids) ? body.ids.map(String).slice(0, 300) : [];
  if (!ids.length) return { letters: [] };
  const { results } = await env.DB.prepare("SELECT id, html FROM letters WHERE id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(ids)).all<{ id: string; html: string }>();
  const map = new Map(results.map((r) => [r.id, r.html]));
  return { letters: ids.filter((id) => map.has(id)).map((id) => ({ id, html: map.get(id) })) };
}

async function letterWithCorrections(env: Env, id: string) {
  const l = await env.DB.prepare(`SELECT ${LETTER_META_COLS} FROM letters WHERE id = ?`).bind(id).first<LetterRow>();
  if (!l) throw new HttpError(404, "That letter no longer exists.");
  const c = await env.DB.prepare("SELECT * FROM sent_corrections WHERE letter_id = ? ORDER BY at").bind(id).all<CorrectionRow>();
  return toLetter(l, c.results);
}

async function recordSent(env: Env, user: User, request: Request, id: string) {
  requireRole(user, "staff");
  const body = await readJSON<{ date: string; reason?: string; expectedCurrent?: string | null }>(request);
  const date = parseDate(body.date);
  if (!date) throw new HttpError(422, "Enter a valid date.");
  if (date > today(env)) throw new HttpError(422, "The sent date can't be in the future.");
  const l = await letterWithCorrections(env, id);
  if (body.expectedCurrent !== undefined && (body.expectedCurrent || null) !== (l.sentDate || null)) {
    throw new HttpError(409, "Someone else changed this sent date a moment ago. Review it and try again.");
  }
  const at = nowISO();
  if (!l.sentDate) {
    await appendAudit(env.DB, [
      env.DB.prepare("UPDATE letters SET sent_date = ?, sent_entered_at = ?, sent_entered_by = ? WHERE id = ? AND sent_date IS NULL").bind(date, at, user.email, id),
    ], [{ actor: user.email, accountId: l.accountId, entity: "letter", entityId: id, action: "Sent date recorded", detail: `${l.templateName} dated ${fmtShortDate(l.letterDate)} sent ${fmtShortDate(date)}` }]);
  } else {
    const reason = String(body.reason || "").trim();
    if (!reason) throw new HttpError(422, "A reason is required to correct a recorded sent date.");
    if (reason.length > 1000) throw new HttpError(422, "Keep the reason under 1,000 characters.");
    if (date === l.sentDate) throw new HttpError(422, "That's the date already recorded. Choose the corrected date.");
    await appendAudit(env.DB, [
      env.DB.prepare("UPDATE letters SET sent_date = ? WHERE id = ? AND sent_date = ?").bind(date, id, l.sentDate),
      env.DB.prepare("INSERT INTO sent_corrections (id, letter_id, prev_date, new_date, reason, at, by) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(newId(), id, l.sentDate, date, reason, at, user.email),
    ], [{ actor: user.email, accountId: l.accountId, entity: "letter", entityId: id, action: "Sent date corrected", detail: `${l.templateName} dated ${fmtShortDate(l.letterDate)}: ${fmtShortDate(l.sentDate)} changed to ${fmtShortDate(date)}. Reason: ${reason}` }]);
  }
  return letterWithCorrections(env, id);
}

async function recordSentBatch(env: Env, user: User, request: Request) {
  requireRole(user, "staff");
  const body = await readJSON<{ ids: string[]; date: string }>(request);
  const date = parseDate(body.date);
  if (!date) throw new HttpError(422, "Enter a valid date.");
  if (date > today(env)) throw new HttpError(422, "The sent date can't be in the future.");
  const ids = Array.isArray(body.ids) ? body.ids.map(String).slice(0, 300) : [];
  const { results } = await env.DB.prepare(`SELECT ${LETTER_META_COLS} FROM letters WHERE sent_date IS NULL AND id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(ids)).all<LetterRow>();
  if (!results.length) return { letters: [] };
  const at = nowISO();
  await appendAudit(env.DB,
    [env.DB.prepare("UPDATE letters SET sent_date = ?, sent_entered_at = ?, sent_entered_by = ? WHERE sent_date IS NULL AND id IN (SELECT value FROM json_each(?))").bind(date, at, user.email, JSON.stringify(results.map((l) => l.id)))],
    results.map((l) => ({ actor: user.email, accountId: l.account_id, entity: "letter", entityId: l.id, action: "Sent date recorded", detail: `${l.template_name} dated ${fmtShortDate(l.letter_date)} sent ${fmtShortDate(date)} (batch entry)` })));
  const after = await env.DB.prepare(`SELECT ${LETTER_META_COLS} FROM letters WHERE id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(results.map((l) => l.id))).all<LetterRow>();
  return { letters: after.results.map((l) => toLetter(l)) };
}

/* Ledger files stream straight into R2; only the metadata goes to D1. */
async function uploadLedger(env: Env, user: User, request: Request, accountId: string, url: URL) {
  requireRole(user, "staff");
  await getAccount(env, accountId);
  const filename = (url.searchParams.get("filename") || "").replace(/[\u0000-\u001f\\/]/g, "_").slice(0, 200).trim();
  if (!filename) throw new HttpError(400, "The file needs a name.");
  const size = Number(request.headers.get("Content-Length") || 0);
  const max = Number(env.MAX_UPLOAD_MB || 25) * 1024 * 1024;
  if (!size) throw new HttpError(400, "The file is empty.");
  if (size > max) throw new HttpError(413, `Ledger files can be up to ${env.MAX_UPLOAD_MB || 25} MB.`);
  if (!request.body) throw new HttpError(400, "The file is empty.");
  const contentType = (request.headers.get("Content-Type") || "application/octet-stream").slice(0, 100);
  const id = newId(), key = `ledgers/${accountId}/${id}`, at = nowISO();
  await env.FILES.put(key, request.body, {
    httpMetadata: { contentType },
    customMetadata: { filename, accountId, uploadedBy: user.email, uploadedAt: at },
  });
  try {
    await appendAudit(env.DB, [
      env.DB.prepare("INSERT INTO ledgers (id, account_id, r2_key, filename, size, content_type, uploaded_at, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(id, accountId, key, filename, size, contentType, at, user.email),
    ], [{ actor: user.email, accountId, entity: "ledger", entityId: id, action: "Ledger attached", detail: `${filename} (${(size / 1024).toFixed(1)} KB)` }]);
  } catch (e) {
    await env.FILES.delete(key).catch(() => {}); // don't leave an orphaned object behind
    throw e;
  }
  return toLedger({ id, account_id: accountId, r2_key: key, filename, size, content_type: contentType, uploaded_at: at, uploaded_by: user.email });
}

async function downloadLedger(env: Env, id: string) {
  const row = await env.DB.prepare("SELECT * FROM ledgers WHERE id = ?").bind(id).first<LedgerRow>();
  if (!row) throw new HttpError(404, "That ledger no longer exists.");
  const obj = await env.FILES.get(row.r2_key);
  if (!obj) throw new HttpError(404, "The ledger file is missing from storage.");
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(row.filename)}`);
  headers.set("Content-Length", String(obj.size));
  headers.set("Cache-Control", "private, no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(obj.body, { headers });
}

/* ---------- Templates and settings (admin) ---------- */

async function saveTemplate(env: Env, user: User, request: Request, id: string | null) {
  requireRole(user, "admin");
  const body = await readJSON<{ name: string; description?: string; body?: string; kind?: "text" | "layout" }>(request, 1_000_000);
  const name = String(body.name || "").trim(), description = String(body.description || "").trim();
  if (!name) throw new HttpError(422, "Give the template a name.");
  const clash = await env.DB.prepare("SELECT id FROM templates WHERE name = ? COLLATE NOCASE AND archived = 0 AND id IS NOT ?").bind(name, id).first();
  if (clash) throw new HttpError(422, "Another template already uses that name.");
  const at = nowISO();
  if (!id) {
    const nid = newId();
    const sort = ((await env.DB.prepare("SELECT MAX(sort) AS m FROM templates").first<{ m: number }>())?.m ?? 0) + 1;
    await appendAudit(env.DB, [
      env.DB.prepare("INSERT INTO templates (id, name, description, kind, body, placeholder, verified, sort, archived, updated_at, updated_by) VALUES (?, ?, ?, 'text', ?, 1, 0, ?, 0, ?, ?)")
        .bind(nid, name, description, String(body.body || DEFAULT_BODY), sort, at, user.email),
    ], [{ actor: user.email, entity: "template", entityId: nid, action: "Template added", detail: name }]);
    return toTemplate((await env.DB.prepare("SELECT * FROM templates WHERE id = ?").bind(nid).first<TemplateRow>())!);
  }
  const cur = await env.DB.prepare("SELECT * FROM templates WHERE id = ? AND archived = 0").bind(id).first<TemplateRow>();
  if (!cur) throw new HttpError(404, "That template no longer exists.");
  const newBody = body.body == null ? cur.body : String(body.body);
  const bodyChanged = newBody !== cur.body;
  const changes = [cur.name !== name && `name ${cur.name} to ${name}`, cur.description !== description && "description", bodyChanged && "wording"].filter(Boolean);
  if (!changes.length) return toTemplate(cur);
  await appendAudit(env.DB, [
    env.DB.prepare(`UPDATE templates SET name=?, description=?, body=?, placeholder=CASE WHEN ? THEN 0 ELSE placeholder END,
      verified=CASE WHEN ? THEN 0 ELSE verified END, verified_by=CASE WHEN ? THEN NULL ELSE verified_by END, verified_at=CASE WHEN ? THEN NULL ELSE verified_at END,
      updated_at=?, updated_by=? WHERE id=?`).bind(name, description, newBody, bodyChanged ? 1 : 0, bodyChanged ? 1 : 0, bodyChanged ? 1 : 0, bodyChanged ? 1 : 0, at, user.email, id),
  ], [{ actor: user.email, entity: "template", entityId: id, action: "Template edited", detail: `${name}: changed ${changes.join(", ")}${bodyChanged && cur.verified ? ". Verification cleared because the wording changed" : ""}` }]);
  return toTemplate((await env.DB.prepare("SELECT * FROM templates WHERE id = ?").bind(id).first<TemplateRow>())!);
}

async function setTemplateVerified(env: Env, user: User, request: Request, id: string) {
  requireRole(user, "admin");
  const { verified } = await readJSON<{ verified: boolean }>(request);
  const cur = await env.DB.prepare("SELECT * FROM templates WHERE id = ? AND archived = 0").bind(id).first<TemplateRow>();
  if (!cur) throw new HttpError(404, "That template no longer exists.");
  const at = nowISO();
  await appendAudit(env.DB, [
    env.DB.prepare("UPDATE templates SET verified = ?, verified_by = ?, verified_at = ? WHERE id = ?").bind(verified ? 1 : 0, verified ? user.email : null, verified ? at : null, id),
  ], [{ actor: user.email, entity: "template", entityId: id, action: verified ? "Template verified" : "Template verification removed", detail: verified ? `${templateLabel(cur)} checked against the approved Word original` : templateLabel(cur) }]);
  return toTemplate((await env.DB.prepare("SELECT * FROM templates WHERE id = ?").bind(id).first<TemplateRow>())!);
}

async function archiveTemplate(env: Env, user: User, id: string) {
  requireRole(user, "admin");
  const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM templates WHERE archived = 0").first<{ n: number }>();
  if ((n?.n ?? 0) < 2) throw new HttpError(422, "Keep at least one template.");
  const cur = await env.DB.prepare("SELECT * FROM templates WHERE id = ? AND archived = 0").bind(id).first<TemplateRow>();
  if (!cur) throw new HttpError(404, "That template no longer exists.");
  await appendAudit(env.DB, [env.DB.prepare("UPDATE templates SET archived = 1, updated_at = ?, updated_by = ? WHERE id = ?").bind(nowISO(), user.email, id)],
    [{ actor: user.email, entity: "template", entityId: id, action: "Template removed", detail: `${templateLabel(cur)}. Letters already generated from it are kept` }]);
  return { ok: true };
}

async function saveLetterhead(env: Env, user: User, request: Request) {
  requireRole(user, "admin");
  const { value } = await readJSON<{ value: string }>(request);
  const v = String(value || "").slice(0, 2000);
  const cur = await env.DB.prepare("SELECT value FROM settings WHERE key = 'letterhead'").first<{ value: string }>();
  if (cur?.value === v) return { letterhead: v };
  await appendAudit(env.DB, [env.DB.prepare("INSERT INTO settings (key, value) VALUES ('letterhead', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(v)],
    [{ actor: user.email, entity: "settings", entityId: "letterhead", action: "Letterhead edited", detail: v.split("\n").join(" / ") }]);
  return { letterhead: v };
}

/* ---------- Users (admin) ---------- */

async function listUsers(env: Env, user: User) {
  requireRole(user, "admin");
  const { results } = await env.DB.prepare("SELECT email, role, active, created_at, created_by, last_seen_at FROM users ORDER BY active DESC, email").all();
  return { users: results };
}
async function saveUser(env: Env, user: User, request: Request) {
  requireRole(user, "admin");
  const body = await readJSON<{ email: string; role: Role; active?: boolean }>(request);
  const email = String(body.email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(422, "Enter a valid email address.");
  if (!["admin", "staff", "viewer"].includes(body.role)) throw new HttpError(422, "Choose a role.");
  const active = body.active === false ? 0 : 1;
  if (email === user.email && (body.role !== "admin" || !active)) throw new HttpError(422, "You can't remove your own admin access. Ask another admin.");
  const cur = await env.DB.prepare("SELECT role, active FROM users WHERE email = ?").bind(email).first<{ role: Role; active: number }>();
  const at = nowISO();
  const action = !cur ? "User added" : cur.active && !active ? "User deactivated" : !cur.active && active ? "User reactivated" : "User role changed";
  if (cur && cur.role === body.role && cur.active === active) return listUsers(env, user);
  await appendAudit(env.DB, [
    env.DB.prepare("INSERT INTO users (email, role, active, created_at, created_by) VALUES (?, ?, ?, ?, ?) ON CONFLICT(email) DO UPDATE SET role = excluded.role, active = excluded.active")
      .bind(email, body.role, active, at, user.email),
  ], [{ actor: user.email, entity: "user", entityId: email, action, detail: `${email}: ${body.role}${active ? "" : ", deactivated"}${cur ? ` (was ${cur.role}${cur.active ? "" : ", deactivated"})` : ""}` }]);
  return listUsers(env, user);
}

/* ---------- Backups ---------- */

const BACKUP_TABLES = ["users", "accounts", "templates", "settings", "letters", "sent_corrections", "ledgers", "audit_log"] as const;

async function gzip(text: string): Promise<ArrayBuffer> {
  return new Response(new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
}

/* Writes every table as gzipped NDJSON pages under backups/<timestamp>/, plus a manifest. */
export async function runBackup(env: Env, trigger: string): Promise<{ prefix: string; counts: Record<string, number> }> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const prefix = `backups/${stamp}/`;
  const counts: Record<string, number> = {};
  for (const table of BACKUP_TABLES) {
    const order = table === "audit_log" ? "seq" : table === "settings" ? "key" : table === "users" ? "email" : "id";
    let offset = 0, page = 0;
    counts[table] = 0;
    for (;;) {
      const { results } = await env.DB.prepare(`SELECT * FROM ${table} ORDER BY ${order} LIMIT 500 OFFSET ?`).bind(offset).all();
      if (!results.length) break;
      await env.FILES.put(`${prefix}${table}-${String(++page).padStart(4, "0")}.ndjson.gz`, await gzip(results.map((r) => JSON.stringify(r)).join("\n") + "\n"),
        { httpMetadata: { contentType: "application/gzip" } });
      counts[table] += results.length; offset += results.length;
      if (results.length < 500) break;
    }
  }
  const chain = await verifyChain(env.DB);
  await env.FILES.put(`${prefix}manifest.json`, JSON.stringify({ createdAt: nowISO(), trigger, counts, auditChain: chain }, null, 2), { httpMetadata: { contentType: "application/json" } });
  await pruneBackups(env);
  return { prefix, counts };
}

async function pruneBackups(env: Env) {
  const days = Number(env.BACKUP_RETENTION_DAYS || 90);
  if (!(days > 0)) return;
  const cutoff = Date.now() - days * 86400_000;
  let cursor: string | undefined;
  do {
    const list = await env.FILES.list({ prefix: "backups/", cursor });
    const old = list.objects.filter((o) => o.uploaded.getTime() < cutoff).map((o) => o.key);
    if (old.length) await env.FILES.delete(old);
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
}

async function listBackups(env: Env, user: User) {
  requireRole(user, "admin");
  const out: { prefix: string; manifest: unknown }[] = [];
  let cursor: string | undefined;
  do {
    const list = await env.FILES.list({ prefix: "backups/", cursor });
    for (const o of list.objects) if (o.key.endsWith("/manifest.json")) out.push({ prefix: o.key.slice(0, -"manifest.json".length), manifest: null });
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
  out.sort((a, b) => (a.prefix < b.prefix ? 1 : -1));
  const recent = out.slice(0, 20);
  await Promise.all(recent.map(async (b) => { const o = await env.FILES.get(b.prefix + "manifest.json"); b.manifest = o ? await o.json() : null; }));
  return { backups: recent, total: out.length };
}

/* ---------- Router ---------- */

type Handler = (args: { env: Env; ctx: ExecutionContext; request: Request; url: URL; user: User; params: string[] }) => Promise<unknown>;
const routes: [string, RegExp, Handler][] = [
  ["GET", /^\/api\/bootstrap$/, ({ env, user }) => bootstrap(env, user)],
  ["POST", /^\/api\/accounts$/, ({ env, user, request }) => createAccount(env, user, request)],
  ["POST", /^\/api\/accounts\/import$/, ({ env, user, request }) => importAccounts(env, user, request)],
  ["PUT", /^\/api\/accounts\/([^/]+)$/, ({ env, user, request, params }) => updateAccount(env, user, request, params[0])],
  ["GET", /^\/api\/accounts\/([^/]+)\/history$/, ({ env, params }) => accountHistory(env, params[0])],
  ["POST", /^\/api\/accounts\/([^/]+)\/ledgers$/, ({ env, user, request, params, url }) => uploadLedger(env, user, request, params[0], url)],
  ["GET", /^\/api\/ledgers\/([^/]+)\/download$/, ({ env, params }) => downloadLedger(env, params[0])],
  ["POST", /^\/api\/letters$/, ({ env, user, request }) => generateLetters(env, user, request)],
  ["POST", /^\/api\/letters\/html$/, ({ env, request }) => letterHtml(env, request)],
  ["POST", /^\/api\/letters\/sent$/, ({ env, user, request }) => recordSentBatch(env, user, request)],
  ["POST", /^\/api\/letters\/([^/]+)\/sent$/, ({ env, user, request, params }) => recordSent(env, user, request, params[0])],
  ["POST", /^\/api\/templates$/, ({ env, user, request }) => saveTemplate(env, user, request, null)],
  ["PUT", /^\/api\/templates\/([^/]+)$/, ({ env, user, request, params }) => saveTemplate(env, user, request, params[0])],
  ["POST", /^\/api\/templates\/([^/]+)\/verify$/, ({ env, user, request, params }) => setTemplateVerified(env, user, request, params[0])],
  ["POST", /^\/api\/templates\/([^/]+)\/archive$/, ({ env, user, params }) => archiveTemplate(env, user, params[0])],
  ["PUT", /^\/api\/settings\/letterhead$/, ({ env, user, request }) => saveLetterhead(env, user, request)],
  ["GET", /^\/api\/users$/, ({ env, user }) => listUsers(env, user)],
  ["PUT", /^\/api\/users$/, ({ env, user, request }) => saveUser(env, user, request)],
  ["GET", /^\/api\/admin\/audit\/verify$/, async ({ env, user }) => { requireRole(user, "admin"); return verifyChain(env.DB); }],
  ["GET", /^\/api\/admin\/backups$/, ({ env, user }) => listBackups(env, user)],
  ["POST", /^\/api\/admin\/backups$/, async ({ env, user }) => {
    requireRole(user, "admin");
    const r = await runBackup(env, `manual by ${user.email}`);
    await appendAudit(env.DB, [], [{ actor: user.email, entity: "backup", entityId: r.prefix, action: "Backup created", detail: r.prefix }]);
    return r;
  }],
];

async function handleApi(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  // Block cross-site form posts: every write must come from the app's own fetch calls.
  if (request.method !== "GET" && request.headers.get("X-Portal-Request") !== "1") {
    throw new HttpError(403, "Requests must come from the portal.");
  }
  const user = await authenticate(request, env, ctx);
  for (const [method, re, handler] of routes) {
    if (request.method !== method) continue;
    const m = url.pathname.match(re);
    if (!m) continue;
    const result = await handler({ env, ctx, request, url, user, params: m.slice(1).map(decodeURIComponent) });
    return result instanceof Response ? withSecurityHeaders(result) : json(result);
  }
  throw new HttpError(404, "Not found.");
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    try {
      return await handleApi(request, env, ctx);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message, ...(err.details ? { details: err.details } : {}) }, err.status);
      console.error(JSON.stringify({ message: "Unhandled API error", path: url.pathname, method: request.method, error: String((err as Error)?.stack || err) }));
      return json({ error: "Something went wrong on the server. Try again, and contact an admin if it keeps happening." }, 500);
    }
  },

  async scheduled(controller, env, ctx): Promise<void> {
    ctx.waitUntil((async () => {
      try {
        const r = await runBackup(env, `scheduled ${controller.cron}`);
        console.log(JSON.stringify({ message: "Backup complete", ...r }));
      } catch (err) {
        console.error(JSON.stringify({ message: "Backup failed", error: String((err as Error)?.stack || err) }));
        throw err;
      }
    })());
  },
} satisfies ExportedHandler<Env>;
