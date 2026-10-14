-- Stafford Account and Letter Portal: initial schema
-- Timestamps are ISO-8601 UTC strings. Calendar dates (letter, sent, charge-off) are YYYY-MM-DD.

CREATE TABLE users (
  email        TEXT PRIMARY KEY COLLATE NOCASE,
  role         TEXT NOT NULL CHECK (role IN ('admin', 'staff', 'viewer')),
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL,
  created_by   TEXT NOT NULL,
  last_seen_at TEXT
);

CREATE TABLE accounts (
  id            TEXT PRIMARY KEY,
  acct_no       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT NOT NULL,
  addr1         TEXT NOT NULL,
  addr2         TEXT NOT NULL DEFAULT '',
  city          TEXT NOT NULL,
  state         TEXT NOT NULL,
  zip           TEXT NOT NULL,
  creditor      TEXT NOT NULL,
  cred_acct     TEXT NOT NULL,
  balance_cents INTEGER NOT NULL,
  payment_id    TEXT NOT NULL,
  charge_off    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  created_by    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  updated_by    TEXT NOT NULL
);
CREATE INDEX accounts_name ON accounts (name COLLATE NOCASE);

CREATE TABLE templates (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  kind        TEXT NOT NULL CHECK (kind IN ('layout', 'text')),
  body        TEXT NOT NULL,
  placeholder INTEGER NOT NULL DEFAULT 0,
  verified    INTEGER NOT NULL DEFAULT 0,
  verified_by TEXT,
  verified_at TEXT,
  sort        INTEGER NOT NULL DEFAULT 0,
  archived    INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL,
  updated_by  TEXT NOT NULL
);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- A generated letter is a fixed copy. Only its sent-date columns may change afterwards.
CREATE TABLE letters (
  id              TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL REFERENCES accounts (id),
  template_id     TEXT NOT NULL,
  template_name   TEXT NOT NULL,
  template_short  TEXT NOT NULL,
  kind            TEXT NOT NULL,
  letter_date     TEXT NOT NULL,
  batch_id        TEXT,
  html            TEXT NOT NULL,
  snapshot        TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  created_by      TEXT NOT NULL,
  sent_date       TEXT,
  sent_entered_at TEXT,
  sent_entered_by TEXT
);
CREATE INDEX letters_account ON letters (account_id);
CREATE INDEX letters_batch ON letters (batch_id);
CREATE INDEX letters_unsent ON letters (sent_date) WHERE sent_date IS NULL;

CREATE TRIGGER letters_content_locked
BEFORE UPDATE OF id, account_id, template_id, template_name, template_short, kind, letter_date, batch_id, html, snapshot, created_at, created_by ON letters
BEGIN SELECT RAISE(ABORT, 'Generated letters cannot be changed'); END;

CREATE TRIGGER letters_no_delete
BEFORE DELETE ON letters
BEGIN SELECT RAISE(ABORT, 'Generated letters cannot be deleted'); END;

-- Every change to a recorded sent date, with the reason given.
CREATE TABLE sent_corrections (
  id        TEXT PRIMARY KEY,
  letter_id TEXT NOT NULL REFERENCES letters (id),
  prev_date TEXT NOT NULL,
  new_date  TEXT NOT NULL,
  reason    TEXT NOT NULL,
  at        TEXT NOT NULL,
  by        TEXT NOT NULL
);
CREATE INDEX sent_corrections_letter ON sent_corrections (letter_id);
CREATE TRIGGER sent_corrections_no_update BEFORE UPDATE ON sent_corrections
BEGIN SELECT RAISE(ABORT, 'Sent-date corrections cannot be changed'); END;
CREATE TRIGGER sent_corrections_no_delete BEFORE DELETE ON sent_corrections
BEGIN SELECT RAISE(ABORT, 'Sent-date corrections cannot be deleted'); END;

-- Ledger files live in R2; this table holds their metadata.
CREATE TABLE ledgers (
  id           TEXT PRIMARY KEY,
  account_id   TEXT NOT NULL REFERENCES accounts (id),
  r2_key       TEXT NOT NULL UNIQUE,
  filename     TEXT NOT NULL,
  size         INTEGER NOT NULL,
  content_type TEXT NOT NULL,
  uploaded_at  TEXT NOT NULL,
  uploaded_by  TEXT NOT NULL
);
CREATE INDEX ledgers_account ON ledgers (account_id);
CREATE TRIGGER ledgers_no_delete BEFORE DELETE ON ledgers
BEGIN SELECT RAISE(ABORT, 'Ledger records cannot be deleted'); END;

-- Change history. Append-only, and each row carries a SHA-256 hash of its content and the previous
-- row's hash, so any edit made outside the app (for example in the D1 console) is detectable.
-- prev_hash is UNIQUE so two concurrent writers can't both extend the chain from the same row.
CREATE TABLE audit_log (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  at         TEXT NOT NULL,
  actor      TEXT NOT NULL,
  account_id TEXT,
  entity     TEXT NOT NULL,
  entity_id  TEXT,
  action     TEXT NOT NULL,
  detail     TEXT NOT NULL DEFAULT '',
  prev_hash  TEXT NOT NULL UNIQUE,
  hash       TEXT NOT NULL
);
CREATE INDEX audit_account ON audit_log (account_id, seq);
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'The change history is append-only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'The change history is append-only'); END;
