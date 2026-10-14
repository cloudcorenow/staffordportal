import {
  FIELDS, CSV_HEADERS, fieldLabel, esc, parseDate, fmtMoney, fmtShortDate, fmtLongDate,
  validateAccount, normalizeAccount, csvRowsToAccounts, checkImportRows, csvCell, TOKEN_HELP, templateLabel, buildLetterHTML, mergeValues, UNVERIFIED_MARK,
} from "./shared.js";

/* ===== State: a local copy of what the server returned ===== */
const S = {
  me: null, today: "", loadedAt: 0,
  accounts: [], letters: [], ledgers: [], templates: [], letterhead: "",
  history: {}, html: {},
  view: "accounts", selectedId: null, search: "", filter: "all",
  tplId: null, letterTpl: null, batchTpl: null, letterDate: "", batchDate: "",
  importText: "", importRows: null, batchSel: new Set(), lastBatchIds: [], freshStamp: null,
  users: null, backups: null, chain: null, rev: 0, listLimit: 200, batchLimit: 200,
};
const app = document.getElementById("app");
const dlg = document.getElementById("dlg");
const dlg2 = document.getElementById("dlg2");
const canEdit = () => S.me && (S.me.role === "staff" || S.me.role === "admin");
const isAdmin = () => S.me && S.me.role === "admin";

/* ===== API ===== */
class ApiError extends Error { constructor(status, message, details) { super(message); this.status = status; this.details = details; } }
async function api(method, path, body, opts = {}) {
  const headers = { "X-Portal-Request": "1" };
  let payload = body;
  if (body !== undefined && !(body instanceof Blob)) { headers["Content-Type"] = "application/json"; payload = JSON.stringify(body); }
  if (body instanceof Blob) headers["Content-Type"] = body.type || "application/octet-stream";
  let res;
  try { res = await fetch("/api" + path, { method, headers, body: payload, credentials: "same-origin", ...opts }); }
  catch { throw new ApiError(0, "Couldn't reach the server. Check your connection and try again."); }
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) {
    if (res.status === 401) { showBlocked("Sign in again", (data && data.error) || "Your session has ended.", true); }
    throw new ApiError(res.status, (data && data.error) || `The server returned an error (${res.status}).`, data && data.details);
  }
  return data;
}
function fail(e) { toast(e && e.message ? e.message : "Something went wrong."); }

/* ===== Utilities ===== */
const plural = (n, w, ws) => n + " " + (n === 1 ? w : ws || w + "s");
const fmtStamp = (iso) => iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) : "";
const acct = (id) => S.accounts.find((a) => a.id === id);
// Lookups rebuilt only when accounts or letters change, so thousands of accounts stay fast.
let IX = null, ixKey = "";
function ix() {
  const key = S.accounts.length + ":" + S.letters.length + ":" + S.rev;
  if (IX && key === ixKey) return IX;
  const counts = new Map(), letters = new Map(), errs = new Map();
  for (const a of S.accounts) { const n = a.acctNo.toLowerCase(); counts.set(n, (counts.get(n) || 0) + 1); }
  for (const l of S.letters) (letters.get(l.accountId) || letters.set(l.accountId, []).get(l.accountId)).push(l);
  for (const a of S.accounts) errs.set(a.id, validateAccount(a, { isDuplicate: (n) => (counts.get(n.toLowerCase()) || 0) > 1, today: S.today }));
  IX = { letters, errs }; ixKey = key; return IX;
}
const touch = () => { S.rev++; }; // call after changing an account or letter in place
const lettersOf = (id) => ix().letters.get(id) || [];
const tplById = (id) => S.templates.find((t) => t.id === id) || S.templates[0];
const isoParts = (iso) => { const [y, m, d] = iso.split("-").map(Number); return { y, m, d }; };
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
function errsOf(a) { return ix().errs.get(a.id) || {}; }
const isComplete = (a) => !Object.keys(errsOf(a)).length;
const errorList = (e) => `<ul class="errlist">${Object.entries(e).map(([k, v]) => `<li>${esc(fieldLabel(k))}: ${esc(v)}</li>`).join("")}</ul>`;
const tplOptions = (sel) => S.templates.map((t) => `<option value="${t.id}" ${t.id === sel ? "selected" : ""}>${esc(templateLabel(t))}${t.placeholder ? " (placeholder)" : !t.verified ? " (not verified)" : ""}</option>`).join("");
function toast(msg) {
  document.querySelectorAll(".toast").forEach((t) => t.remove());
  const t = document.createElement("div"); t.className = "toast"; t.setAttribute("role", "status"); t.textContent = msg;
  document.body.appendChild(t); setTimeout(() => t.remove(), 3500);
}
function downloadBlob(name, blob) {
  const u = URL.createObjectURL(blob); const a = document.createElement("a");
  a.href = u; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 4000);
}
const ICON = {
  search: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5"/><path d="M13 13l4 4" stroke-linecap="round"/></svg>',
  print: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M6 8V3h8v5M6 14H4a1 1 0 01-1-1V9a1 1 0 011-1h12a1 1 0 011 1v4a1 1 0 01-1 1h-2"/><path d="M6 12h8v5H6z"/></svg>',
  down: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M10 3v10m0 0l-4-4m4 4l4-4M4 16h12" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  x: '<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15" stroke-linecap="round"/></svg>',
  plus: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M10 4v12M4 10h12" stroke-linecap="round"/></svg>',
};

/* ===== Loading ===== */
function showBlocked(title, message, reload) {
  app.innerHTML = `<div class="boot"><div class="card"><img src="/logo.png" alt="Stafford Group and Associates"><h1>${esc(title)}</h1><p>${esc(message)}</p>
    ${reload ? '<p style="margin-top:16px"><button class="btn primary" data-act="reload">Reload</button></p>' : ""}</div></div>`;
}
async function load() {
  const d = await api("GET", "/bootstrap");
  Object.assign(S, { me: d.me, today: d.today, accounts: d.accounts, letters: d.letters, ledgers: d.ledgers, templates: d.templates, letterhead: d.letterhead, loadedAt: Date.now() });
  if (!S.letterDate) S.letterDate = S.today;
  if (!S.batchDate) S.batchDate = S.today;
  S.history = {}; touch();
}
async function start() {
  try { await load(); }
  catch (e) { if (e.status !== 401) showBlocked(e.status === 403 ? "No access yet" : "Couldn't load the portal", e.message, e.status !== 403); return; }
  app.innerHTML = `<div class="shell">
    <aside class="side">
      <div class="brand"><img src="/logo.png" alt="Stafford Group and Associates"><span>Account and Letter Portal</span></div>
      <nav class="nav" id="nav" aria-label="Sections"></nav>
      <div class="side-user"><b>${esc(S.me.email)}</b><span class="role-pill">${esc(S.me.role)}</span><br><a href="/cdn-cgi/access/logout">Sign out</a></div>
    </aside>
    <main id="main"></main>
  </div>`;
  render();
}
// Pick up colleagues' changes when someone returns to the tab after a while.
document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState !== "visible" || !S.me || Date.now() - S.loadedAt < 60_000 || dlg.open || dlg2.open || tplDirty()) return;
  try { await load(); render(); } catch { /* keep current view */ }
});

/* ===== Rendering ===== */
const main = () => document.getElementById("main");
function render() {
  if (S.view === "account" && !acct(S.selectedId)) S.view = "accounts";
  if ((S.view === "admin" && !isAdmin()) || ((S.view === "import" || S.view === "batch") && !canEdit())) S.view = "accounts";
  for (const k of ["tplId", "letterTpl", "batchTpl"]) if (!S.templates.some((t) => t.id === S[k])) S[k] = S.templates[0] && S.templates[0].id;
  renderNav();
  ({ accounts: viewAccounts, account: viewAccount, import: viewImport, batch: viewBatch, template: viewTemplate, admin: viewAdmin })[S.view]();
}
function go(v) { S.view = v; render(); window.scrollTo(0, 0); }
function renderNav() {
  const u = S.letters.filter((l) => !l.sentDate).length;
  const items = [["accounts", "Accounts", S.accounts.length, ""]];
  if (canEdit()) items.push(["batch", "Batch letters", u || "", u ? "alert" : ""], ["import", "Import CSV", "", ""]);
  items.push(["template", "Letter templates", S.templates.length, ""]);
  if (isAdmin()) items.push(["admin", "Users and backups", "", ""]);
  document.getElementById("nav").innerHTML = items.map(([v, l, c, cls]) =>
    `<button data-act="nav" data-v="${v}" aria-current="${S.view === v || (v === "accounts" && S.view === "account")}"><span>${l}</span><span class="count ${cls}" ${cls ? `title="${plural(u, "letter")} not yet recorded as sent"` : ""}>${c}</span></button>`).join("");
}

/* ----- Accounts ----- */
function letterStatusCell(a) {
  const ls = lettersOf(a.id);
  if (!ls.length) return '<span class="muted">No letters yet</span>';
  const last = ls[ls.length - 1]; const waiting = ls.filter((l) => !l.sentDate).length;
  return `${esc(last.templateShort)}<span class="cellsub ${last.sentDate ? "st-sent" : "st-wait"}">${last.sentDate ? "Sent " + fmtShortDate(last.sentDate) : "Not recorded as sent"}</span>${waiting && last.sentDate ? `<span class="cellsub st-wait">${plural(waiting, "earlier letter")} not recorded</span>` : ""}`;
}
const FILTERS = {
  all: { label: "All", test: () => true },
  needs: { label: "Needs info", test: (a) => !isComplete(a) },
  none: { label: "No letters", test: (a) => !lettersOf(a.id).length },
  unsent: { label: "Awaiting sent date", test: (a) => lettersOf(a.id).some((l) => !l.sentDate) },
};
function viewAccounts() {
  const q = S.search.trim().toLowerCase();
  const match = (a) => !q || [a.name, a.acctNo, a.credAcct, a.paymentId].some((x) => String(x).toLowerCase().includes(q));
  const all = S.accounts.filter((a) => match(a) && FILTERS[S.filter].test(a)).sort((a, b) => a.name.localeCompare(b.name));
  const list = all.slice(0, S.listLimit);
  main().innerHTML = `
  <div class="pagehead"><div><h1>Accounts</h1><p>Find an account by debtor name or account number to ${canEdit() ? "edit it, generate letters, attach ledgers and record sent dates" : "see its letters, ledgers and history"}.</p></div>
  ${canEdit() ? `<div class="row"><button class="btn" data-act="nav" data-v="import">Import CSV</button><button class="btn primary" data-act="new-account">${ICON.plus}New account</button></div>` : ""}</div>
  <div class="toolbar">
    <label class="search"><span class="sr">Search accounts</span>${ICON.search}<input type="search" id="search" placeholder="Debtor name, Simplicity or creditor account number" value="${esc(S.search)}"></label>
    <div class="queue" role="group" aria-label="Filter accounts">${Object.entries(FILTERS).map(([k, f]) => `<button data-act="filter" data-v="${k}" aria-pressed="${S.filter === k}">${f.label}<span class="n">${S.accounts.filter(f.test).length}</span></button>`).join("")}</div>
  </div>
  <div class="tablewrap"><table class="rtable">
    <thead><tr><th>Simplicity acct #</th><th>Debtor</th><th>Original creditor</th><th class="num">Balance</th><th>Charge-off</th><th>Latest letter</th><th>Record</th></tr></thead>
    <tbody>${list.length ? list.map((a) => `<tr class="clickable" data-act="open" data-id="${a.id}" tabindex="0">
        <td class="acctno" data-label="Simplicity acct #">${esc(a.acctNo)}</td>
        <td data-label="Debtor">${esc(a.name)}<span class="cellsub">${esc([a.city, a.state].filter(Boolean).join(", "))}</span></td>
        <td data-label="Original creditor">${esc(a.creditor)}<span class="cellsub">${esc(a.credAcct)}</span></td>
        <td class="num" data-label="Balance">${esc(fmtMoney(a.balance))}</td>
        <td data-label="Charge-off" class="tab">${esc(fmtShortDate(a.chargeOff))}</td>
        <td data-label="Latest letter">${letterStatusCell(a)}</td>
        <td data-label="Record">${isComplete(a) ? '<span class="tag ok">Complete</span>' : '<span class="tag warn">Needs info</span>'}</td></tr>`).join("")
      : `<tr class="empty-row"><td colspan="7" class="empty">${S.accounts.length ? `<b>No accounts match.</b>${q ? "Try a different name or number, or " : ""}<button class="btn link" data-act="clear-filters">show all accounts</button>.` : `<b>No accounts yet.</b>${canEdit() ? "Create one or import a CSV to get started." : "Accounts appear here once staff add them."}`}</td></tr>`}</tbody>
  </table></div>
  ${all.length > list.length ? `<div class="row" style="margin-top:12px"><span class="muted" style="font-size:13.5px">Showing ${list.length.toLocaleString()} of ${all.length.toLocaleString()} accounts. Search to narrow the list.</span><button class="btn small" data-act="more-accounts">Show ${Math.min(200, all.length - list.length)} more</button></div>` : ""}`;
  const s = document.getElementById("search");
  s.addEventListener("input", () => { S.search = s.value; S.listLimit = 200; const pos = s.selectionStart; viewAccounts(); const n = document.getElementById("search"); n.focus(); n.setSelectionRange(pos, pos); });
}

/* ----- Account detail ----- */
function postmark(L) {
  if (!L.sentDate) return `<div class="postmark pending" aria-hidden="true"><span class="pm-day">Not sent</span></div>`;
  const { y, m, d } = isoParts(L.sentDate);
  return `<div class="postmark${S.freshStamp === L.id ? " fresh" : ""}" role="img" aria-label="Sent ${fmtLongDate(L.sentDate)}"><span class="pm-top">SENT</span><span class="pm-day">${MONTHS[m - 1]} ${d}</span><span class="pm-yr">${y}</span></div>`;
}
function historyHTML(id) {
  const h = S.history[id];
  if (!h) return '<p class="loading">Loading history</p>';
  if (!h.length) return '<p class="muted">No changes recorded.</p>';
  return `<div class="history-scroll"><ul class="timeline">${h.map((x) => `<li><time>${fmtStamp(x.at)}, ${esc(x.actor)}</time><b>${esc(x.action)}</b>${x.detail ? `<span class="d">${esc(x.detail)}</span>` : ""}</li>`).join("")}</ul></div>`;
}
async function loadHistory(id) {
  try { S.history[id] = (await api("GET", `/accounts/${id}/history`)).history; }
  catch (e) { S.history[id] = []; fail(e); }
  const el = document.getElementById("history"); if (el && S.selectedId === id) el.innerHTML = historyHTML(id);
}
function viewAccount() {
  const a = acct(S.selectedId);
  const errs = errsOf(a); const ok = !Object.keys(errs).length;
  const letters = lettersOf(a.id).sort((x, y) => (y.createdAt > x.createdAt ? 1 : -1));
  const ledgers = S.ledgers.filter((l) => l.accountId === a.id);
  const sent = letters.filter((l) => l.sentDate).length;
  main().innerHTML = `
  <div class="pagehead"><div><button class="btn link crumb" data-act="nav" data-v="accounts">Accounts</button>
    <h1>${esc(a.name || "Unnamed account")}</h1><p>Simplicity account <span class="acctno">${esc(a.acctNo)}</span></p></div>
    ${canEdit() ? '<div class="row"><button class="btn" data-act="edit-account">Edit account</button></div>' : ""}</div>
  <div class="facts-strip">
    <div><div class="k">Balance</div><div class="v">${esc(fmtMoney(a.balance))}</div></div>
    <div><div class="k">Original creditor</div><div class="v sm">${esc(a.creditor)}</div></div>
    <div><div class="k">Charge-off date</div><div class="v sm">${esc(fmtShortDate(a.chargeOff))}</div></div>
    <div><div class="k">Letters</div><div class="v sm">${letters.length ? `${letters.length} generated, ${sent} sent` : "None yet"}</div></div>
  </div>
  <div class="detail">
    <div>
      <section class="panel p-info"><h2>Account information</h2>
        ${ok ? "" : `<div class="notice warn"><b>Complete these fields before generating a letter.</b>${errorList(errs).replace('class="errlist"', "")}</div>`}
        <dl class="facts">
          <dt>Simplicity acct #</dt><dd>${esc(a.acctNo)}</dd>
          <dt>Debtor</dt><dd>${esc(a.name)}</dd>
          <dt>Mailing address</dt><dd>${esc(a.addr1)}${a.addr2 ? "<br>" + esc(a.addr2) : ""}<br>${esc(a.city)}${a.city ? ", " : ""}${esc(a.state)} ${esc(a.zip) || '<span class="st-wait">ZIP missing</span>'}</dd>
          <dt>Original creditor</dt><dd>${esc(a.creditor)}</dd>
          <dt>Creditor acct #</dt><dd>${esc(a.credAcct)}</dd>
          <dt>Balance</dt><dd>${esc(fmtMoney(a.balance))}</dd>
          <dt>Payment ID</dt><dd>${esc(a.paymentId)}</dd>
          <dt>Charge-off date</dt><dd>${esc(fmtShortDate(a.chargeOff))}</dd>
          <dt>Last changed</dt><dd>${fmtStamp(a.updatedAt)}<span class="cellsub">${esc(a.updatedBy || "")}</span></dd>
        </dl>
      </section>
      <section class="panel p-ledger"><h2>Ledger attachments <span class="sub">${ledgers.length || ""}</span></h2>
        <p class="panel-note">Kept as files only. The portal doesn't read ledger transactions or change the balance.</p>
        ${canEdit() ? `<div class="drop" id="drop"><label class="btn"><input type="file" id="ledger-in" multiple hidden>Attach ledger file</label><span class="muted" style="font-size:13px">or drop files here</span></div>` : ""}
        ${ledgers.length ? `<ul class="files">${ledgers.map((l) => { const ext = (l.name.split(".").pop() || "").slice(0, 4); return `<li><span class="fi">${esc(ext)}</span><span class="fn">${esc(l.name)}<span class="cellsub">${(l.size / 1024).toFixed(1)} KB, attached ${fmtStamp(l.at)} by ${esc(l.by)}</span></span><a class="btn small" href="/api/ledgers/${l.id}/download" download aria-label="Download ${esc(l.name)}">${ICON.down}Download</a></li>`; }).join("")}</ul>` : (canEdit() ? "" : '<p class="muted">No ledgers attached.</p>')}
      </section>
    </div>
    <div>
      <section class="panel p-letters"><h2>Letters <span class="sub">${letters.length === 1 ? "1 copy kept" : letters.length ? letters.length + " copies kept" : ""}</span></h2>
        ${canEdit() ? `<div class="genbar">
          <label class="fld">Letter<select id="ltpl">${tplOptions(S.letterTpl)}</select></label>
          <label class="fld">Date printed on letter<input type="date" id="ldate" value="${esc(S.letterDate)}"></label>
          <button class="btn primary" data-act="gen-letter" ${ok ? "" : "disabled title='Complete the account information first'"}>Generate letter</button>
        </div>` : ""}
        ${letters.length ? letters.map(letterItem).join("") : '<p class="empty" style="padding:24px 10px 6px">Generated letters appear here. Each one is kept as its own copy, so earlier letters are never replaced.</p>'}
      </section>
      <section class="panel p-history"><h2>Change history</h2><div id="history">${historyHTML(a.id)}</div></section>
    </div>
  </div>`;
  S.freshStamp = null;
  if (!S.history[a.id]) loadHistory(a.id);
  if (!canEdit()) return;
  document.getElementById("ldate").addEventListener("change", (e) => (S.letterDate = e.target.value));
  document.getElementById("ltpl").addEventListener("change", (e) => (S.letterTpl = e.target.value));
  document.getElementById("ledger-in").addEventListener("change", (e) => uploadLedgers(a.id, e.target.files));
  const drop = document.getElementById("drop");
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); uploadLedgers(a.id, e.dataTransfer.files); });
}
function letterItem(L) {
  return `<article class="letter-item">
    <div>
      <h3>${esc(L.templateName)}</h3>
      <p class="meta">Generated ${fmtStamp(L.createdAt)} by ${esc(L.createdBy)}${L.batchId ? " in a batch" : ""}</p>
      <dl class="dates">
        <div><dt>Letter date</dt><dd>${fmtShortDate(L.letterDate)}</dd></div>
        <div><dt>Actual sent date</dt><dd>${L.sentDate ? fmtShortDate(L.sentDate) : '<span class="st-wait">Not recorded</span>'}</dd></div>
        ${L.sentDate ? `<div style="grid-column:1/-1"><dt>Sent date entered</dt><dd>${fmtStamp(L.sentEnteredAt)}<span class="cellsub">${esc(L.sentEnteredBy || "")}</span></dd></div>` : ""}
      </dl>
      ${L.corrections && L.corrections.length ? `<ul class="corrections">${L.corrections.map((c) => `<li>${fmtStamp(c.at)}, ${esc(c.by)}: changed from ${fmtShortDate(c.prev)} to ${fmtShortDate(c.next)}. Reason: ${esc(c.reason)}</li>`).join("")}</ul>` : ""}
      <div class="row">
        <button class="btn small" data-act="preview" data-id="${L.id}">Preview</button>
        <button class="btn small" data-act="print-one" data-id="${L.id}">${ICON.print}Print</button>
        ${canEdit() ? `<button class="btn small ${L.sentDate ? "" : "primary"}" data-act="sent" data-id="${L.id}">${L.sentDate ? "Correct sent date" : "Record sent date"}</button>` : ""}
      </div>
    </div>
    ${postmark(L)}
  </article>`;
}
async function uploadLedgers(accountId, files) {
  files = [...files]; if (!files.length) return;
  let n = 0;
  for (const f of files) {
    toast(`Uploading ${f.name}`);
    try {
      const l = await api("POST", `/accounts/${accountId}/ledgers?filename=${encodeURIComponent(f.name)}`, f);
      S.ledgers.push(l); n++;
    } catch (e) { fail(e); }
  }
  if (n) { delete S.history[accountId]; toast(n === 1 ? "Ledger attached" : n + " ledgers attached"); render(); }
}

/* ----- Import ----- */
function viewImport() {
  const r = S.importRows;
  const errCount = r && r.rows ? r.rows.filter((x) => Object.keys(x.errs).length).length : 0;
  main().innerHTML = `
  <div class="pagehead"><div><h1>Import accounts</h1><p>Bring in several accounts at once from a CSV exported from Excel or another system. Existing accounts are never overwritten.</p></div>
  <button class="btn" data-act="csv-template">${ICON.down}Download CSV template</button></div>
  <ol class="steps">
    <li><b>Fill in the template</b>One row per account, using the column names in the template. Dates as YYYY-MM-DD or MM/DD/YYYY.</li>
    <li><b>Upload or paste</b>Choose the CSV file or paste its contents into the box below.</li>
    <li><b>Review, then import</b>Every row must pass the checks. Fix problems in the CSV and review again.</li>
  </ol>
  <section class="panel">
    <div class="row" style="margin-bottom:12px"><label class="btn"><input type="file" id="csv-in" accept=".csv,text/csv,text/plain" hidden>Upload CSV file</label><span class="muted" style="font-size:13.5px">or paste below</span></div>
    <label class="sr" for="csv-text">CSV data</label>
    <textarea class="mono" id="csv-text" rows="8" spellcheck="false" placeholder="${esc(CSV_HEADERS.join(","))}">${esc(S.importText)}</textarea>
    <div class="row" style="margin-top:12px"><button class="btn primary" data-act="csv-check">Review accounts</button>${S.importText ? '<button class="btn" data-act="csv-clear">Clear</button>' : ""}</div>
  </section>
  ${r ? (r.fatal ? `<div class="notice err">${esc(r.fatal)}</div>` : `
  <section class="panel"><h2>Review <span class="sub">${r.rows.length.toLocaleString()} ${r.rows.length === 1 ? "row" : "rows"}</span>${errCount ? `<span class="tag err">${errCount} with problems</span>` : '<span class="tag ok">All rows pass</span>'}</h2>
    ${errCount ? `<p class="panel-note" style="color:var(--err)">Fix the highlighted rows in the CSV above, then select Review accounts again. Nothing is imported until every row passes.</p>` : ""}
    <div class="tablewrap"><table class="rtable"><thead><tr><th>Row</th><th>Simplicity acct #</th><th>Debtor and address</th><th>Creditor</th><th class="num">Balance</th><th>Charge-off</th><th>Payment ID</th><th>Check</th></tr></thead>
    <tbody>${shownImportRows(r.rows).map((x) => { const e = x.errs, bad = Object.keys(e).length, a = x.raw; return `<tr class="${bad ? "row-bad" : ""}">
      <td data-label="Row" class="tab">${x.line}</td><td class="acctno" data-label="Simplicity acct #">${esc(a.acctNo) || "<span class='muted'>blank</span>"}</td>
      <td data-label="Debtor and address" class="wide">${esc(a.name)}<span class="cellsub">${esc([a.addr1, a.addr2].filter(Boolean).join(", "))}${a.addr1 ? ", " : ""}${esc(a.city)} ${esc(a.state)} ${esc(a.zip)}</span></td>
      <td data-label="Creditor">${esc(a.creditor)}<span class="cellsub">${esc(a.credAcct)}</span></td><td class="num" data-label="Balance">${esc(a.balance)}</td><td data-label="Charge-off">${esc(a.chargeOff)}</td><td data-label="Payment ID">${esc(a.paymentId)}</td>
      <td data-label="Check" class="wide">${bad ? `<span class="tag err">${plural(bad, "problem")}</span>${errorList(e)}` : '<span class="tag ok">Ready</span>'}</td></tr>`; }).join("")}</tbody></table></div>
    ${shownImportRows(r.rows).length < r.rows.length ? `<p class="muted" style="font-size:12.5px;margin-top:8px">Showing ${errCount ? "every row with a problem and " : ""}the first ${IMPORT_PREVIEW} ready rows. All ${r.rows.length.toLocaleString()} rows were checked.</p>` : ""}
    <div class="row" style="margin-top:14px"><button class="btn primary" data-act="csv-import" ${errCount ? "disabled" : ""}>Import ${plural(r.rows.length, "account")}</button></div>
  </section>`) : ""}`;
  const ta = document.getElementById("csv-text");
  ta.addEventListener("input", () => { S.importText = ta.value; });
  document.getElementById("csv-in").addEventListener("change", (e) => {
    const f = e.target.files[0]; if (!f) return;
    f.text().then((t) => { S.importText = t; S.importRows = reviewImport(t); viewImport(); toast("Loaded " + f.name); });
  });
}
// Large files: list every row with a problem, but only the first few ready rows, so the page stays fast.
const IMPORT_PREVIEW = 100;
function shownImportRows(rows) {
  if (rows.length <= IMPORT_PREVIEW * 2) return rows;
  let ready = 0;
  return rows.filter((x) => Object.keys(x.errs).length || ready++ < IMPORT_PREVIEW);
}
function reviewImport(text) {
  const parsed = csvRowsToAccounts(text);
  if (parsed.fatal) return parsed;
  const existing = new Set(S.accounts.map((a) => a.acctNo.toLowerCase()));
  return { rows: checkImportRows(parsed.rows, { existing: (n) => existing.has(n.toLowerCase()), today: S.today }) };
}

/* ----- Batch letters ----- */
const batchLetters = () => S.lastBatchIds.map((i) => S.letters.find((l) => l.id === i)).filter(Boolean);
function viewBatch() {
  const sorted = [...S.accounts].sort((a, b) => a.name.localeCompare(b.name));
  const eligible = sorted.filter(isComplete);
  [...S.batchSel].forEach((id) => { if (!eligible.some((a) => a.id === id)) S.batchSel.delete(id); });
  const allOn = eligible.length && eligible.every((a) => S.batchSel.has(a.id));
  const last = batchLetters(); const lastUnsent = last.filter((l) => !l.sentDate).length;
  const bt = tplById(S.batchTpl);
  const unsentAll = S.letters.filter((l) => !l.sentDate);
  main().innerHTML = `
  <div class="pagehead"><div><h1>Batch letters</h1><p>Generate the same letter for several accounts at once. Each letter is filed under its own account. Generating or printing doesn't mark anything as sent.</p></div></div>
  ${last.length ? `<section class="panel done-panel"><h2>Batch ready <span class="sub">${esc(last[0].templateName)}, ${plural(last.length, "letter")} dated ${fmtShortDate(last[0].letterDate)}</span></h2>
    ${last.length > 300 ? `<div class="notice warn">This batch has ${last.length.toLocaleString()} letters. Turning it into one PDF can take several minutes and a lot of memory; printing directly is faster.</div>` : ""}
    <p class="panel-note">Each letter starts on a new page. ${lastUnsent ? `After mailing, record the sent date for the ${plural(lastUnsent, "letter")} in this batch.` : "All letters in this batch have a sent date recorded."}</p>
    <div class="row"><button class="btn primary" data-act="batch-print">${ICON.print}Print batch</button><button class="btn" data-act="batch-download">${ICON.down}Download PDF</button>
    ${lastUnsent ? `<button class="btn" data-act="batch-sent">Record sent date for batch</button>` : ""}<span class="spacer"></span><button class="btn link" data-act="batch-dismiss">Dismiss</button></div></section>` : ""}
  ${!last.length && unsentAll.length ? `<div class="notice info">${plural(unsentAll.length, "letter")} across all accounts ${unsentAll.length === 1 ? "has" : "have"} no sent date yet. <button class="btn link" data-act="show-unsent">See accounts awaiting a sent date</button></div>` : ""}
  <section class="panel">
    <div class="row end">
      <label class="fld" style="flex:1.3;min-width:220px">Letter<select id="btpl">${tplOptions(S.batchTpl)}</select></label>
      <label class="fld" style="flex:1;min-width:170px">Date printed on letters<input type="date" id="bdate" value="${esc(S.batchDate)}"></label>
    </div>
    ${bt && (bt.placeholder || !bt.verified) ? `<div class="notice warn" style="margin:12px 0 0">${esc(templateLabel(bt))} ${bt.placeholder ? "still uses placeholder wording" : "hasn't been verified against the approved Word original"}. Its letters print marked "${esc(UNVERIFIED_MARK)}".</div>` : ""}
  </section>
  <div class="tablewrap"><table class="rtable">
    <thead><tr><th class="check"><input type="checkbox" id="selall" aria-label="Select all eligible accounts" ${allOn ? "checked" : ""} ${eligible.length ? "" : "disabled"}></th><th>Simplicity acct #</th><th>Debtor</th><th class="num">Balance</th><th>Letters so far</th><th>Eligibility</th></tr></thead>
    <tbody>${sorted.length ? sorted.slice(0, S.batchLimit).map((a) => { const e = errsOf(a), ok = !Object.keys(e).length, ls = lettersOf(a.id), has = ls.some((l) => l.templateId === S.batchTpl);
      return `<tr><td class="check"><input type="checkbox" data-act="bsel" data-id="${a.id}" aria-label="Select ${esc(a.name)}" ${S.batchSel.has(a.id) ? "checked" : ""} ${ok ? "" : "disabled"}></td>
      <td class="acctno" data-label="Simplicity acct #">${esc(a.acctNo)}</td><td data-label="Debtor">${esc(a.name)}</td><td class="num" data-label="Balance">${esc(fmtMoney(a.balance))}</td>
      <td data-label="Letters so far">${ls.length ? [...new Set(ls.map((l) => l.templateShort))].map(esc).join(", ") : '<span class="muted">None</span>'}${has ? `<span class="cellsub st-wait">Already has ${esc(bt.name)}</span>` : ""}</td>
      <td data-label="Eligibility" class="wide">${ok ? '<span class="tag ok">Eligible</span>' : `<span class="tag warn">Excluded</span> <button class="btn link small" data-act="open" data-id="${a.id}">Fix account</button>${errorList(e)}`}</td></tr>`; }).join("")
      : `<tr class="empty-row"><td colspan="6" class="empty"><b>No accounts yet.</b>Add or import accounts first.</td></tr>`}</tbody></table></div>
  ${sorted.length > S.batchLimit ? `<div class="row" style="margin-top:12px"><span class="muted" style="font-size:13.5px">Showing ${S.batchLimit.toLocaleString()} of ${sorted.length.toLocaleString()} accounts. The header checkbox selects all ${eligible.length.toLocaleString()} eligible accounts, including ones not shown.</span><button class="btn small" data-act="more-batch">Show ${Math.min(200, sorted.length - S.batchLimit)} more</button></div>` : ""}
  <div class="actionbar" role="region" aria-label="Batch selection" id="actionbar"></div>`;
  updateActionBar(eligible.length);
  document.getElementById("bdate").addEventListener("change", (e) => (S.batchDate = e.target.value));
  document.getElementById("btpl").addEventListener("change", (e) => { S.batchTpl = e.target.value; viewBatch(); });
  const sa = document.getElementById("selall");
  sa.addEventListener("change", () => {
    if (sa.checked) eligible.forEach((a) => S.batchSel.add(a.id)); else S.batchSel.clear();
    document.querySelectorAll('input[data-act="bsel"]:not(:disabled)').forEach((c) => (c.checked = sa.checked));
    updateActionBar(eligible.length);
  });
}
// Ticking boxes updates only the bar, not the whole table, so large account lists stay responsive.
function updateActionBar(eligibleCount) {
  const bar = document.getElementById("actionbar"); if (!bar) return;
  const n = S.batchSel.size;
  bar.innerHTML = `<span><b>${n.toLocaleString()}</b> of ${eligibleCount.toLocaleString()} eligible ${eligibleCount === 1 ? "account" : "accounts"} selected</span><span class="spacer"></span>
    <button class="btn primary" data-act="batch-gen" ${n ? "" : "disabled"}>Generate ${n ? n.toLocaleString() + (n === 1 ? " letter" : " letters") : "letters"}</button>`;
  const sa = document.getElementById("selall"); if (sa) sa.checked = eligibleCount > 0 && n === eligibleCount;
}

/* ----- Templates ----- */
function tplDirty() {
  if (S.view !== "template" || !isAdmin()) return false;
  const g = (id) => { const el = document.getElementById(id); return el ? el.value : null; };
  if (g("t-name") == null) return false;
  const t = tplById(S.tplId);
  return g("t-name") !== t.name || g("t-desc") !== t.description || g("t-body") !== t.body || g("t-lh") !== S.letterhead;
}
function viewTemplate() {
  const t = tplById(S.tplId); const used = S.letters.filter((l) => l.templateId === t.id).length; const layout = t.kind === "layout"; const admin = isAdmin();
  const ro = admin ? "" : "readonly";
  main().innerHTML = `
  <div class="pagehead"><div><h1>Letter templates</h1><p>Each template is one letter in the series. ${admin ? "Edits apply to letters generated afterwards; letters already generated keep their original text." : "Only an admin can change templates."}</p></div>
  ${admin ? `<button class="btn" data-act="tpl-add">${ICON.plus}Add template</button>` : ""}</div>
  <div class="tpl-tabs" role="tablist" aria-label="Templates">${S.templates.map((x) => `<button role="tab" aria-selected="${x.id === t.id}" data-act="tpl-select" data-id="${x.id}">${esc(templateLabel(x))}${x.placeholder ? '<span class="ph">placeholder</span>' : !x.verified ? '<span class="ph">not verified</span>' : ""}</button>`).join("")}</div>
  <section class="panel tpl-panel">
    <h2>${esc(templateLabel(t))} <span class="sub">${used ? plural(used, "letter") + " generated from this template" : "Not used yet"}</span></h2>
    <div class="verify-row ${t.verified ? "yes" : "no"}">
      <span>${t.verified ? `<b>Verified</b> against the approved Word original by ${esc(t.verifiedBy || "")}, ${fmtStamp(t.verifiedAt)}.` : `<b>Not verified.</b> Letters from this template print marked "${esc(UNVERIFIED_MARK)}" until an admin confirms it matches the approved Word original.`}</span>
      <span class="spacer"></span>
      ${admin ? `<button class="btn small" data-act="tpl-verify" data-v="${t.verified ? "0" : "1"}">${t.verified ? "Remove verification" : "Mark as verified"}</button>` : ""}
    </div>
    ${layout ? `<div class="notice info">Loaded from the Stafford Word template. It keeps the Word layout: a cover page for the envelope window, the notice with its tear-off response form, and the disclosures page. It's written in HTML, so change wording carefully and leave the tags in place.</div>`
      : t.placeholder ? `<div class="notice warn">This template still uses placeholder wording. Paste the approved Stafford text here, keeping the merge fields.</div>` : ""}
    <div class="grid2" style="margin-bottom:14px"><label class="fld">Template name<input type="text" id="t-name" value="${esc(t.name)}" ${ro}></label><label class="fld"><span>Description <span class="hint">optional, shown next to the name</span></span><input type="text" id="t-desc" value="${esc(t.description)}" ${ro}></label></div>
    <p class="fieldset-label">Merge fields ${layout ? "" : "<span class='muted' style='font-weight:400'>(blank lines separate paragraphs)</span>"}</p>
    <div class="tokens">${TOKEN_HELP.map((k) => `<code>{{${k}}}</code>`).join("")}</div>
    <label class="sr" for="t-body">Letter body</label>
    <textarea id="t-body" rows="${layout ? 26 : 22}" class="${layout ? "mono" : ""}" spellcheck="${layout ? "false" : "true"}" ${ro}>${esc(t.body)}</textarea>
    <div ${layout ? "hidden" : ""}>
      <p class="fieldset-label">Letterhead <span class="muted" style="font-weight:400">(shared by text templates; the logo prints above these lines)</span></p>
      <textarea id="t-lh" rows="5" ${ro}>${esc(S.letterhead)}</textarea>
    </div>
    <div class="row" style="margin-top:14px">${admin ? '<button class="btn primary" data-act="tpl-save">Save template</button>' : ""}<button class="btn" data-act="tpl-preview">Preview with a sample account</button><span class="spacer"></span>${admin ? `<button class="btn danger" data-act="tpl-delete" ${S.templates.length < 2 ? "disabled" : ""}>Remove template</button>` : ""}</div>
    ${t.updatedBy ? `<p class="muted" style="font-size:12.5px;margin-top:12px">Last changed ${fmtStamp(t.updatedAt)} by ${esc(t.updatedBy)}</p>` : ""}
  </section>`;
}

/* ----- Admin: users and backups ----- */
let adminSeq = 0; // bumps on every admin change, so a slower initial load can't overwrite newer data
async function loadAdmin() {
  const seq = ++adminSeq;
  try {
    const [u, b] = await Promise.all([api("GET", "/users"), api("GET", "/admin/backups")]);
    if (seq !== adminSeq) return;
    S.users = u.users; S.backups = b;
    if (S.view === "admin") viewAdmin();
  } catch (e) { fail(e); }
}
function viewAdmin() {
  const users = S.users, b = S.backups;
  // Keep anything typed into the add-person form when the screen refreshes (for example when the list finishes loading).
  const oldForm = document.getElementById("user-form");
  const keep = oldForm ? { email: oldForm.elements.email.value, role: oldForm.elements.role.value, focused: oldForm.contains(document.activeElement) ? document.activeElement.name : null } : null;
  main().innerHTML = `
  <div class="pagehead"><div><h1>Users and backups</h1><p>People sign in through Cloudflare Access. Add them here to give them a role in the portal.</p></div></div>
  <section class="panel"><h2>Users</h2>
    <p class="panel-note">Admins manage templates, users and backups. Staff work with accounts, letters and ledgers. Viewers can look but not change anything.</p>
    ${users ? `<div class="tablewrap"><table class="rtable"><thead><tr><th>Email</th><th>Role</th><th>Status</th><th>Last active</th><th></th></tr></thead><tbody>
      ${users.map((u) => `<tr><td data-label="Email" class="wide">${esc(u.email)}${u.email === S.me.email ? ' <span class="muted">(you)</span>' : ""}<span class="cellsub">Added ${fmtStamp(u.created_at)} by ${esc(u.created_by)}</span></td>
        <td data-label="Role"><select data-act="user-role" data-email="${esc(u.email)}" aria-label="Role for ${esc(u.email)}" ${u.email === S.me.email ? "disabled" : ""}>${["admin", "staff", "viewer"].map((r) => `<option value="${r}" ${u.role === r ? "selected" : ""}>${r[0].toUpperCase() + r.slice(1)}</option>`).join("")}</select></td>
        <td data-label="Status">${u.active ? '<span class="tag ok">Active</span>' : '<span class="tag plain">Deactivated</span>'}</td>
        <td data-label="Last active" class="tab">${u.last_seen_at ? fmtStamp(u.last_seen_at) : '<span class="muted">Never</span>'}</td>
        <td>${u.email === S.me.email ? "" : `<button class="btn small" data-act="user-active" data-email="${esc(u.email)}" data-v="${u.active ? "0" : "1"}">${u.active ? "Deactivate" : "Reactivate"}</button>`}</td></tr>`).join("")}
    </tbody></table></div>` : '<p class="loading">Loading users</p>'}
    <form class="users-add" id="user-form" novalidate>
      <label class="fld">Add a person by email<input type="text" name="email" placeholder="name@staffordga.com" autocomplete="off"></label>
      <label class="fld">Role<select name="role"><option value="staff">Staff</option><option value="viewer">Viewer</option><option value="admin">Admin</option></select></label>
      <button class="btn primary" data-act="user-add">Add person</button>
    </form>
    <p class="muted" style="font-size:12.5px;margin-top:10px">They also need to be allowed by the Cloudflare Access policy for this site.</p>
  </section>
  <section class="panel"><h2>Change history check</h2>
    <p class="panel-note">Each entry in the change history is linked to the one before it. This check recomputes the whole chain to confirm nothing was edited or removed outside the portal.</p>
    ${S.chain ? (S.chain.ok ? `<div class="notice info">All ${S.chain.rows.toLocaleString()} entries check out.</div>` : `<div class="notice err">Entry ${S.chain.brokenAt} failed the check: ${esc(S.chain.reason)} Contact your IT administrator.</div>`) : ""}
    <button class="btn" data-act="verify-chain">Check change history</button>
  </section>
  <section class="panel"><h2>Backups</h2>
    <p class="panel-note">A full copy of the database is saved to R2 every night and kept for the configured number of days. Cloudflare D1 also keeps 30 days of point-in-time history for restores.</p>
    ${b ? (b.backups.length ? `<div class="tablewrap"><table class="rtable"><thead><tr><th>Created</th><th>Started by</th><th class="num">Accounts</th><th class="num">Letters</th><th>History check</th></tr></thead><tbody>
      ${b.backups.map((x) => { const m = x.manifest || {}; const c = m.counts || {}; return `<tr><td data-label="Created" class="tab">${fmtStamp(m.createdAt)}</td><td data-label="Started by">${esc(m.trigger || "")}</td><td class="num" data-label="Accounts">${c.accounts ?? ""}</td><td class="num" data-label="Letters">${c.letters ?? ""}</td><td data-label="History check">${m.auditChain && m.auditChain.ok ? '<span class="tag ok">Passed</span>' : '<span class="tag err">Failed</span>'}</td></tr>`; }).join("")}
      </tbody></table></div><p class="muted" style="font-size:12.5px;margin-top:8px">${plural(b.total, "backup")} stored. Showing the most recent ${Math.min(20, b.total)}.</p>` : '<p class="muted">No backups yet. The first one runs tonight, or start one now.</p>') : '<p class="loading">Loading backups</p>'}
    <div class="row" style="margin-top:12px"><button class="btn" data-act="backup-now">Back up now</button></div>
  </section>`;
  if (keep) {
    const f = document.getElementById("user-form");
    f.elements.email.value = keep.email; f.elements.role.value = keep.role;
    if (keep.focused && f.elements[keep.focused]) f.elements[keep.focused].focus();
  }
  if (!users || !b) loadAdmin();
}

/* ===== Letters: fetching, printing, PDF ===== */
async function ensureHtml(ids) {
  const need = ids.filter((id) => !S.html[id]);
  for (let i = 0; i < need.length; i += 100) {
    const r = await api("POST", "/letters/html", { ids: need.slice(i, i + 100) });
    for (const l of r.letters) S.html[l.id] = l.html;
  }
  return ids.map((id) => S.html[id]).filter(Boolean);
}
const letterSet = (html) => `<div class="letter-set">${html}</div>`;
async function printLetters(ids) {
  try {
    const html = await ensureHtml(ids);
    document.getElementById("print-area").innerHTML = html.map(letterSet).join("");
    [dlg, dlg2].forEach((d) => d.open && d.close());
    await waitForImages(document.getElementById("print-area"));
    window.print();
  } catch (e) { fail(e); }
}
function waitForImages(root) {
  return Promise.all([...root.querySelectorAll("img")].map((img) => img.complete ? null : new Promise((r) => { img.onload = img.onerror = r; })));
}
async function buildPDF(htmlList, onPage) {
  if (!window.html2canvas || !window.jspdf || !window.jspdf.jsPDF) throw new Error("The PDF tools are still loading. Try again in a moment.");
  const host = document.createElement("div"); host.className = "pdf-host"; host.setAttribute("aria-hidden", "true");
  host.innerHTML = htmlList.map(letterSet).join(""); document.body.appendChild(host);
  try {
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    await waitForImages(host);
    const pdf = new window.jspdf.jsPDF({ unit: "in", format: "letter", orientation: "portrait", compress: true });
    const sheets = [...host.querySelectorAll(".sheet")]; let first = true;
    for (let i = 0; i < sheets.length; i++) {
      onPage && onPage(i + 1, sheets.length);
      const c = await window.html2canvas(sheets[i], { scale: 2, backgroundColor: "#ffffff", logging: false });
      const pageH = Math.round((c.width * 11) / 8.5);
      for (let y = 0; y < c.height - 4; y += pageH) {
        const h = Math.min(pageH, c.height - y);
        const part = document.createElement("canvas"); part.width = c.width; part.height = pageH;
        const ctx = part.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, part.width, part.height); ctx.drawImage(c, 0, y, c.width, h, 0, 0, c.width, h);
        if (!first) pdf.addPage("letter", "portrait"); first = false;
        pdf.addImage(part.toDataURL("image/jpeg", 0.92), "JPEG", 0, 0, 8.5, 11, undefined, "FAST");
      }
    }
    return pdf.output("blob");
  } finally { host.remove(); }
}
async function downloadPDF(ids, filename, btn) {
  const label = btn ? btn.innerHTML : "";
  if (btn) { btn.disabled = true; btn.classList.add("busy"); btn.textContent = "Preparing letters"; }
  try {
    const html = await ensureHtml(ids);
    const blob = await buildPDF(html, (n, t) => { if (btn) btn.textContent = t > 1 ? `Building PDF, page ${n} of ${t}` : "Building PDF"; });
    downloadBlob(filename + ".pdf", blob); toast("PDF downloaded");
  } catch (e) { fail(e); }
  finally { if (btn && btn.isConnected) { btn.disabled = false; btn.classList.remove("busy"); btn.innerHTML = label; } }
}
const safeName = (s) => String(s).replace(/[^A-Za-z0-9._-]+/g, "-");

/* ===== Dialogs ===== */
const closeBtn = `<button class="x" data-act="close" aria-label="Close">${ICON.x}</button>`;
function openDialog(html, size) { dlg.className = size || ""; dlg.innerHTML = html; if (!dlg.open) dlg.showModal(); const f = dlg.querySelector("input:not([type=hidden]):not([type=checkbox]),textarea,select"); if (f) f.focus(); }
[dlg, dlg2].forEach((d) => d.addEventListener("click", (e) => { if (e.target === d) d.close(); }));
let pendingConfirm = null;
function askConfirm(title, body, yesLabel, onYes, danger) {
  pendingConfirm = onYes;
  dlg2.innerHTML = `<div class="dhead"><h2>${esc(title)}</h2><button class="x" data-act="c-no" aria-label="Close">${ICON.x}</button></div><div class="dbody"><p>${esc(body)}</p></div>
  <div class="dfoot"><button class="btn" data-act="c-no">Cancel</button><button class="btn ${danger ? "danger" : "primary"}" data-act="c-yes">${esc(yesLabel)}</button></div>`;
  dlg2.showModal(); dlg2.querySelector('[data-act="c-yes"]').focus();
}
dlg2.addEventListener("close", () => { pendingConfirm = null; });
function busy(btn, text) { if (!btn) return () => {}; const html = btn.innerHTML; btn.disabled = true; btn.classList.add("busy"); if (text) btn.textContent = text; return () => { if (btn.isConnected) { btn.disabled = false; btn.classList.remove("busy"); btn.innerHTML = html; } }; }

function accountForm(a, errs) {
  errs = errs || {}; const v = (k) => esc(a ? a[k] : "");
  const fld = (k, extra, cls) => { const f = FIELDS.find((x) => x.key === k); return `<label class="fld ${cls || ""} ${errs[k] ? "has-err" : ""}"><span>${esc(f.label)}${f.req ? "" : ' <span class="hint">optional</span>'}</span><input type="text" name="${k}" value="${v(k)}" ${extra || ""}>${errs[k] ? `<span class="ferr">${esc(errs[k])}</span>` : ""}</label>`; };
  const editing = a && a.id;
  openDialog(`<div class="dhead"><h2>${editing ? "Edit account" : "New account"}</h2>${closeBtn}</div>
  <form class="dbody" id="acct-form" novalidate>
    ${editing && lettersOf(a.id).length ? '<div class="notice info">Saving changes won\'t alter letter copies already generated for this account.</div>' : ""}
    ${Object.keys(errs).length ? `<div class="notice err">Fix the ${plural(Object.keys(errs).length, "highlighted field")} to save.</div>` : ""}
    <p class="fieldset-label">Account</p>
    <div class="grid2">${fld("acctNo", 'autocomplete="off"')}${fld("paymentId", 'autocomplete="off"')}</div>
    <p class="fieldset-label">Debtor and mailing address</p>
    <div class="grid2">${fld("name", "", "span2")}${fld("addr1", "", "span2")}${fld("addr2", "", "span2")}</div>
    <div class="grid3" style="margin-top:14px">${fld("city")}${fld("state", 'maxlength="2" style="text-transform:uppercase"')}${fld("zip", 'inputmode="numeric"')}</div>
    <p class="fieldset-label">Debt</p>
    <div class="grid2">${fld("creditor")}${fld("credAcct", 'autocomplete="off"')}${fld("balance", 'inputmode="decimal" placeholder="1250.00"')}${fld("chargeOff", 'placeholder="YYYY-MM-DD or MM/DD/YYYY"')}</div>
  </form>
  <div class="dfoot"><button class="btn" data-act="close">Cancel</button><button class="btn primary" data-act="save-account" data-id="${editing ? a.id : ""}">${editing ? "Save changes" : "Create account"}</button></div>`);
  const firstErr = dlg.querySelector(".has-err input"); if (firstErr) firstErr.focus();
}
async function saveAccount(id, btn) {
  const fd = new FormData(document.getElementById("acct-form")); const raw = {}; FIELDS.forEach((f) => (raw[f.key] = fd.get(f.key)));
  const errs = validateAccount(raw, { isDuplicate: (n) => S.accounts.some((x) => x.id !== id && x.acctNo.toLowerCase() === n.toLowerCase()), today: S.today });
  if (Object.keys(errs).length) return accountForm({ ...raw, id }, errs);
  const data = normalizeAccount(raw);
  const done = busy(btn, "Saving");
  try {
    const saved = id ? await api("PUT", `/accounts/${id}`, data) : await api("POST", "/accounts", data);
    const i = S.accounts.findIndex((x) => x.id === saved.id);
    if (i >= 0) S.accounts[i] = saved; else S.accounts.push(saved);
    touch();
    delete S.history[saved.id];
    dlg.close(); toast(id ? "Changes saved" : "Account created");
    if (!id) { S.selectedId = saved.id; S.view = "account"; }
    render();
  } catch (e) {
    done();
    if (e.details && e.details.fields) return accountForm({ ...raw, id }, e.details.fields);
    fail(e);
  }
}
async function previewLetter(L) {
  const a = acct(L.accountId);
  openDialog(`<div class="dhead"><h2>${esc(L.templateName)} for ${esc(a ? a.name : "")}<span class="cellsub" style="font-weight:400">Dated ${fmtShortDate(L.letterDate)}</span></h2>${closeBtn}</div>
    <div class="dbody paperbg" id="preview-body"><p class="loading" style="text-align:center">Loading letter</p></div>
    <div class="dfoot"><button class="btn" data-act="close">Close</button><button class="btn" data-act="dl-one" data-id="${L.id}">${ICON.down}Download PDF</button><button class="btn primary" data-act="print-one" data-id="${L.id}">${ICON.print}Print</button></div>`, "wide");
  try { const [html] = await ensureHtml([L.id]); const el = document.getElementById("preview-body"); if (el) el.innerHTML = letterSet(html); }
  catch (e) { fail(e); }
}
function sentForm(L, err, vals) {
  const correcting = !!L.sentDate; vals = vals || {};
  openDialog(`<div class="dhead"><h2>${correcting ? "Correct sent date" : "Record sent date"}</h2>${closeBtn}</div>
  <form class="dbody" id="sent-form" novalidate>
    <p style="margin-bottom:14px">${esc(L.templateName)}, dated <b>${fmtShortDate(L.letterDate)}</b>. Enter the date it was actually mailed or otherwise sent.</p>
    ${correcting ? `<div class="notice info">Currently recorded: <b>${fmtShortDate(L.sentDate)}</b>. The previous date, the corrected date, your reason and the time of the change are all kept in the account history.</div>` : ""}
    <div class="grid2"><label class="fld">Actual sent date<input type="date" name="d" max="${S.today}" value="${esc(vals.d || (correcting ? L.sentDate : S.today))}"></label></div>
    ${correcting ? `<label class="fld" style="margin-top:14px">Reason for correction<textarea name="reason" rows="3" placeholder="For example: entered the wrong date; the letter went out the next morning">${esc(vals.reason || "")}</textarea></label>` : ""}
    ${err ? `<div class="notice err" style="margin:14px 0 0">${esc(err)}</div>` : ""}
    <p class="muted" style="font-size:12.5px;margin-top:14px">A recorded sent date documents that the letter was sent. It isn't, by itself, proof of mailing.</p>
  </form>
  <div class="dfoot"><button class="btn" data-act="close">Cancel</button><button class="btn primary" data-act="save-sent" data-id="${L.id}">${correcting ? "Save correction" : "Record sent date"}</button></div>`, "small");
}
async function saveSent(id, force, btn) {
  const L = S.letters.find((l) => l.id === id); const fd = new FormData(document.getElementById("sent-form"));
  const d = fd.get("d"); const reason = String(fd.get("reason") || "").trim(); const vals = { d, reason };
  if (!parseDate(d)) return sentForm(L, "Enter a valid date.", vals);
  if (d > S.today) return sentForm(L, "The sent date can't be in the future.", vals);
  if (L.sentDate) {
    if (d === L.sentDate) return sentForm(L, "That's the date already recorded. Choose the corrected date.", vals);
    if (!reason) return sentForm(L, "A reason is required to correct a recorded sent date.", vals);
  }
  if (d < L.letterDate && !force) {
    return askConfirm("Sent before the letter date?", `The sent date (${fmtShortDate(d)}) is earlier than the date printed on the letter (${fmtShortDate(L.letterDate)}). Record it anyway?`, "Record anyway", () => saveSent(id, true));
  }
  const done = busy(btn || dlg.querySelector('[data-act="save-sent"]'), "Saving");
  try {
    const updated = await api("POST", `/letters/${id}/sent`, { date: d, reason, expectedCurrent: L.sentDate || null });
    Object.assign(L, updated); touch(); delete S.history[L.accountId];
    S.freshStamp = L.id; dlg.close(); toast(L.corrections.length && reason ? "Sent date corrected" : "Sent date recorded"); render();
  } catch (e) { done(); sentForm(L, e.message, vals); }
}
function batchSentForm(err, val) {
  const list = batchLetters().filter((l) => !l.sentDate);
  openDialog(`<div class="dhead"><h2>Record sent date for batch</h2>${closeBtn}</div>
  <form class="dbody" id="bsent-form" novalidate>
    <p style="margin-bottom:14px">Applies to the ${plural(list.length, "letter")} in this batch that don't have a sent date yet. Letters already recorded aren't changed; correct those one at a time from the account.</p>
    <div class="grid2"><label class="fld">Actual sent date<input type="date" name="d" max="${S.today}" value="${esc(val || S.today)}"></label></div>
    ${err ? `<div class="notice err" style="margin:14px 0 0">${esc(err)}</div>` : ""}
    <p class="muted" style="font-size:12.5px;margin-top:14px">A recorded sent date documents that the letters were sent. It isn't, by itself, proof of mailing.</p>
  </form>
  <div class="dfoot"><button class="btn" data-act="close">Cancel</button><button class="btn primary" data-act="save-bsent">Record for ${plural(list.length, "letter")}</button></div>`, "small");
}
async function saveBatchSent(force) {
  const d = new FormData(document.getElementById("bsent-form")).get("d");
  const list = batchLetters().filter((l) => !l.sentDate);
  if (!parseDate(d)) return batchSentForm("Enter a valid date.", d);
  if (d > S.today) return batchSentForm("The sent date can't be in the future.", d);
  if (list.length && d < list[0].letterDate && !force) {
    return askConfirm("Sent before the letter date?", `The sent date (${fmtShortDate(d)}) is earlier than the date printed on these letters (${fmtShortDate(list[0].letterDate)}). Record it anyway?`, "Record anyway", () => saveBatchSent(true));
  }
  const done = busy(dlg.querySelector('[data-act="save-bsent"]'), "Saving");
  try {
    const r = await api("POST", "/letters/sent", { ids: list.map((l) => l.id), date: d });
    for (const u of r.letters) { const L = S.letters.find((l) => l.id === u.id); if (L) { Object.assign(L, u, { corrections: L.corrections || [] }); delete S.history[L.accountId]; } }
    touch();
    dlg.close(); toast(`Sent date recorded for ${plural(r.letters.length, "letter")}`); render();
  } catch (e) { done(); batchSentForm(e.message, d); }
}

/* ===== Events ===== */
document.addEventListener("click", async (e) => {
  const t = e.target.closest("[data-act]"); if (!t) return;
  const act = t.dataset.act, id = t.dataset.id;
  if (t.tagName === "INPUT" && t.type === "checkbox" && act !== "bsel") return;
  if (t.tagName === "SELECT") return;
  switch (act) {
    case "reload": location.reload(); break;
    case "nav":
      if (tplDirty()) { askConfirm("Discard template changes?", "You have unsaved changes to " + tplById(S.tplId).name + ".", "Discard changes", () => go(t.dataset.v), true); break; }
      go(t.dataset.v); break;
    case "open": S.selectedId = id; [dlg, dlg2].forEach((d) => d.open && d.close()); go("account"); break;
    case "filter": S.filter = t.dataset.v; S.listLimit = 200; viewAccounts(); break;
    case "more-accounts": S.listLimit += 200; viewAccounts(); break;
    case "more-batch": S.batchLimit += 200; viewBatch(); break;
    case "clear-filters": S.filter = "all"; S.search = ""; viewAccounts(); break;
    case "show-unsent": S.filter = "unsent"; S.search = ""; go("accounts"); break;
    case "new-account": accountForm(null); break;
    case "edit-account": accountForm(acct(S.selectedId)); break;
    case "save-account": e.preventDefault(); saveAccount(id || null, t); break;
    case "close": dlg.close(); break;
    case "c-no": pendingConfirm = null; dlg2.close(); break;
    case "c-yes": { const f = pendingConfirm; pendingConfirm = null; dlg2.close(); if (f) f(); break; }
    case "gen-letter": {
      const a = acct(S.selectedId); const d = document.getElementById("ldate").value;
      if (!parseDate(d)) { toast("Choose the date to print on the letter"); return; }
      const done = busy(t, "Generating");
      try {
        const r = await api("POST", "/letters", { accountIds: [a.id], templateId: S.letterTpl, letterDate: d });
        S.letters.push(...r.letters.map((l) => ({ ...l, corrections: [] }))); delete S.history[a.id];
        render(); previewLetter(S.letters[S.letters.length - 1]);
      } catch (err) { done(); fail(err); }
      break;
    }
    case "preview": previewLetter(S.letters.find((l) => l.id === id)); break;
    case "print-one": printLetters([id]); break;
    case "dl-one": { const L = S.letters.find((l) => l.id === id), a = acct(L.accountId); downloadPDF([id], safeName(`${a ? a.acctNo : "letter"}-${L.templateShort}-${L.letterDate}`), t); break; }
    case "sent": sentForm(S.letters.find((l) => l.id === id)); break;
    case "save-sent": e.preventDefault(); saveSent(id, false, t); break;
    case "csv-template": {
      const sample = ["SC-100245", "Jordan Example", "123 Sample St", "Apt 4", "Springfield", "IL", "62701", "Example Bank", "EX-55501234", "1250.00", "PAY-100245", "2025-03-15"];
      downloadBlob("stafford-account-import-template.csv", new Blob([CSV_HEADERS.join(",") + "\r\n" + sample.map(csvCell).join(",") + "\r\n"], { type: "text/csv" })); break;
    }
    case "csv-check": S.importText = document.getElementById("csv-text").value; S.importRows = reviewImport(S.importText); viewImport(); break;
    case "csv-clear": S.importText = ""; S.importRows = null; viewImport(); break;
    case "csv-import": {
      const r = reviewImport(S.importText); S.importRows = r;
      if (r.fatal || r.rows.some((x) => Object.keys(x.errs).length)) { viewImport(); toast("Fix the remaining problems before importing"); return; }
      const done = busy(t, r.rows.length > 500 ? `Importing ${r.rows.length.toLocaleString()} accounts` : "Importing");
      try {
        const res = await api("POST", "/accounts/import", { rows: r.rows.map((x) => ({ line: x.line, raw: x.raw })) });
        S.accounts.push(...res.imported);
        toast(`Imported ${plural(res.imported.length, "account")}`); S.importText = ""; S.importRows = null; S.filter = "all"; S.search = ""; go("accounts");
      } catch (err) {
        done();
        if (err.details && err.details.rows) { const byLine = new Map(err.details.rows.map((x) => [x.line, x.errs])); r.rows.forEach((x) => (x.errs = byLine.get(x.line) || x.errs)); viewImport(); }
        fail(err);
      }
      break;
    }
    case "bsel": if (t.checked) S.batchSel.add(id); else S.batchSel.delete(id); updateActionBar(S.accounts.filter(isComplete).length); break;
    case "batch-gen": {
      const d = S.batchDate; if (!parseDate(d)) { toast("Choose the date to print on the letters"); return; }
      const ids = S.accounts.filter((a) => S.batchSel.has(a.id) && isComplete(a)).sort((a, b) => a.name.localeCompare(b.name)).map((a) => a.id);
      const done = busy(t, "Generating"); const batchId = crypto.randomUUID(); const made = [];
      try {
        for (let i = 0; i < ids.length; i += 100) {
          if (ids.length > 100) t.textContent = `Generating ${Math.min(i + 100, ids.length)} of ${ids.length}`;
          const r = await api("POST", "/letters", { accountIds: ids.slice(i, i + 100), templateId: S.batchTpl, letterDate: d, batchId });
          made.push(...r.letters.map((l) => ({ ...l, corrections: [] })));
        }
      } catch (err) { fail(err); }
      if (made.length) {
        const byAcct = new Map(made.map((l) => [l.accountId, l]));
        S.letters.push(...made); S.lastBatchIds = ids.filter((x) => byAcct.has(x)).map((x) => byAcct.get(x).id);
        made.forEach((l) => delete S.history[l.accountId]); S.batchSel.clear();
        toast(`Generated ${plural(made.length, "letter")}`); render(); window.scrollTo(0, 0);
      } else done();
      break;
    }
    case "batch-print": printLetters(S.lastBatchIds); break;
    case "batch-download": { const l = batchLetters(); downloadPDF(l.map((x) => x.id), safeName(`batch-${l[0].templateShort}-${l[0].letterDate}`), t); break; }
    case "batch-sent": batchSentForm(); break;
    case "save-bsent": e.preventDefault(); saveBatchSent(false); break;
    case "batch-dismiss": S.lastBatchIds = []; viewBatch(); break;
    case "tpl-select": case "tpl-add": {
      if (act === "tpl-select" && id === S.tplId) break;
      const doIt = async () => {
        if (act === "tpl-add") {
          try {
            let k = S.templates.length + 1; while (S.templates.some((x) => x.name === "Letter " + k)) k++;
            const nt = await api("POST", "/templates", { name: "Letter " + k, description: "" });
            S.templates.push(nt); S.tplId = nt.id; toast("Template added");
          } catch (err) { fail(err); }
        } else S.tplId = id;
        render();
      };
      if (tplDirty()) askConfirm("Discard template changes?", "You have unsaved changes to " + tplById(S.tplId).name + ".", "Discard changes", doIt, true); else doIt();
      break;
    }
    case "tpl-save": {
      const tt = tplById(S.tplId); const name = document.getElementById("t-name").value.trim();
      if (!name) { toast("Give the template a name"); return; }
      const done = busy(t, "Saving");
      try {
        const lh = document.getElementById("t-lh").value;
        const saved = await api("PUT", `/templates/${tt.id}`, { name, description: document.getElementById("t-desc").value.trim(), body: document.getElementById("t-body").value });
        Object.assign(tt, saved);
        if (lh !== S.letterhead) S.letterhead = (await api("PUT", "/settings/letterhead", { value: lh })).letterhead;
        render(); toast("Template saved");
      } catch (err) { done(); fail(err); }
      break;
    }
    case "tpl-verify": {
      const tt = tplById(S.tplId); const v = t.dataset.v === "1";
      const doIt = async () => { try { Object.assign(tt, await api("POST", `/templates/${tt.id}/verify`, { verified: v })); render(); toast(v ? "Template marked as verified" : "Verification removed"); } catch (err) { fail(err); } };
      if (v) askConfirm("Mark as verified?", `Confirm that ${templateLabel(tt)} has been compared with the approved Word original and matches it. Letters generated afterwards print without the "${UNVERIFIED_MARK}" mark. Editing the wording later clears verification.`, "Mark as verified", doIt);
      else doIt();
      break;
    }
    case "tpl-delete": {
      const tt = tplById(S.tplId); if (S.templates.length < 2) break;
      askConfirm("Remove " + tt.name + "?", "It won't be offered for new letters. Letters already generated from it are kept.", "Remove template", async () => {
        try { await api("POST", `/templates/${tt.id}/archive`, {}); S.templates = S.templates.filter((x) => x.id !== tt.id); render(); toast("Template removed"); } catch (err) { fail(err); }
      }, true);
      break;
    }
    case "tpl-preview": {
      const a = S.accounts.find(isComplete); if (!a) { toast("Add a complete account to preview"); return; }
      const tt = tplById(S.tplId);
      const html = buildLetterHTML({ kind: tt.kind, body: document.getElementById("t-body").value, letterhead: document.getElementById("t-lh").value }, mergeValues(a, S.today), "Preview");
      openDialog(`<div class="dhead"><h2>Preview using ${esc(a.name)}</h2>${closeBtn}</div><div class="dbody paperbg">${letterSet(html)}</div><div class="dfoot"><button class="btn" data-act="close">Close</button></div>`, "wide");
      break;
    }
    case "user-add": {
      e.preventDefault();
      const fd = new FormData(document.getElementById("user-form"));
      const done = busy(t, "Adding");
      try { adminSeq++; S.users = (await api("PUT", "/users", { email: fd.get("email"), role: fd.get("role"), active: true })).users; document.getElementById("user-form").reset(); viewAdmin(); toast("Person added"); }
      catch (err) { done(); fail(err); }
      break;
    }
    case "user-active": {
      const email = t.dataset.email, u = S.users.find((x) => x.email === email), on = t.dataset.v === "1";
      const doIt = async () => { try { adminSeq++; S.users = (await api("PUT", "/users", { email, role: u.role, active: on })).users; viewAdmin(); toast(on ? "Reactivated" : "Deactivated"); } catch (err) { fail(err); } };
      if (!on) askConfirm("Deactivate " + email + "?", "They won't be able to use the portal. Their past work stays in the history.", "Deactivate", doIt, true); else doIt();
      break;
    }
    case "verify-chain": { const done = busy(t, "Checking"); try { S.chain = await api("GET", "/admin/audit/verify"); viewAdmin(); } catch (err) { done(); fail(err); } break; }
    case "backup-now": { const done = busy(t, "Backing up"); try { adminSeq++; await api("POST", "/admin/backups", {}); S.backups = await api("GET", "/admin/backups"); viewAdmin(); toast("Backup saved"); } catch (err) { done(); fail(err); } break; }
  }
});
document.addEventListener("change", async (e) => {
  const t = e.target;
  if (t.matches('select[data-act="user-role"]')) {
    const email = t.dataset.email, u = S.users.find((x) => x.email === email);
    try { adminSeq++; S.users = (await api("PUT", "/users", { email, role: t.value, active: !!u.active })).users; toast("Role updated"); } catch (err) { fail(err); }
    viewAdmin();
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.matches("tr.clickable")) { S.selectedId = e.target.dataset.id; go("account"); }
  if (e.key === "Enter" && e.target.tagName === "INPUT" && e.target.type !== "checkbox") {
    const form = e.target.closest("form"); if (!form) return; e.preventDefault();
    const btn = form.closest("dialog") ? form.closest("dialog").querySelector(".dfoot .btn.primary") : form.querySelector(".btn.primary");
    if (btn) btn.click();
  }
});
document.addEventListener("submit", (e) => e.preventDefault());
window.addEventListener("beforeunload", (e) => { if (tplDirty()) { e.preventDefault(); e.returnValue = ""; } });

start();
