/**
 * Shared types between server and web UI.
 */

export type SourceType =
  | "alipay"
  | "wechat"
  | "yunshanfu"
  | "bank-boc"
  | "bank-abc"
  | "bank-czbank"
  | "bank-spdb"
  | "bank-icbc"
  | "bank-ccb"
  | "bank-generic"
  | "unknown";

export type Direction = "in" | "out";

/** One normalized transaction parsed from a statement file. */
export interface RawTx {
  /** stable hash for dedup: date|amount|direction|payee-normalized */
  id: string;
  /** ISO date YYYY-MM-DD */
  date: string;
  /** optional time HH:MM:SS when the export provides it */
  time?: string;
  amount: number;
  direction: Direction;
  currency: string;
  payee: string;
  note: string;
  /** original category column from the statement (Alipay 标签, bank 摘要 etc.) */
  rawCategory: string;
  /** raw payment-method / card description, e.g. "中国工商银行(1234)" */
  rawAccount: string;
  /** statement-provided running balance, gold data for balance assertions */
  balanceAfter?: number;
  /** unique id inside the source system (Alipay 交易号, bank 流水号) */
  sourceTxId?: string;
  source: SourceType;
  sourceFile: string;
  /** row number in the original file, for troubleshooting */
  row: number;
}

export type TxStatus =
  | "pending" // not yet reviewed
  | "ready" // user confirmed / auto-accepted
  | "duplicate" // dedup engine flagged it
  | "excluded"; // user manually unchecked

export interface ParsedTx extends RawTx {
  status: TxStatus;
  /** inferred beancount asset/liability account for the funding leg */
  fundingAccount: string;
  /** second leg when the engine can infer a transfer (e.g. credit card repayment) */
  fundingAccount2?: string;
  /** suggested categorization account (LLM + memory + history) */
  suggestedAccount: string;
  /** LLM confidence 0..1 */
  confidence: number;
  /** explanation from LLM for UI display */
  reason?: string;
  /** final account chosen by user (or auto-accepted suggestion) */
  finalAccount: string;
  /** dedup info when status === "duplicate" */
  duplicateOf?: {
    /** tx id of the already-imported transaction */
    id: string;
    where: string;
    label: string;
  };
  /** multi-leg info: e.g. alipay paid with ICBC card → alipay is a pass-through */
  passThrough?: string;
}

export interface LedgerTx {
  id: string;
  date: string;
  payee: string;
  narration: string;
  postings: Array<{ account: string; amount: number; currency: string }>;
}

export interface ParsedAccount {
  account: string;
  type: "assets" | "liabilities" | "equity" | "income" | "expenses";
  openedAt?: string;
  currency?: string;
}

export interface LedgerInfo {
  accounts: ParsedAccount[];
  transactions: LedgerTx[];
  payeeIndex: Record<string, { account: string; count: number }[]>;
}

export interface ImportPreview {
  file: string;
  source: SourceType;
  txCount: number;
  txs: ParsedTx[];
  errors: Array<{ row: number; message: string }>;
  /** account candidates detected in this file (e.g. two ICBC cards) */
  accountsDetected: Array<{ raw: string; guess: string; txCount: number }>;
}

export interface LlmConfig {
  provider: "openai-compatible" | "off";
  apiBase: string;
  model: string;
  apiKey: string;
}

export interface AppConfig {
  /** beancount ledger root dir (absolute or relative to server cwd) */
  ledgerRoot: string;
  mainFile: string;
  monthlyDir: string;
  /** keyword → account mapping, supports multiple cards per bank */
  assetMapping: Array<{
    /** match keyword against raw payment-method text */
    keyword: string;
    account: string;
    /** debit card → Assets, credit card → Liabilities */
    kind: "debit" | "credit";
  }>;
  accounts: string[];
  llm: LlmConfig;
}

export interface GenerateResult {
  entries: string;
  monthFiles: Record<string, string>;
  /** tx ids that were generated */
  generated: string[];
}
