import { readFileSync } from "node:fs";
import { currencyPattern } from "../../shared/postings.js";
import type { Direction, EventType } from "../../shared/types.js";

const fields = ["tradeDate", "bookDate", "cardSuffix", "description", "originalAmount", "amount", "ignore"] as const;
type Field = typeof fields[number];
interface ColumnRule { field: Field; header?: RegExp; offset: number; fromPreviousRight: boolean }
interface TransactionRule { section?: string; description?: RegExp; direction?: Direction; date?: "bookDate"; event?: EventType }

export interface PdfTableRule {
  name: string;
  category: string;
  source: `bank-${string}`;
  documentPattern: RegExp;
  columns: ColumnRule[];
  datePattern: RegExp;
  statementDate?: { label: RegExp; monthInTitle: RegExp; lookahead: number };
  descriptionWindow?: { maxDistance: number; baselineOffset: number; pageCarryDistance?: number };
  amount: { pattern: RegExp; currency?: string; currencyByHeader: Map<string, string>; positiveDirection: Direction };
  account?: { label: string; suffixPattern: RegExp };
  sections: Set<string>;
  rules: TransactionRule[];
}

export interface PdfRules {
  tables: PdfTableRule[];
  fallback: {
    ignorePattern: RegExp; amountPattern: RegExp; outPattern: RegExp; inPattern: RegExp; transferPattern: RegExp;
    signedAmountDocumentPattern?: RegExp;
    currency: string; category: string;
  };
}

export const compactPdfText = (value: string) => value.normalize("NFKC").replace(/\s+/g, "");
const rulesFile = new URL("../../../config/pdf-rules.json", import.meta.url);
const directions = ["in", "out"] as const;
const events = ["expense", "income", "refund", "transfer", "unknown", "familyCard"] as const;

function invalid(at: string): never { throw new Error(`config/pdf-rules.json 的 ${at} 无效`); }
function record(value: unknown, at: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid(at);
  return value as Record<string, unknown>;
}
function array(value: unknown, at: string): unknown[] { return Array.isArray(value) ? value : invalid(at); }
function text(value: unknown, at: string): string { return typeof value === "string" && value.trim() ? value : invalid(at); }
function number(value: unknown, at: string): number { return typeof value === "number" && Number.isFinite(value) ? value : invalid(at); }
function positive(value: unknown, at: string): number {
  const parsed = number(value, at);
  return parsed > 0 ? parsed : invalid(at);
}
function choice<T extends string>(value: unknown, options: readonly T[], at: string): T {
  return options.find((option) => option === value) ?? invalid(at);
}
function regex(value: unknown, at: string, flags = ""): RegExp {
  try { return new RegExp(text(value, at), flags); } catch { return invalid(at); }
}
function currency(value: unknown, at: string): string {
  const code = text(value, at);
  return currencyPattern.test(code) ? code : invalid(at);
}

function tableRule(value: unknown, at: string): PdfTableRule {
  const entry = record(value, at);
  const source = text(entry.source, `${at}.source`);
  if (!/^bank-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(source)) return invalid(`${at}.source`);
  const columns: ColumnRule[] = array(entry.columns, `${at}.columns`).map((value, index) => {
    const key = `${at}.columns[${index}]`, column = record(value, key);
    const field = choice(column.field, fields, `${key}.field`);
    const header = field === "ignore" && column.header === undefined ? undefined : regex(column.header, `${key}.header`);
    const offset = number(column.offset ?? 0, `${key}.offset`);
    if (column.fromPreviousRight !== undefined && typeof column.fromPreviousRight !== "boolean") return invalid(`${key}.fromPreviousRight`);
    return { field, header, offset, fromPreviousRight: column.fromPreviousRight === true };
  });
  const usedFields = columns.filter(({ field }) => field !== "ignore").map(({ field }) => field);
  if (usedFields.length !== new Set(usedFields).size || !usedFields.includes("description") || !usedFields.includes("amount")
    || !usedFields.some((field) => field === "tradeDate" || field === "bookDate")
    || columns.some((column, index) => column.fromPreviousRight ? !columns[index - 1]?.header : !column.header)) return invalid(`${at}.columns`);
  const amount = record(entry.amount, `${at}.amount`);
  const amountPattern = regex(amount.pattern, `${at}.amount.pattern`);
  const currencyByHeader = new Map(Object.entries(record(amount.currencyByHeader ?? {}, `${at}.amount.currencyByHeader`))
    .map(([header, code]) => [compactPdfText(header), currency(code, `${at}.amount.currencyByHeader.${header}`)]));
  const fixedCurrency = amount.currency === undefined ? undefined : currency(amount.currency, `${at}.amount.currency`);
  if (!amountPattern.source.includes("(?<amount>") || (!fixedCurrency && !currencyByHeader.size && !amountPattern.source.includes("(?<currency>"))) {
    return invalid(`${at}.amount`);
  }
  const statementDate = entry.statementDate === undefined ? undefined : record(entry.statementDate, `${at}.statementDate`);
  const descriptionWindow = entry.descriptionWindow === undefined ? undefined : record(entry.descriptionWindow, `${at}.descriptionWindow`);
  const account = entry.account === undefined ? undefined : record(entry.account, `${at}.account`);
  const rules = array(entry.rules ?? [], `${at}.rules`).map((value, index): TransactionRule => {
    const key = `${at}.rules[${index}]`, rule = record(value, key);
    if (rule.date === undefined && rule.event === undefined) return invalid(key);
    return {
      section: rule.section === undefined ? undefined : text(rule.section, `${key}.section`),
      description: rule.description === undefined ? undefined : regex(rule.description, `${key}.description`),
      direction: rule.direction === undefined ? undefined : choice(rule.direction, directions, `${key}.direction`),
      date: rule.date === undefined ? undefined : choice(rule.date, ["bookDate"] as const, `${key}.date`),
      event: rule.event === undefined ? undefined : choice(rule.event, events, `${key}.event`),
    };
  });
  return {
    name: text(entry.name, `${at}.name`), category: text(entry.category, `${at}.category`), source: source as `bank-${string}`,
    documentPattern: regex(entry.documentPattern, `${at}.documentPattern`),
    columns, datePattern: regex(entry.datePattern, `${at}.datePattern`),
    statementDate: statementDate && {
      label: regex(statementDate.label, `${at}.statementDate.label`),
      monthInTitle: regex(statementDate.monthInTitle, `${at}.statementDate.monthInTitle`),
      lookahead: positive(statementDate.lookahead, `${at}.statementDate.lookahead`),
    },
    descriptionWindow: descriptionWindow && {
      maxDistance: positive(descriptionWindow.maxDistance, `${at}.descriptionWindow.maxDistance`),
      baselineOffset: number(descriptionWindow.baselineOffset ?? 0, `${at}.descriptionWindow.baselineOffset`),
      pageCarryDistance: descriptionWindow.pageCarryDistance === undefined
        ? undefined : positive(descriptionWindow.pageCarryDistance, `${at}.descriptionWindow.pageCarryDistance`),
    },
    amount: { pattern: amountPattern, currency: fixedCurrency, currencyByHeader, positiveDirection: choice(amount.positiveDirection, directions, `${at}.amount.positiveDirection`) },
    account: account && { label: text(account.label, `${at}.account.label`), suffixPattern: regex(account.suffixPattern, `${at}.account.suffixPattern`) },
    sections: new Set(array(entry.sections ?? [], `${at}.sections`).map((section) => compactPdfText(text(section, `${at}.sections`)))),
    rules,
  };
}

export function loadPdfRules(file: string | URL = rulesFile): PdfRules {
  const root = record(JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, "")), "根节点");
  const fallback = record(root.fallback, "fallback");
  return {
    tables: array(root.tables, "tables").map((entry, index) => tableRule(entry, `tables[${index}]`)),
    fallback: {
      ignorePattern: regex(fallback.ignorePattern, "fallback.ignorePattern", "i"),
      amountPattern: regex(fallback.amountPattern, "fallback.amountPattern", "g"),
      outPattern: regex(fallback.outPattern, "fallback.outPattern"),
      inPattern: regex(fallback.inPattern, "fallback.inPattern", "i"),
      transferPattern: regex(fallback.transferPattern, "fallback.transferPattern"),
      signedAmountDocumentPattern: fallback.signedAmountDocumentPattern === undefined ? undefined
        : regex(fallback.signedAmountDocumentPattern, "fallback.signedAmountDocumentPattern"),
      currency: currency(fallback.currency, "fallback.currency"),
      category: text(fallback.category, "fallback.category"),
    },
  };
}
