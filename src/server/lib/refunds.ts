import { canFollowPurchaseRefund, isSuspectedDuplicate, type ParsedTx } from "../../shared/types.js";
import { parseAmount } from "../parsers/common.js";
import { normalizePaymentMethod, singlePaymentMethod } from "./accounts.js";
import { sourceKey } from "./dedup.js";

function reportedRefundAmount(tx: ParsedTx): number | null {
  const status = tx.sourceStatus?.normalize("NFKC").trim() ?? "";
  if (status === "已全额退款") return tx.amount;
  const match = status.match(/^已(?:全额)?退款\s*(?:\(\s*¥\s*([\d,.]+)\s*\)|¥\s*([\d,.]+))$/);
  return match ? parseAmount(match[1] ?? match[2]) : null;
}

function matchKey(tx: ParsedTx, amount: number): string | undefined {
  const payee = tx.payee.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
  const payment = singlePaymentMethod(tx);
  if (!payment || /^[\/—-]*$/.test(payee)) return;
  return JSON.stringify([payee, normalizePaymentMethod(payment), tx.currency, amount.toFixed(2)]);
}

function paidBefore(purchase: ParsedTx, refund: ParsedTx): boolean {
  if (purchase.date !== refund.date) return purchase.date < refund.date;
  return !purchase.time || !refund.time || purchase.time <= refund.time;
}

/** Pair WeChat statement rows when the purchase reports the refund amount and both sides are unique. */
export function matchWechatRefunds(txs: readonly ParsedTx[]): Map<string, string> {
  const unique = new Map<string, ParsedTx>();
  for (const tx of txs) {
    if (tx.source !== "wechat" || tx.excludedReason || !tx.date || tx.amount <= 0) continue;
    const key = sourceKey(tx.source, tx.sourceTxId, tx.sourceFileHash, tx.row) ?? tx.id;
    const previous = unique.get(key);
    if (!previous || (previous.status === "duplicate" && tx.status !== "duplicate")) unique.set(key, tx);
  }

  const purchases = new Map<string, ParsedTx[]>();
  for (const tx of unique.values()) {
    if (tx.direction !== "out" || tx.eventType !== "expense") continue;
    const reported = reportedRefundAmount(tx);
    if (reported == null || reported <= 0 || reported > tx.amount) continue;
    const key = matchKey(tx, reported);
    if (!key) continue;
    const group = purchases.get(key) ?? [];
    group.push(tx);
    purchases.set(key, group);
  }

  const candidates = new Map<string, ParsedTx[]>();
  const refundCounts = new Map<string, number>();
  for (const tx of unique.values()) {
    if (tx.direction !== "in" || tx.eventType !== "refund") continue;
    const key = matchKey(tx, tx.amount);
    if (!key) continue;
    const matches = (purchases.get(key) ?? []).filter((purchase) => paidBefore(purchase, tx));
    if (!matches.length) continue;
    candidates.set(tx.id, matches);
    for (const purchase of matches) refundCounts.set(purchase.id, (refundCounts.get(purchase.id) ?? 0) + 1);
  }

  const pairs = new Map<string, string>();
  for (const [refundId, matches] of candidates) {
    if (matches.length !== 1 || refundCounts.get(matches[0].id) !== 1) continue;
    const purchaseId = matches[0].id;
    pairs.set(purchaseId, refundId);
    pairs.set(refundId, purchaseId);
  }
  return pairs;
}

export function syncWechatRefunds(txs: readonly ParsedTx[]): boolean {
  const pairs = matchWechatRefunds(txs);
  if (!pairs.size && !txs.some((tx) => tx.refundReviewMode === "follow-purchase")) return false;
  const byId = new Map(txs.map((tx) => [tx.id, tx]));
  let changed = false;
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

    const funded = [purchase.fundingAccount, refund.fundingAccount].every((account) => /^(Assets|Liabilities):/.test(account));
    const status = funded && !isSuspectedDuplicate(refund) ? "ready" : "pending";
    if (following && refund.finalAccount === purchase.finalAccount && refund.status === status) continue;
    refund.finalAccount = purchase.finalAccount;
    refund.status = status;
    refund.refundReviewMode = "follow-purchase";
    changed = true;
  }
  return changed;
}
