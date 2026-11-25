import { isFundingAccount } from "./funding.js";
import { validDate } from "./postings.js";
import { needsCnySettlement } from "./settlement.js";
import type { ParsedTx, SplitChargeMatch } from "./types.js";

export function splitChargeKind(tx: ParsedTx): "debit" | "refund" | undefined {
  if ((tx.status !== "ready" && tx.status !== "pending") || tx.excludedReason || tx.reviewConflictId || tx.merge
    || tx.postings || tx.currencyExchange || tx.fundingAccount2 || (tx.fundingParts?.length ?? 0) > 1
    || !isFundingAccount(tx.fundingAccount) || !validDate(tx.date) || !Number.isFinite(tx.amount) || tx.amount <= 0
    || needsCnySettlement(tx) || tx.eventType === "transfer") return;
  if (tx.direction === "out" && (!tx.eventType || tx.eventType === "expense" || tx.eventType === "unknown")) return "debit";
  if (tx.direction === "in" && (tx.eventType === "refund"
    || /退款|退货|退差价|退回|冲正|撤销/.test([tx.payee, tx.note, tx.rawCategory].join(" ")))) return "refund";
}

export function splitChargeMemberIds(match: SplitChargeMatch): string[] {
  return [match.original.id, ...(match.refund ? [match.refund.id] : []), ...match.parts.map(({ id }) => id)];
}

export function mayHaveSplitCharges(txs: readonly ParsedTx[], { requireRefund = false } = {}): boolean {
  const debits = new Map<string, number>(), refunds = new Set<string>();
  for (const tx of txs) {
    const kind = splitChargeKind(tx);
    if (!kind) continue;
    const key = JSON.stringify([tx.fundingAccount, tx.currency]);
    if (kind === "refund") refunds.add(key);
    else debits.set(key, (debits.get(key) ?? 0) + 1);
  }
  return [...debits].some(([key, count]) => (count >= 3 && !requireRefund) || (count >= 2 && refunds.has(key)));
}
