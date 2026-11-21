import { isFundingAccount } from "../../src/shared/funding.js";
import { fundingPostingSign, transactionPostings, transactionReviewProblems } from "../../src/shared/postings.js";
import { activeTransactions } from "../../src/shared/transactionMerge.js";
import { canFollowPurchaseRefund, isSuspectedDuplicate, type ParsedTx, type ReviewProblem, type TxDecision, type TxStatus } from "../../src/shared/types.js";

export type ReviewFilter = "all" | "suspectedDuplicate" | TxStatus;
export type ReviewTarget = Pick<ReviewProblem, "id" | "field">;
export interface ReviewDateRange { start: string; end: string; }
export const EMPTY_REVIEW_DATE_RANGE: ReviewDateRange = { start: "", end: "" };

export interface ReviewRow {
  tx: ParsedTx;
  refund?: ParsedTx;
  originals?: ParsedTx[];
  entries: ParsedTx[];
  amount: number;
}

const assetOrLiability = /^(Assets|Liabilities):/;

function usesSingleFundingAccount(tx: ParsedTx): boolean {
  if (!isFundingAccount(tx.fundingAccount) || tx.fundingAccount2) return false;
  if (!tx.postings) return true;
  const funding = tx.postings.filter(({ account }) => account === tx.fundingAccount || assetOrLiability.test(account));
  return funding.length === 1 && funding[0].account === tx.fundingAccount
    && Math.abs(funding[0].amount - fundingPostingSign(tx) * tx.amount) < 0.005
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
  return !tx.reviewConflictId && (tx.status === "ready" || tx.status === "pending");
}

function planApproval(tx: ParsedTx, accounts: ReadonlySet<string>): { decision: TxDecision } | { target: ReviewTarget } {
  const finalAccount = tx.finalAccount || tx.suggestedAccount || "";
  const reviewed = finalAccount === tx.finalAccount ? tx : { ...tx, finalAccount };
  const postings = transactionPostings(reviewed);
  const problems = transactionReviewProblems(reviewed, postings);
  if (problems.length) return { target: { id: tx.id, field: problems.find(({ field }) => field)?.field } };
  const missing = postings.findIndex(({ account }) => !accounts.has(account));
  if (missing !== -1) {
    return { target: { id: tx.id, field: tx.postings || (missing === 1 && tx.fundingAccount2) ? "postings" : missing === 0 ? "funding" : "category" } };
  }
  const decision: TxDecision = !tx.postings && !tx.fundingAccount2 && finalAccount !== tx.finalAccount
    ? { id: tx.id, account: finalAccount, status: "ready" }
    : { id: tx.id, status: "ready" };
  return { decision };
}

export function buildBulkPostingPlan(rows: readonly ReviewRow[], accounts: ReadonlySet<string>, selected?: ReadonlySet<string>) {
  const approvals: TxDecision[] = [];
  const exclusionIds: string[] = [];
  const followedRefundIds: string[] = [];
  const reviewTargets: ReviewTarget[] = [];
  let approvalCount = 0;
  for (const { tx, refund, entries } of rows) {
    const targets = entries.filter((entry) => !entry.reviewConflictId && (!selected || selected.has(entry.id)));
    exclusionIds.push(...targets.filter(isEditablePostingStatus).map((entry) => entry.id));
    const candidates = targets.filter((entry) => !entry.excludedReason && (entry.status === "pending" || entry.status === "excluded"));
    if (!candidates.length) continue;

    if (refund && targets.length === 2 && candidates.includes(refund) && canFollowPurchaseRefund(refund)
      && (tx.status === "ready" || candidates.includes(tx)) && !tx.postings && !tx.fundingAccount2) {
      const purchase = planApproval(tx, accounts);
      if ("target" in purchase) { reviewTargets.push(purchase.target); continue; }
      const category = purchase.decision.account ?? tx.finalAccount;
      if (!category.startsWith("Expenses:")) { reviewTargets.push({ id: tx.id, field: "category" }); continue; }
      if (isSuspectedDuplicate(refund)) { reviewTargets.push({ id: refund.id }); continue; }
      const refundPlan = planApproval({ ...refund, finalAccount: category }, accounts);
      if ("target" in refundPlan) { reviewTargets.push(refundPlan.target); continue; }
      // The server applies the expense category to the refund when it saves the purchase.
      approvals.push(purchase.decision);
      followedRefundIds.push(refund.id);
      approvalCount++;
      continue;
    }

    const plans = candidates.map((entry) => planApproval(entry, accounts));
    const blocked = plans.find((plan) => "target" in plan);
    if (blocked) reviewTargets.push(blocked.target);
    else {
      approvals.push(...plans.flatMap((plan) => "decision" in plan ? [plan.decision] : []));
      approvalCount++;
    }
  }
  return { approvals, approvalCount, exclusionIds, followedRefundIds, reviewTargets };
}

export function remainingReviewProblems(problems: ReviewProblem[], before: ParsedTx[], after: ParsedTx[]): ReviewProblem[] {
  const previous = new Map(before.map((tx) => [tx.id, tx]));
  const current = new Map(activeTransactions(after).map((tx) => [tx.id, tx]));
  return problems.filter(({ id, field }) => {
    const original = previous.get(id), updated = current.get(id);
    if (!original || updated?.status !== "ready") return false;
    if (field === "funding") return original.fundingAccount === updated.fundingAccount && Boolean(original.postings) === Boolean(updated.postings);
    if (field === "category") return original.finalAccount === updated.finalAccount && Boolean(original.postings) === Boolean(updated.postings);
    if (field === "postings") return original.fundingAccount2 === updated.fundingAccount2 && JSON.stringify(original.postings) === JSON.stringify(updated.postings);
    if (field === "tags") return JSON.stringify(original.tags) === JSON.stringify(updated.tags);
    return original.date === updated.date && original.amount === updated.amount && original.currency === updated.currency && original.flag === updated.flag;
  });
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
