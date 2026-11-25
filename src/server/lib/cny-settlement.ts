import { normalizePaymentMethod } from "../../shared/funding.js";
import { needsCnySettlement, originalForeignAmount } from "../../shared/settlement.js";
import { activeTransactions, sourceKey } from "../../shared/transactionMerge.js";
import type { CnyRepaymentChoice, ParsedTx } from "../../shared/types.js";
import { normalizeStatementCurrency, parseAmount } from "../parsers/common.js";
import type { StoredBatch } from "./batches.js";

// Older PDF drafts retained the original currency in their source narration.
export function applyCnyReview(tx: ParsedTx): boolean {
  tx.requireCnySettlement = true;
  if (!tx.originalAmount && !tx.merge) {
    tx.currency = normalizeStatementCurrency(tx.currency);
    const foreign = originalForeignAmount(tx);
    const legacy = tx.source === "bank-generic" && /^招商银行交易流水/.test(tx.sourceFile)
      ? tx.note.match(/^\d{4}-\d{2}-\d{2}\s+([A-Z]{3,5})\s+([+−-]?[\d,]+\.\d{2})\s/) : null;
    const amount = legacy && legacy[1] !== "CNY" ? parseAmount(legacy[2].replace("−", "-")) : null;
    if (legacy && amount !== null && Math.abs(amount) === tx.amount) {
      tx.currency = legacy[1];
      tx.direction = amount > 0 ? "in" : "out";
      tx.originalAmount = { amount: Math.abs(amount), currency: legacy[1] };
    } else if (foreign) {
      tx.originalAmount = foreign;
    } else if (tx.source.startsWith("bank-") && /\.pdf$/i.test(tx.sourceFile)) {
      const original = tx.note.match(/ · 原交易\s+([A-Z]{3,5})\s*([+−-]?[\d,]+(?:\.\d+)?)$/);
      const value = original && original[1] !== "CNY" ? parseAmount(original[2].replace("−", "-")) : null;
      if (original && value !== null) tx.originalAmount = { amount: Math.abs(value), currency: original[1] };
    }
  }
  if (tx.status !== "ready" || !needsCnySettlement(tx)) return false;
  tx.status = "pending";
  return true;
}

function sameCard(a: ParsedTx, b: ParsedTx): boolean {
  const card = normalizePaymentMethod(a.rawAccount);
  const otherCard = normalizePaymentMethod(b.rawAccount);
  const hasSuffix = /信用卡\(\d{4}\)$/;
  if (hasSuffix.test(card) && hasSuffix.test(otherCard)) return card === otherCard;
  return a.fundingAccount.startsWith("Liabilities:") && a.fundingAccount === b.fundingAccount;
}

export function cnyRepayments(target: ParsedTx, batches: readonly StoredBatch[], ledgerProfile: string): CnyRepaymentChoice[] {
  const related = batches.filter((batch) => batch.ledgerProfile === ledgerProfile && !batch.mergedInto);
  const identity = (tx: ParsedTx) => sourceKey(tx.source, tx.sourceTxId, tx.sourceFileHash, tx.row);
  const targetKey = identity(target);
  const allocations = new Map<string, { repaymentKey: string; cents: number }>();
  for (const { batchId, txs, committed } of related) {
    const posted = committed ? new Set(activeTransactions(txs).filter(({ status }) => status === "ready")
      .flatMap((tx) => tx.merge?.originals.map(({ id }) => id) ?? [tx.id])) : undefined;
    for (const tx of txs) {
      const repayment = tx.cnySettlement?.repayment;
      if (!repayment || tx.status === "duplicate" || (posted && !posted.has(tx.id))) continue;
      const buyer = identity(tx);
      if (buyer ? buyer === targetKey : tx.id === target.id) continue;
      const key = JSON.stringify([repayment.key, buyer ?? `${batchId}:${tx.id}`]);
      const cents = Math.round(tx.amount * 100);
      if (cents > (allocations.get(key)?.cents ?? 0)) allocations.set(key, { repaymentKey: repayment.key, cents });
    }
  }
  const allocated = new Map<string, number>();
  for (const { repaymentKey, cents } of allocations.values()) {
    allocated.set(repaymentKey, (allocated.get(repaymentKey) ?? 0) + cents);
  }
  const choices = new Map<string, CnyRepaymentChoice>();
  for (const { batchId, txs } of related) for (const tx of activeTransactions(txs)) {
    if (tx.date < target.date || tx.currency !== "CNY" || tx.direction !== "in" || tx.eventType !== "transfer"
      || tx.excludedReason || tx.status === "excluded" || tx.status === "duplicate" || tx.cnySettlement
      || !/还款/.test(`${tx.payee} ${tx.note}`) || !sameCard(target, tx)) continue;
    const key = identity(tx);
    if (!key || choices.has(key)) continue;
    const remaining = (Math.round(tx.amount * 100) - (allocated.get(key) ?? 0)) / 100;
    if (remaining <= 0) continue;
    choices.set(key, { key, batchId, txId: tx.id, date: tx.date, amount: tx.amount,
      payee: tx.payee, sourceFile: tx.sourceFile, row: tx.row, remaining });
  }
  return [...choices.values()].sort((a, b) => a.date.localeCompare(b.date) || a.row - b.row);
}
