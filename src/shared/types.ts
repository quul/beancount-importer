import { needsCnySettlement } from "./settlement.js";

/**
 * Shared types between server and web UI.
 */

export type SourceType =
  | "alipay"
  | "wechat"
  | "yunshanfu"
  | `bank-${string}`
  | "manual"
  | "merged"
  | "unknown";

export type ImportStatementKind = "yuebao-interest" | "alipay" | "wechat" | "yunshanfu" | "bank";

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

export interface CurrencyExchange extends DraftPosting {
  previousEventType?: EventType;
}

export interface CurrencyExchangeInput {
  account: string;
  currency: string;
  quantity: string;
}

export interface OriginalAmount {
  amount: number;
  currency: string;
}

export interface CnyRepayment {
  key: string;
  batchId: string;
  txId: string;
  date: string;
  amount: number;
  payee: string;
  sourceFile: string;
  row: number;
}

export interface CnyRepaymentChoice extends CnyRepayment {
  remaining: number;
}

export interface CnySettlement {
  method: "manual" | "repayment";
  repayment?: CnyRepayment;
}

export interface CategoryAllocation {
  account: string;
  amount: string;
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

export interface PdfRegion {
  page: number;
  /** Left, bottom, right and top in PDF page coordinates. */
  bounds: [number, number, number, number];
}

export const PDF_REVIEW_ISSUE = "请核对 PDF 原文";

export function hasPdfSource(tx: Pick<RawTx, "sourceFile" | "sourceFileHash">): boolean {
  return /\.pdf$/i.test(tx.sourceFile) && /^[a-f0-9]{64}$/.test(tx.sourceFileHash ?? "");
}

export interface RefundEvidence {
  cardIdentity?: string;
  originalSourceTxId?: string;
  reportedRefundAmount?: number;
  unconfirmed?: boolean;
  restoreWhenFullyRefunded?: boolean;
}

/** One normalized source transaction. */
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
  originalAmount?: OriginalAmount;
  /** original category column from the statement (Alipay 标签, bank 摘要 etc.) */
  rawCategory: string;
  /** raw payment-method / card description, e.g. "中国工商银行(1234)" */
  rawAccount: string;
  /** Rule-derived type and payment label, kept separate from statement fields. */
  recognition?: { label: string; fundingMethod: string };
  /** statement-provided running balance, gold data for balance assertions */
  balanceAfter?: number;
  /** Explicit proof of complete daily coverage is required for a balance assertion. */
  balanceIsDayEnd?: boolean;
  /** unique id inside the source system (Alipay 交易号, bank 流水号) */
  sourceTxId?: string;
  /** Merchant order reference, when the statement supplies it separately. */
  orderId?: string;
  source: SourceType;
  sourceFile: string;
  /** Hash of original uploaded bytes; enables safe replay checks for files without transaction IDs. */
  sourceFileHash?: string;
  /** The source row and any wrapped description on later pages. */
  pdfRegions?: PdfRegion[];
  /** row number in the original file, for troubleshooting */
  row: number;
  eventType?: EventType;
  refundEvidence?: RefundEvidence;
  sourceStatus?: string;
  originalDirection?: string;
  /** Reason to retain this source row for reference and exclude it from posting. */
  excludedReason?: string;
  issues?: string[];
  fundingParts?: Array<{ rawAccount: string; amount?: number }>;
}

export type TxStatus =
  | "pending" // not yet reviewed
  | "ready" // user confirmed / auto-accepted
  | "duplicate" // dedup engine flagged it
  | "excluded"; // omitted from posting by a rule or review action

export type ReviewExclusionKind = "manual" | "deduplicate";
export type ExclusionKind = ReviewExclusionKind | "automatic";

export interface AutomaticExclusionRule {
  source: string;
  title: string;
  description?: string;
}

export type MergedSource = Pick<RawTx, "id" | "source" | "sourceTxId" | "sourceFile" | "sourceFileHash" | "row" | "date" | "time" | "amount" | "currency" | "direction" | "originalAmount">
  & { cnySettlement?: CnySettlement };

export interface TransactionMerge {
  originals: MergedSource[];
  totals: { currency: string; amount: number }[];
}

export const LEDGER_DUPLICATE_ISSUE = "疑似重复入账";
export const CROSS_SOURCE_ISSUE = "跨来源疑似重复";
export const CROSS_SOURCE_MATCH_REASON = "跨来源同日同金额";
export const ledgerDuplicateReviewIssue = (issue: string) => issue === LEDGER_DUPLICATE_ISSUE || issue.startsWith("可能和账本中的");
export const crossSourceDuplicateReviewIssue = (issue: string) => issue === CROSS_SOURCE_ISSUE || issue.startsWith("不同来源的流水可能是");
export const duplicateReviewIssue = (issue: string) => ledgerDuplicateReviewIssue(issue) || crossSourceDuplicateReviewIssue(issue);

export interface ParsedTx extends RawTx {
  status: TxStatus;
  requireCnySettlement?: boolean;
  cnySettlement?: CnySettlement;
  currencyExchange?: CurrencyExchange;
  /** The review action that excluded this row. Statement rules use excludedReason. */
  reviewExclusion?: ReviewExclusionKind;
  /** inferred beancount asset/liability account for the funding leg */
  fundingAccount: string;
  /** Batch-local account selections for fundingParts, in statement order. */
  fundingPartAccounts?: Array<string | null>;
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
    refundCopy?: "statement" | "ledger";
  };
  /** multi-leg info: e.g. alipay paid with ICBC card → alipay is a pass-through */
  passThrough?: string;
  fundingConfidence?: number;
  fundingReason?: string;
  tags?: string[];
  flag?: "*" | "!";
  reviewNote?: string;
  /** Custom Beancount payee set during review. The source payee remains in payee. */
  reviewPayee?: string;
  /** Custom Beancount narration set during review. */
  narration?: string;
  /** Optional manually reviewed multi-leg transaction, signed amounts. */
  postings?: DraftPosting[];
  matches?: LedgerMatch[];
  /** Related purchase or refund row in the review view of this batch. */
  refundCounterpartId?: string;
  /** Whether a refund follows the reviewed purchase or has its own review decision. */
  refundReviewMode?: "follow-purchase" | "manual";
  merge?: TransactionMerge;
  statementSourceIds?: string[];
  reviewConflictId?: string;
}

export const MAX_NARRATION_LENGTH = 2000;
export const MAX_REVIEW_PAYEE_LENGTH = 2000;

export function reviewPayeeText(tx: Pick<ParsedTx, "payee" | "reviewPayee">): string {
  return tx.reviewPayee ?? tx.payee;
}

export function defaultNarration(tx: Pick<RawTx, "note" | "rawCategory">): string {
  return [...new Set([tx.note, tx.rawCategory].filter(Boolean))].join(" · ");
}

export function isSuspectedDuplicate(tx: ParsedTx): boolean {
  return tx.status !== "duplicate" && Boolean(tx.issues?.some(duplicateReviewIssue));
}

export function canFollowPurchaseRefund(refund: ParsedTx): boolean {
  if (refund.eventType !== "refund" || refund.direction !== "in" || refund.excludedReason || needsCnySettlement(refund)
    || refund.status === "excluded" || refund.status === "duplicate"
    || refund.reviewConflictId || refund.postings || refund.fundingAccount2 || (refund.fundingParts?.length ?? 0) > 1
    || refund.refundReviewMode === "manual") return false;
  return refund.refundReviewMode === "follow-purchase"
    || (refund.status === "pending" && (!refund.finalAccount || refund.finalAccount === refund.suggestedAccount));
}

export function canExcludeSuspectedDuplicate(tx: ParsedTx): boolean {
  return !tx.reviewConflictId && (tx.status === "pending" || tx.status === "ready") && isSuspectedDuplicate(tx);
}

export interface LedgerTx {
  id: string;
  date: string;
  payee: string;
  narration: string;
  postings: Array<{ account: string; amount: number; currency: string }>;
  /** Exact single-currency funding amount before Beancount rounding, for matching. */
  unroundedFunding?: DraftPosting;
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

/** Posted units, indexed by the exact account and currency. */
export type LedgerBalances = Record<string, Record<string, string>>;

export interface LedgerBalanceSnapshot {
  balances: LedgerBalances;
  recentExpenses: Record<string, { date: string; amounts: { currency: string; amount: string }[] }[]>;
}

export interface LedgerInfo {
  accounts: ParsedAccount[];
  transactions: LedgerTx[];
  payeeIndex: Record<string, { account: string; count: number }[]>;
  errors?: LedgerError[];
  loader?: string;
  operatingCurrencies?: string[];
  currencies?: string[];
  /** Explicit native ledger inputs for reusing a verified account list. */
  accountSources?: { file: string; sha256: string }[];
}

export interface BatchRevision {
  batchId: string;
  revision: number;
}

export interface StatementSource {
  id: string;
  file: string;
  name: string;
}

export type StatementName = Pick<StatementSource, "id" | "name">;

export interface BatchReviewConflict {
  id: string;
  transactionIds: string[];
  choices: Array<{ batchId: string; file: string; txs: ParsedTx[] }>;
}

export interface ReviewStatusUndo {
  sessionId: string;
  action: "approve" | "exclude" | "deduplicate" | "update";
  count: number;
  depth: number;
}

export interface ImportPreview {
  file: string;
  source: SourceType;
  txCount: number;
  txs: ParsedTx[];
  combinedFundingPending?: boolean;
  /** Separate approval batch for foreign transactions pending when this batch was committed. */
  settlementBatchId?: string;
  errors: Array<{ row: number; message: string }>;
  /** account candidates detected in this file (e.g. two ICBC cards) */
  accountsDetected: Array<{ raw: string; guess: string; txCount: number }>;
  batchId?: string;
  createdAt?: number;
  revision?: number;
  committed?: boolean;
  mergedInto?: string;
  statementSources?: StatementSource[];
  reviewConflicts?: BatchReviewConflict[];
  splitChargeMatches?: SplitChargeMatch[];
  reviewUndo?: ReviewStatusUndo;
  committedAt?: string;
  written?: string[];
  parseStats?: { total: number; excluded: number; pending: number; duplicate: number; ready: number };
  ledgerErrors?: LedgerError[];
  dedup?: { crossSourceDuplicates: number; ledgerDuplicates: number; transferPairs?: number; familyCardPairs?: number };
}

export interface SplitChargeLine {
  id: string;
  date: string;
  time?: string;
  amount: number;
  payee: string;
  sourceTxId?: string;
  orderId?: string;
  file?: string;
  line?: number;
  posted?: boolean;
}

export interface SplitChargeMatch {
  id: string;
  fundingAccount: string;
  currency: string;
  original: SplitChargeLine;
  refund?: SplitChargeLine;
  parts: SplitChargeLine[];
  refundEvidence?: "reference" | "order" | "amount";
  splitEvidence: "order" | "merchant" | "amount";
}

export interface SplitChargeReview {
  candidates: Array<SplitChargeMatch & { overlaps: boolean }>;
  confirmed: Array<SplitChargeMatch & { canExcludeOffsets: boolean; offsetsExcluded: boolean }>;
  limited: boolean;
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
  /** Destination overrides for statement kinds, relative to the ledger directory. */
  statementDirectories?: Partial<Record<ImportStatementKind, string>>;
  /** Python environment containing Beancount; auto-detected when omitted. */
  pythonPath?: string;
  /** Real ledgers use years/YYYY/imported and the annual include chain. */
  annualLayout?: boolean;
  /** Store new statement copies in uploads under the ledger directory. Defaults to true. */
  archiveUploadsInLedger?: boolean;
  /** Require a confirmed CNY amount for foreign transactions in a CNY ledger. */
  requireCnySettlement?: boolean;
  /** keyword → account mapping, supports multiple cards per bank */
  assetMapping: Array<{
    /** match keyword against raw payment-method text */
    keyword: string;
    account: string;
    /** debit card → Assets, credit card → Liabilities */
    kind: "debit" | "credit";
    cardSuffix?: string;
    /** Whole payment label, optionally scoped to a statement source. */
    exact?: boolean;
    source?: SourceType;
  }>;
  accounts: string[];
  llm: LlmConfig;
}

export type ReviewField = "funding" | "category" | "postings" | "tags" | "settlement" | "exchange";

export interface ReviewProblem {
  id: string;
  field?: ReviewField;
  message: string;
}

export interface GenerateResult {
  entries: string;
  monthFiles: Record<string, string>;
  /** Rendered destination files. Older previews only stored monthFiles. */
  files?: Record<string, { year: string; body: string }>;
  fileCounts?: Record<string, number>;
  /** tx ids that were generated */
  generated: string[];
  errors?: string[];
  reviewProblems?: ReviewProblem[];
  /** suggested `open` directives for accounts referenced but not yet defined */
  opens: string[];
}

export interface FundingMappingGroup {
  id: string;
  label: string;
  source: SourceType;
  count: number;
  accounts: string[];
  statementOnly?: boolean;
  combination?: string;
  defaultAccount?: string;
}

export interface FundingMappingChoice {
  id: string;
  account: string | null;
}

export interface TxDecision {
  id: string;
  account?: string;
  funding?: string;
  status?: TxStatus;
  tags?: string[];
  flag?: "*" | "!";
  reviewNote?: string;
  reviewPayee?: string | null;
  narration?: string | null;
  postings?: DraftPosting[] | null;
  categoryAllocations?: CategoryAllocation[];
}
