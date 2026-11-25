import type { ParsedTx, RawTx } from "./types.js";

export const CNY_SETTLEMENT_REQUIRED = "请先确认人民币金额";

export function originalForeignAmount(tx: Pick<RawTx, "amount" | "currency" | "originalAmount">) {
  return tx.originalAmount ?? (tx.currency !== "CNY" ? { amount: tx.amount, currency: tx.currency } : undefined);
}

export function needsCnySettlement(tx: Pick<ParsedTx, "requireCnySettlement" | "currency" | "postings">): boolean {
  return Boolean(tx.requireCnySettlement && (tx.currency !== "CNY" || tx.postings?.some(({ currency }) => currency !== "CNY")));
}

export function readPositiveCnyAmount(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^\d{1,12}(?:\.\d{1,2})?$/.test(value.trim())) return;
  const amount = Number(value);
  if (amount > 0) return amount;
}
