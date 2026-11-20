import { transactionPostings, validateTransaction } from "../../src/shared/postings.js";
import { activeTransactions } from "../../src/shared/transactionMerge.js";
import { canFollowPurchaseRefund, isSuspectedDuplicate, type ParsedTx, type TxDecision, type TxStatus } from "../../src/shared/types.js";

export type ReviewFilter = "all" | "suspectedDuplicate" | TxStatus;
export interface ReviewDateRange { start: string; end: string; }
export const EMPTY_REVIEW_DATE_RANGE: ReviewDateRange = { start: "", end: "" };

export interface ReviewRow {
  tx: ParsedTx;
  refund?: ParsedTx;
  originals?: ParsedTx[];
  entries: ParsedTx[];
  amount: number;
}

const fundingAccountPattern = /^(Assets|Liabilities):/;

function usesSingleFundingAccount(tx: ParsedTx): boolean {
  if (!fundingAccountPattern.test(tx.fundingAccount) || tx.fundingAccount2) return false;
  if (!tx.postings) return true;
  const funding = tx.postings.filter((posting) => fundingAccountPattern.test(posting.account));
  return funding.length === 1 && funding[0].account === tx.fundingAccount
    && Math.abs(funding[0].amount - (tx.direction === "in" ? tx.amount : -tx.amount)) < 0.005
    && tx.postings.every((posting) => posting.currency === tx.currency);
}

export function buildReviewRows(txs: readonly ParsedTx[]): ReviewRow[] {
  const byId = new Map(txs.map((tx) => [tx.id, tx]));
  const active = activeTransactions(txs);
  const refunds = new Map<string, ParsedTx>();
  const grouped = new Set<string>();
  const activeIds = new Set(active.map(({ id }) => id));
  for (const tx of active) {
    if (tx.eventType !== "expense" || tx.direction !== "out" || !tx.refundCounterpartId) continue;
    const refund = byId.get(tx.refundCounterpartId);
    if (refund?.eventType !== "refund" || !activeIds.has(refund.id) || refund.direction !== "in" || refund.refundCounterpartId !== tx.id
      || refund.currency !== tx.currency || refund.fundingAccount !== tx.fundingAccount
      || !usesSingleFundingAccount(tx) || !usesSingleFundingAccount(refund)) continue;
    refunds.set(tx.id, refund);
    grouped.add(refund.id);
  }
  return active.filter((tx) => !grouped.has(tx.id)).map((tx) => {
    if (tx.merge) {
      const originals = tx.merge.originals.flatMap(({ id }) => { const original = byId.get(id); return original ? [original] : []; });
      return { tx, entries: [tx], originals, amount: tx.amount };
    }
    const refund = refunds.get(tx.id);
    return refund
      ? { tx, refund, entries: [tx, refund], amount: Number((tx.amount - refund.amount).toFixed(2)) || 0 }
      : { tx, entries: [tx], amount: tx.amount };
  });
}

export function isEditablePostingStatus(tx: ParsedTx): boolean {
  return tx.status === "ready" || tx.status === "pending";
}

function approvalDecision(tx: ParsedTx, accounts: ReadonlySet<string>): TxDecision | undefined {
  const finalAccount = tx.finalAccount || tx.suggestedAccount || "";
  const reviewed = finalAccount === tx.finalAccount ? tx : { ...tx, finalAccount };
  const postings = transactionPostings(reviewed);
  if (postings.some((posting) => !accounts.has(posting.account)) || validateTransaction(reviewed, postings).length) return;
  return !tx.postings && !tx.fundingAccount2 && finalAccount !== tx.finalAccount
    ? { id: tx.id, account: finalAccount, status: "ready" }
    : { id: tx.id, status: "ready" };
}

export function buildBulkPostingPlan(rows: readonly ReviewRow[], accounts: ReadonlySet<string>, selected?: ReadonlySet<string>) {
  const approvals: TxDecision[] = [];
  const exclusionIds: string[] = [];
  const followedRefundIds: string[] = [];
  let needsReview = 0;
  for (const { tx, refund, entries } of rows) {
    const targets = selected ? entries.filter((entry) => selected.has(entry.id)) : entries;
    exclusionIds.push(...targets.filter(isEditablePostingStatus).map((entry) => entry.id));
    const candidates = targets.filter((entry) => !entry.excludedReason && (entry.status === "pending" || entry.status === "excluded"));
    if (!candidates.length) continue;

    if (refund && targets.length === 2 && candidates.includes(refund) && canFollowPurchaseRefund(refund)
      && (tx.status === "ready" || candidates.includes(tx)) && !tx.postings && !tx.fundingAccount2) {
      const purchase = approvalDecision(tx, accounts);
      const category = purchase?.account ?? tx.finalAccount;
      if (purchase && category.startsWith("Expenses:") && !isSuspectedDuplicate(refund)
        && approvalDecision({ ...refund, finalAccount: category }, accounts)) {
        // The server applies the expense category to the refund when it saves the purchase.
        approvals.push(purchase);
        followedRefundIds.push(refund.id);
      } else needsReview++;
      continue;
    }

    const decisions = candidates.map((entry) => approvalDecision(entry, accounts));
    if (decisions.every((decision) => decision !== undefined)) approvals.push(...decisions);
    else needsReview++;
  }
  return { approvals, exclusionIds, followedRefundIds, needsReview };
}

export function matchesReviewFilter(row: ReviewRow, filter: ReviewFilter): boolean {
  if (filter === "all") return true;
  if (filter === "suspectedDuplicate") return row.entries.some(isSuspectedDuplicate);
  return row.entries.some((tx) => tx.status === filter);
}

export function matchesReviewDateRange({ tx }: ReviewRow, { start, end }: ReviewDateRange): boolean {
  if (!start && !end) return true;
  return Boolean(tx.date) && (!start || tx.date >= start) && (!end || tx.date <= end);
}

export function matchesReviewSearch(row: ReviewRow, query: string): boolean {
  if (!query || row.amount.toFixed(2).includes(query)
    || row.tx.merge?.totals.some(({ amount, currency }) => `${amount.toFixed(2)} ${currency}`.toLowerCase().includes(query))) return true;
  return [...row.entries, ...(row.originals ?? [])].some((tx) => [tx.payee, tx.note, tx.narration, tx.rawAccount, tx.recognition?.label, tx.recognition?.fundingMethod,
    tx.finalAccount, tx.fundingAccount, tx.reviewNote, tx.sourceStatus, tx.sourceTxId, tx.amount.toFixed(2), ...(tx.tags ?? []),
    ...(tx.postings?.map(({ account }) => account) ?? [])]
    .join(" ").toLowerCase().includes(query));
}
