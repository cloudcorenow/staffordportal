// Types for shared.js (plain JS so the browser can load it directly). Not deployed: see .assetsignore.
export interface AccountFields { acctNo: string; name: string; addr1: string; addr2: string; city: string; state: string; zip: string; creditor: string; credAcct: string; balance: string; paymentId: string; chargeOff: string }
export interface TemplateDefault { id: string; name: string; description: string; kind: "layout" | "text"; placeholder: boolean; verified: boolean; sort: number; body: string }
export const COMPANY_NAME: string;
export const LOGO_PATH: string;
export const UNVERIFIED_MARK: string;
export const FIELDS: { key: keyof AccountFields; csv: string; label: string; req: boolean }[];
export const CSV_HEADERS: string[];
export const MAX_IMPORT_ROWS: number;
export const DEFAULT_LETTERHEAD: string;
export const DEFAULT_BODY: string;
export const TOKEN_HELP: string[];
export function esc(s: unknown): string;
export function parseDate(v: unknown): string | null;
export function parseBalance(v: unknown): number | null;
export function fmtLongDate(iso: string | null | undefined): string;
export function fmtShortDate(iso: string | null | undefined): string;
export function fmtMoney(n: unknown): string;
export function validateAccount(a: Partial<Record<keyof AccountFields, unknown>>, opts?: { isDuplicate?: (acctNo: string) => boolean; today?: string }): Record<string, string>;
export function normalizeAccount(a: Partial<Record<keyof AccountFields, unknown>>): AccountFields;
export function checkImportRows<T extends { line: number; raw: Record<string, string> }>(rows: T[], opts?: { existing?: (acctNo: string) => boolean; today?: string }): (T & { errs: Record<string, string> })[];
export function defaultTemplates(): TemplateDefault[];
export function templateLabel(t: { name: string; description?: string }): string;
export function mergeValues(a: AccountFields, letterDate: string): Record<string, string>;
export function buildLetterHTML(t: { kind: string; body: string; letterhead: string }, vals: Record<string, string>, mark?: string): string;
