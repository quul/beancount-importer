import { originalForeignAmount } from "./settlement.js";
import { isFamilyCard, type ParsedTx } from "./types.js";

export function isCurrencyExchangePayment(tx: ParsedTx): boolean {
  return tx.currency === "CNY" && tx.direction === "out" && Number.isFinite(tx.amount) && tx.amount > 0
    && !tx.merge && !tx.postings && !tx.cnySettlement && !originalForeignAmount(tx)
    && !isFamilyCard(tx) && (tx.fundingParts?.length ?? 0) <= 1;
}

export function canSetCurrencyExchange(tx: ParsedTx): boolean {
  const reviewable = tx.status === "pending" || tx.status === "ready"
    || (tx.status === "excluded" && tx.reviewExclusion !== "deduplicate");
  return isCurrencyExchangePayment(tx) && reviewable
    && !tx.excludedReason && !tx.duplicateOf?.refundCopy && !tx.reviewConflictId;
}

export function readExchangeQuantity(value: unknown): number | undefined {
  if (typeof value !== "string") return;
  const text = value.trim().normalize("NFKC");
  if (!/^\d{1,12}(?:\.\d{1,8})?$/.test(text)) return;
  const [whole, fraction = ""] = text.split(".");
  const amount = Number(text);
  if (amount > 0 && amount.toFixed(8) === `${whole.replace(/^0+(?=\d)/, "")}.${fraction.padEnd(8, "0")}`) return amount;
}
