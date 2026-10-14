// Shared by the browser app and the Worker. Pure functions only: no DOM, no bindings.
import { LETTER1_LAYOUT } from "./templates.js";

export const COMPANY_NAME = "Stafford Group and Associates";
export const LOGO_PATH = "/logo.png";
export const UNVERIFIED_MARK = "Unverified template";

export const FIELDS = [
  { key: "acctNo",    csv: "simplicity_account_number", label: "Simplicity account number", req: true },
  { key: "name",      csv: "debtor_name",               label: "Debtor full name", req: true },
  { key: "addr1",     csv: "address_line1",             label: "Mailing address", req: true },
  { key: "addr2",     csv: "address_line2",             label: "Address line 2", req: false },
  { key: "city",      csv: "city",                      label: "City", req: true },
  { key: "state",     csv: "state",                     label: "State", req: true },
  { key: "zip",       csv: "zip",                       label: "ZIP", req: true },
  { key: "creditor",  csv: "original_creditor",         label: "Original creditor", req: true },
  { key: "credAcct",  csv: "creditor_account_number",   label: "Creditor account number", req: true },
  { key: "balance",   csv: "balance",                   label: "Account balance", req: true },
  { key: "paymentId", csv: "payment_id",                label: "Payment ID", req: true },
  { key: "chargeOff", csv: "charge_off_date",           label: "Charge-off date", req: true },
];
export const CSV_HEADERS = FIELDS.map((f) => f.csv);
export const fieldLabel = (k) => (FIELDS.find((f) => f.key === k) || { label: k }).label;
export const MAX_IMPORT_ROWS = 5000;

export function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ---------- Dates and money ---------- */
export function isoDay(d) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
export function parseDate(v) {
  v = String(v || "").trim();
  if (!v) return null;
  let y, m, d, r;
  if ((r = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) { y = +r[1]; m = +r[2]; d = +r[3]; }
  else if ((r = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) { m = +r[1]; d = +r[2]; y = +r[3]; }
  else return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return y + "-" + String(m).padStart(2, "0") + "-" + String(d).padStart(2, "0");
}
export function parseBalance(v) {
  v = String(v == null ? "" : v).trim();
  if (!v) return null;
  if (!/^\$?\s?(\d{1,3}(,\d{3})+|\d+)(\.\d{1,2})?$/.test(v)) return null;
  const n = Number(v.replace(/[$,\s]/g, ""));
  return isFinite(n) ? n : null;
}
const isoToUTC = (iso) => { const [y, m, d] = iso.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)); };
export function fmtLongDate(iso) {
  return iso && parseDate(iso) ? isoToUTC(iso).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }) : (iso || "");
}
export function fmtShortDate(iso) {
  return iso && parseDate(iso) ? isoToUTC(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : (iso || "");
}
export function fmtMoney(n) {
  return n == null || n === "" || isNaN(Number(n)) ? "" : Number(n).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

/* ---------- Validation ----------
   isDuplicate(acctNo) reports whether another account already uses the number.
   today is the latest allowed calendar date (YYYY-MM-DD). */
export function validateAccount(a, { isDuplicate = () => false, today } = {}) {
  const e = {};
  const v = (k) => String(a[k] == null ? "" : a[k]).trim();
  for (const f of FIELDS) if (f.req && !v(f.key)) e[f.key] = "Required";
  for (const f of FIELDS) if (!e[f.key] && v(f.key).length > 200) e[f.key] = "Keep this under 200 characters";
  if (!e.balance && parseBalance(a.balance) == null) e.balance = "Use a number like 1250.00 or $1,250.00";
  if (!e.chargeOff && !parseDate(a.chargeOff)) e.chargeOff = "Use YYYY-MM-DD or MM/DD/YYYY";
  if (!e.chargeOff && today && parseDate(a.chargeOff) > today) e.chargeOff = "Can't be in the future";
  if (!e.state && !/^[A-Za-z]{2}$/.test(v("state"))) e.state = "Use the 2-letter state code";
  if (!e.zip && !/^\d{5}(-\d{4})?$/.test(v("zip"))) e.zip = "Use 5 digits or ZIP+4";
  if (!e.acctNo && isDuplicate(v("acctNo"))) e.acctNo = "Already exists in the portal";
  return e;
}
export function normalizeAccount(a) {
  const o = {};
  for (const f of FIELDS) o[f.key] = String(a[f.key] == null ? "" : a[f.key]).trim();
  o.state = o.state.toUpperCase();
  const b = parseBalance(o.balance); if (b != null) o.balance = b.toFixed(2);
  const d = parseDate(o.chargeOff); if (d) o.chargeOff = d;
  return o;
}

/* ---------- CSV ---------- */
export function parseCSV(text) {
  const rows = []; let row = [], f = "", q = false;
  text = String(text || "").replace(/^\uFEFF/, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(f); rows.push(row); row = []; f = ""; }
    else f += c;
  }
  if (f !== "" || row.length) { row.push(f); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim() !== ""));
}
export function csvCell(v) { v = String(v == null ? "" : v); return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
export function csvRowsToAccounts(text) {
  const rows = parseCSV(text);
  if (!rows.length) return { fatal: "No rows found. Paste CSV data or upload a file." };
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const missing = CSV_HEADERS.filter((h) => !head.includes(h));
  if (missing.length) return { fatal: "The header row is missing these columns: " + missing.join(", ") + ". Download the CSV template to see the expected layout." };
  const out = rows.slice(1).map((r, i) => { const raw = {}; FIELDS.forEach((f) => (raw[f.key] = r[head.indexOf(f.csv)] || "")); return { line: i + 2, raw }; });
  if (!out.length) return { fatal: "The file has a header row but no account rows." };
  if (out.length > MAX_IMPORT_ROWS) return { fatal: `This file has ${out.length} accounts. Import up to ${MAX_IMPORT_ROWS} at a time by splitting the file.` };
  return { rows: out };
}
/* Validate a whole import: each row on its own, duplicates within the file, and against existing numbers. */
export function checkImportRows(rows, { existing = () => false, today } = {}) {
  const seen = {};
  return rows.map((x, i) => {
    const errs = validateAccount(x.raw, { isDuplicate: existing, today });
    const n = String(x.raw.acctNo || "").trim().toLowerCase();
    if (n) { if (seen[n] != null) errs.acctNo = "Duplicate of row " + rows[seen[n]].line + " in this file"; else seen[n] = i; }
    return { ...x, errs };
  });
}

/* ---------- Letters ---------- */
export const DEFAULT_LETTERHEAD = "Stafford Group and Associates\nP.O. Box 433\nOrange, CA 92856\nToll Free: 800-820-2207\nwww.staffordga.com";
export const DEFAULT_BODY = `{{letter_date}}

{{debtor_name}}
{{address_block}}

Re: Original creditor: {{original_creditor}}
Creditor account number: {{creditor_account_number}}
Reference number: {{reference_number}}
Payment ID: {{payment_id}}
Charge-off date: {{charge_off_date}}
Balance due: {{balance}}

Dear {{debtor_name}}:

This is our first notice regarding the account referenced above, which has been placed with our office. As of the date of this letter, the balance due is {{balance}}.

To make a payment or discuss this account, please contact our office and refer to your reference number, {{reference_number}}, and payment ID, {{payment_id}}.

Sincerely,

Stafford Group and Associates`;
const P1 = "This is our first notice regarding the account referenced above, which has been placed with our office. As of the date of this letter, the balance due is {{balance}}.";
export function defaultTemplates() {
  return [
    { id: "t1", name: "Letter 1", description: "First notice", kind: "layout", placeholder: false, verified: false, sort: 1, body: LETTER1_LAYOUT },
    { id: "t2", name: "Letter 2", description: "Second notice", kind: "text", placeholder: true, verified: false, sort: 2,
      body: DEFAULT_BODY.replace(P1, "We wrote to you previously about the account referenced above. As of the date of this letter, the balance due remains {{balance}}, and we have not yet received payment or heard from you.") },
    { id: "t3", name: "Letter 3", description: "Final notice", kind: "text", placeholder: true, verified: false, sort: 3,
      body: DEFAULT_BODY.replace(P1, "This is our final notice regarding the account referenced above. As of the date of this letter, the balance due is {{balance}}, and we have not received payment or a response to our earlier letters.") },
  ];
}
export const TOKEN_HELP = ["letter_date", "debtor_name", "address_block", "address_lines", "city_state_zip", "original_creditor", "creditor_account_number", "reference_number", "balance", "balance_amount", "payment_id", "charge_off_date", "company_name"];
export const templateLabel = (t) => t.name + (t.description ? ": " + t.description : "");

export function mergeValues(a, letterDate) {
  const csz = `${a.city || ""}, ${a.state || ""} ${a.zip || ""}`;
  return {
    letter_date: fmtLongDate(letterDate), debtor_name: a.name,
    address_block: [a.addr1, a.addr2, csz].filter(Boolean).join("\n"),
    address_lines: [a.addr1, a.addr2].filter(Boolean).join("\n"), city_state_zip: csz,
    original_creditor: a.creditor, creditor_account_number: a.credAcct, reference_number: a.acctNo,
    balance: fmtMoney(a.balance),
    balance_amount: Number(a.balance || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    payment_id: a.paymentId, charge_off_date: fmtLongDate(a.chargeOff),
    company_name: COMPANY_NAME, stafford_logo: LOGO_PATH,
  };
}
const fill = (tpl, vals, html) => tpl.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (m, k) => (k in vals ? (html ? esc(vals[k]).replace(/\n/g, "<br>") : esc(vals[k])) : m));
function textBodyHTML(tpl, vals) {
  return fill(esc(tpl), vals, false).split(/\n\s*\n/).map((p) => "<p>" + p.replace(/\n/g, "<br>") + "</p>").join("");
}
function letterheadHTML(lh) {
  const lines = String(lh || "").split("\n");
  return `<div class="lh"><img src="${LOGO_PATH}" alt="${esc(lines[0] || "")}"><div class="lh-lines">${lines.slice(1).map(esc).join("<br>")}</div></div>`;
}
/* Build the stored HTML for one letter. mark, when set, prints in the corner of every page. */
export function buildLetterHTML({ kind, body, letterhead }, vals, mark) {
  const html = kind === "layout" ? fill(body, vals, true) : `<div class="sheet s-text">${letterheadHTML(letterhead)}${textBodyHTML(body, vals)}</div>`;
  return mark ? html.replace(/<div class="sheet/g, `<div data-mark="${esc(mark)}" class="sheet`) : html;
}
