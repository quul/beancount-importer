import { canFollowPurchaseRefund, CROSS_SOURCE_MATCH_REASON, crossSourceDuplicateReviewIssue, isSuspectedDuplicate,
  type LedgerTx, type ParsedTx, type RefundEvidence } from "../../shared/types.js";
import { isFundingAccount, normalizePaymentMethod, singlePaymentMethod } from "../../shared/funding.js";
import { cardSuffix, statementRefundEvidence } from "../parsers/refund-evidence.js";
import { findPostedRefundCopies, findStatementRefundCopies } from "./refund-copies.js";

type RefundMatchRow = { tx: ParsedTx; evidence?: RefundEvidence; closedPurchase: boolean };
type MatchKey = (row: RefundMatchRow) => string | undefined;

const orderKey = (source: string, id: string | undefined) => id ? JSON.stringify([source, id]) : undefined;
const merchant = (value: string) => value.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
const closedRefundPurchase = (tx: ParsedTx, evidence = statementRefundEvidence(tx)) => Boolean(tx.excludedReason && evidence?.restoreWhenFullyRefunded);

function reportedAmountKey(tx: ParsedTx, amount: number): string | undefined {
  const payee = merchant(tx.payee);
  const payment = normalizePaymentMethod(singlePaymentMethod(tx));
  if (!payment || !/[\p{L}\p{N}]/u.test(payee)) return;
  return JSON.stringify([tx.source, payee, payment, tx.currency, amount]);
}

function cardRefundKey({ tx, evidence }: RefundMatchRow): string | undefined {
  const payment = normalizePaymentMethod(evidence?.cardIdentity ?? singlePaymentMethod(tx)).replace(/\s+/g, "");
  const payee = merchant(tx.payee).replace(/^(?:退款|退货|撤销|冲正)[-–—:·]/u, "");
  // The normalized card label must include a suffix. Bank-only labels can cover several cards.
  if (!payment || !/[\p{L}\p{N}]/u.test(payee) || (!evidence?.cardIdentity && !cardSuffix(payment))) return;
  return JSON.stringify([tx.source, tx.date, payee, payment, tx.currency, tx.amount]);
}

function paidBefore(purchase: ParsedTx, refund: ParsedTx): boolean {
  if (purchase.date !== refund.date) return purchase.date < refund.date;
  return !purchase.time || !refund.time || purchase.time <= refund.time;
}

function pairByEvidence(purchases: readonly RefundMatchRow[], refunds: readonly RefundMatchRow[], pairs: Map<string, string>,
  purchaseKey: MatchKey, refundKey: MatchKey, compatible: (purchase: RefundMatchRow, refund: RefundMatchRow) => boolean): Set<string> {
  if (!purchases.length || !refunds.length) return new Set();
  const purchaseIndex = new Map<string, RefundMatchRow[]>();
  for (const row of purchases) {
    const key = purchaseKey(row);
    if (!key) continue;
    const group = purchaseIndex.get(key) ?? [];
    group.push(row);
    purchaseIndex.set(key, group);
  }
  if (!purchaseIndex.size) return new Set();
  const candidates = new Map<string, RefundMatchRow[]>();
  const evidenceIds = new Set<string>();
  const refundCounts = new Map<string, number>();
  for (const refund of refunds) {
    const key = refundKey(refund);
    if (!key) continue;
    const group = purchaseIndex.get(key);
    if (!group) continue;
    evidenceIds.add(refund.tx.id);
    const matches = group.filter((purchase) => paidBefore(purchase.tx, refund.tx) && compatible(purchase, refund));
    if (!matches.length) continue;
    candidates.set(refund.tx.id, matches);
    for (const { tx } of matches) refundCounts.set(tx.id, (refundCounts.get(tx.id) ?? 0) + 1);
  }
  for (const [refundId, matches] of candidates) {
    if (matches.length !== 1 || refundCounts.get(matches[0].tx.id) !== 1) continue;
    const purchaseId = matches[0].tx.id;
    pairs.set(purchaseId, refundId);
    pairs.set(refundId, purchaseId);
  }
  return evidenceIds;
}

function pairRefunds(txs: readonly ParsedTx[]): Map<string, string> {
  const purchases: RefundMatchRow[] = [], refunds: RefundMatchRow[] = [];
  for (const tx of txs) {
    if (!tx.date || !Number.isFinite(tx.amount) || tx.amount <= 0 || tx.merge || tx.reviewConflictId
      || (tx.status === "duplicate" && tx.duplicateOf?.refundCopy !== "statement")) continue;
    if (tx.eventType !== "expense" && tx.eventType !== "refund") continue;
    const evidence = statementRefundEvidence(tx);
    const closedPurchase = closedRefundPurchase(tx, evidence);
    if (evidence?.unconfirmed || (tx.excludedReason && !closedPurchase)) continue;
    if (tx.eventType === "expense" && tx.direction === "out") purchases.push({ tx, evidence, closedPurchase });
    if (tx.eventType === "refund" && tx.direction === "in" && !tx.excludedReason) refunds.push({ tx, evidence, closedPurchase: false });
  }

  const pairs = new Map<string, string>();
  if (!purchases.length || !refunds.length) return pairs;
  const referenced = refunds.filter(({ evidence }) => evidence?.originalSourceTxId);
  const referenceKey: MatchKey = ({ tx, evidence }) => orderKey(tx.source, evidence?.originalSourceTxId);
  const purchaseOrder: MatchKey = ({ tx }) => orderKey(tx.source, tx.sourceTxId);
  const claimedOrders = new Set(referenced.map(referenceKey));
  pairByEvidence(purchases, referenced, pairs, purchaseOrder, referenceKey, (purchase, refund) =>
    purchase.tx.currency === refund.tx.currency && refund.tx.amount <= purchase.tx.amount
    && (!purchase.closedPurchase || refund.tx.amount === purchase.tx.amount));

  const remainingPurchases = purchases.filter((row) => !row.closedPurchase && !pairs.has(row.tx.id)
    && (!row.tx.sourceTxId || !claimedOrders.has(purchaseOrder(row))));
  const remainingRefunds = refunds.filter(({ tx, evidence }) => !evidence?.originalSourceTxId && !pairs.has(tx.id));
  const reportedCandidates = pairByEvidence(remainingPurchases, remainingRefunds, pairs, ({ tx, evidence }) => {
    const amount = evidence?.reportedRefundAmount;
    return amount !== undefined && amount > 0 && amount <= tx.amount ? reportedAmountKey(tx, amount) : undefined;
  }, ({ tx }) => reportedAmountKey(tx, tx.amount), () => true);

  // An ambiguous reference or reported amount takes priority over a coincidental full-amount match.
  pairByEvidence(remainingPurchases.filter(({ tx, evidence }) => !pairs.has(tx.id) && evidence?.reportedRefundAmount === undefined),
    remainingRefunds.filter(({ tx }) => !reportedCandidates.has(tx.id)), pairs, cardRefundKey, cardRefundKey, () => true);
  return pairs;
}

export function restoreFullRefundPurchases(txs: readonly ParsedTx[]): ParsedTx[] {
  const closed = txs.filter((tx) => tx.status === "excluded" && tx.excludedReason && tx.eventType === "expense" && closedRefundPurchase(tx));
  if (!closed.length) return [];
  const pairs = pairRefunds(txs);
  const restored = closed.filter((tx) => pairs.has(tx.id));
  for (const tx of restored) {
    delete tx.excludedReason;
    tx.status = "pending";
    const issue = "已退款，核对退款流水";
    if (!tx.issues?.includes(issue)) tx.issues = [...(tx.issues ?? []), issue];
  }
  return restored;
}

function resolveStatementRefunds(txs: readonly ParsedTx[]) {
  const pairs = pairRefunds(txs);
  const copies = findStatementRefundCopies(txs, pairs);
  for (const [copy, retained] of copies) {
    const purchase = pairs.get(copy);
    if (!purchase) continue;
    pairs.delete(copy);
    pairs.delete(purchase);
    if (!pairs.has(retained.id)) {
      pairs.set(purchase, retained.id);
      pairs.set(retained.id, purchase);
    }
  }
  return { pairs, copies };
}

export function matchStatementRefunds(txs: readonly ParsedTx[]): Map<string, string> {
  return resolveStatementRefunds(txs).pairs;
}

function setRefundCopy(tx: ParsedTx, duplicate: NonNullable<ParsedTx["duplicateOf"]>): boolean {
  if (tx.status === "duplicate" && tx.duplicateOf?.id === duplicate.id && tx.duplicateOf?.where === duplicate.where
    && tx.duplicateOf?.refundCopy === duplicate.refundCopy) return false;
  tx.status = "duplicate";
  tx.duplicateOf = duplicate;
  return true;
}

export function syncStatementRefunds(txs: readonly ParsedTx[], ledger?: readonly LedgerTx[]): boolean {
  let changed = false;
  let resolution = resolveStatementRefunds(txs);
  if (ledger) {
    const posted = findPostedRefundCopies(txs, ledger, resolution.copies);
    for (const tx of txs) {
      const entry = posted.get(tx.id);
      if (!entry) continue;
      const label = "同一退款已写入账本";
      if (setRefundCopy(tx, { id: entry.id, where: entry.file ?? "ledger", label, refundCopy: "ledger" })) {
        tx.matches = [{ id: entry.id, date: entry.date, payee: entry.payee, narration: entry.narration, line: entry.line,
          file: entry.file, reason: label, postings: entry.postings }];
        changed = true;
      }
    }
    if (changed) resolution = resolveStatementRefunds(txs);
  }

  const { pairs, copies } = resolution;
  const retainedCopies = new Map<string, Set<string>>();
  for (const [copy, retained] of copies) {
    const ids = retainedCopies.get(retained.id) ?? new Set<string>();
    ids.add(copy);
    retainedCopies.set(retained.id, ids);
  }
  for (const tx of txs) {
    const retained = copies.get(tx.id);
    if (retained) {
      changed = setRefundCopy(tx, { id: retained.id, where: retained.sourceFile, label: "同一退款已由另一份账单保留", refundCopy: "statement" }) || changed;
    } else if (tx.duplicateOf?.refundCopy === "statement") {
      if (tx.status === "duplicate") tx.status = "pending";
      delete tx.duplicateOf;
      changed = true;
    }
    const resolved = retainedCopies.get(tx.id);
    if (!resolved) continue;
    const matches = tx.matches?.filter((match) => match.reason !== CROSS_SOURCE_MATCH_REASON || !resolved.has(match.id));
    if (matches && matches.length !== tx.matches?.length) { tx.matches = matches; changed = true; }
    if (tx.issues?.some(crossSourceDuplicateReviewIssue) && !matches?.some(({ reason }) => reason === CROSS_SOURCE_MATCH_REASON)) {
      tx.issues = tx.issues.filter((issue) => !crossSourceDuplicateReviewIssue(issue));
      changed = true;
    }
  }

  if (!pairs.size && !txs.some((tx) => tx.refundReviewMode === "follow-purchase")) return changed;
  const byId = new Map(txs.map((tx) => [tx.id, tx]));
  for (const refund of txs) {
    if (!canFollowPurchaseRefund(refund)) continue;
    const following = refund.refundReviewMode === "follow-purchase";

    const purchase = byId.get(pairs.get(refund.id) ?? "");
    if (!purchase || purchase.status !== "ready" || purchase.postings || purchase.fundingAccount2 || !purchase.finalAccount.startsWith("Expenses:")) {
      if (following) {
        refund.finalAccount = refund.suggestedAccount;
        refund.status = "pending";
        delete refund.refundReviewMode;
        changed = true;
      }
      continue;
    }

    const funded = [purchase.fundingAccount, refund.fundingAccount].every(isFundingAccount);
    const status = funded && !isSuspectedDuplicate(refund) ? "ready" : "pending";
    if (following && refund.finalAccount === purchase.finalAccount && refund.status === status) continue;
    refund.finalAccount = purchase.finalAccount;
    refund.status = status;
    refund.refundReviewMode = "follow-purchase";
    changed = true;
  }
  return changed;
}
