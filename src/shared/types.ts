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
export type EventType = "expense" | "income" | "refund" | "transfer" | "unknown" | "familyCard";
/** Someone else paid on my behalf (亲情卡/亲友代付): the funding leg is theirs, not mine. */
export function isFamilyCard(tx: { eventType?: EventType; note?: string; rawCategory?: string }): boolean {
  if (tx.eventType === "familyCard") return true;
  return /亲情卡|亲属卡/.test(`${tx.note ?? ""}`) || /亲友代付|亲情代付/.test(`${tx.rawCategory ?? ""}`);
}

export interface DraftPosting {
  account: string;
  amount: number;
  currency: string;
}

export interface LedgerMatch {
  id: string;
  date: string;
  payee: string;
  narration: string;
  file?: string;
  line?: number;
  reason: string;
  postings: DraftPosting[];
}

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
  /** Explicit proof of complete daily coverage is required for a balance assertion. */
  balanceIsDayEnd?: boolean;
  /** unique id inside the source system (Alipay 交易号, bank 流水号) */
  sourceTxId?: string;
  source: SourceType;
  sourceFile: string;
  /** Hash of original uploaded bytes; enables safe replay checks for files without transaction IDs. */
  sourceFileHash?: string;
  /** row number in the original file, for troubleshooting */
  row: number;
  eventType?: EventType;
  sourceStatus?: string;
  originalDirection?: string;
  /** Retain unsuccessful/closed source rows for a complete reconciliation. */
  excludedReason?: string;
  issues?: string[];
  fundingParts?: Array<{ rawAccount: string; amount?: number }>;
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
  fundingConfidence?: number;
  tags?: string[];
  flag?: "*" | "!";
  reviewNote?: string;
  /** Optional manually reviewed multi-leg transaction, signed amounts. */
  postings?: DraftPosting[];
  matches?: LedgerMatch[];
}

export interface LedgerTx {
  id: string;
  date: string;
  payee: string;
  narration: string;
  postings: Array<{ account: string; amount: number; currency: string }>;
  file?: string;
  line?: number;
  time?: string;
  tags?: string[];
  links?: string[];
  flag?: string;
  source?: string;
  sourceTxId?: string;
  metadata?: Record<string, string>;
}

export interface ParsedAccount {
  account: string;
  type: "assets" | "liabilities" | "equity" | "income" | "expenses";
  openedAt?: string;
  currency?: string;
  currencies?: string[];
  closedAt?: string;
  metadata?: Record<string, string>;
}

export interface LedgerError {
  file?: string;
  line?: number;
  message: string;
  type?: string;
}

export interface LedgerInfo {
  accounts: ParsedAccount[];
  transactions: LedgerTx[];
  payeeIndex: Record<string, { account: string; count: number }[]>;
  errors?: LedgerError[];
  loader?: string;
}

export interface ImportPreview {
  file: string;
  source: SourceType;
  txCount: number;
  txs: ParsedTx[];
  errors: Array<{ row: number; message: string }>;
  /** account candidates detected in this file (e.g. two ICBC cards) */
  accountsDetected: Array<{ raw: string; guess: string; txCount: number }>;
  batchId?: string;
  createdAt?: number;
  revision?: number;
  committed?: boolean;
  committedAt?: string;
  written?: string[];
  parseStats?: { total: number; excluded: number; pending: number; duplicate: number; ready: number };
  ledgerErrors?: LedgerError[];
  dedup?: { crossSourceDuplicates: number; ledgerDuplicates: number; transferPairs?: number; familyCardPairs?: number };
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
  /** Python environment containing Beancount; auto-detected when omitted. */
  pythonPath?: string;
  /** Real ledgers use years/YYYY/imported and the annual include chain. */
  annualLayout?: boolean;
  /** keyword → account mapping, supports multiple cards per bank */
  assetMapping: Array<{
    /** match keyword against raw payment-method text */
    keyword: string;
    account: string;
    /** debit card → Assets, credit card → Liabilities */
    kind: "debit" | "credit";
    cardSuffix?: string;
  }>;
  accounts: string[];
  llm: LlmConfig;
}

export interface GenerateResult {
  entries: string;
  monthFiles: Record<string, string>;
  /** tx ids that were generated */
  generated: string[];
  errors?: string[];
  /** suggested `open` directives for accounts referenced but not yet defined */
  opens: string[];
}

export interface TxDecision {
  id: string;
  account?: string;
  funding?: string;
  status?: TxStatus;
  tags?: string[];
  flag?: "*" | "!";
  reviewNote?: string;
  postings?: DraftPosting[] | null;
}
