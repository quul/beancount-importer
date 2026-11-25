import { isFamilyCard, type ParsedAccount, type ParsedTx } from "./types.js";

export const normalizePaymentMethod = (raw: string) => raw.trim().normalize("NFKC").toLowerCase();
export const isMissingPaymentMethod = (raw: string | undefined) => /^[\s/—-]*$/.test(normalizePaymentMethod(raw ?? ""));
export const isCombinedPayment = (tx: ParsedTx) => (tx.fundingParts?.length ?? 0) > 1 || /[&＆＋+]|组合支付|组合付款/.test(tx.rawAccount);

export function singlePaymentMethod(tx: ParsedTx): string {
  if (isFamilyCard(tx) || isCombinedPayment(tx)) return "";
  return isMissingPaymentMethod(tx.rawAccount) ? tx.recognition?.fundingMethod ?? "" : tx.rawAccount.trim();
}

/** Bank exports with no card label can only use the individual statement as their identity. */
export const isStatementOnlyPayment = (tx: ParsedTx, raw: string) =>
  tx.source.startsWith("bank-") && (/^(?:[A-Za-z]:)?[\\/]/.test(raw) || raw === tx.sourceFile);

export function reusablePaymentMethod(tx: ParsedTx): string {
  if (tx.source === "manual") return "";
  const raw = singlePaymentMethod(tx);
  return isStatementOnlyPayment(tx, raw) ? "" : raw;
}

export const isFundingAccount = (account: string) =>
  /^(Assets|Liabilities|Income):/.test(account) && !/(?:^|:)(FixMe|Unknown)(?::|$)/i.test(account);

export const hasFundingPosting = (tx: ParsedTx) =>
  !tx.postings || (Boolean(tx.fundingAccount) && tx.postings.some(({ account }) => account === tx.fundingAccount));

export function accountIsActive(account: ParsedAccount, date: string, currency?: string): boolean {
  if (account.openedAt && account.openedAt > date) return false;
  if (account.closedAt && account.closedAt < date) return false;
  const currencies = account.currencies ?? (account.currency ? [account.currency] : []);
  return !currency || !currencies.length || currencies.includes(currency);
}
