import { accountPattern, amountText } from "./postings.js";
import type { CategoryAllocation, DraftPosting, ParsedTx } from "./types.js";

export const MAX_CATEGORY_ALLOCATIONS = 39;
const decimalAmount = /^[+-]?(?:\d{1,21}(?:\.\d{0,8})?|\.\d{1,8})$/;

export function amountUnits(value: string): bigint | undefined {
  if (!decimalAmount.test(value)) return;
  const [whole, fraction = ""] = value.replace(/^[+-]/, "").split(".");
  const units = BigInt(whole + fraction.padEnd(8, "0"));
  return value.startsWith("-") ? -units : units;
}

export function allocationAmountText(units: bigint): string {
  const digits = (units < 0n ? -units : units).toString().padStart(9, "0");
  const fraction = digits.slice(-8).replace(/0+$/, "").padEnd(2, "0");
  return `${units < 0n ? "-" : ""}${digits.slice(0, -8)}.${fraction}`;
}

export function supportsCategoryAllocations(tx: ParsedTx): boolean {
  return !tx.merge && !tx.excludedReason && tx.eventType !== "transfer" && !tx.fundingAccount2 && (tx.fundingParts?.length ?? 0) <= 1;
}

export function planCategoryAllocations(tx: ParsedTx, allocations: readonly CategoryAllocation[]) {
  const amounts = allocations.map(({ amount }) => {
    const text = amount.trim().normalize("NFKC");
    return { units: amountUnits(text), amount: Number(text) };
  });
  const target = amountUnits(amountText(tx.amount));
  const total = amounts.reduce((sum, { units }) => sum + (units ?? 0n), 0n);
  const remaining = (target ?? 0n) - total;
  let error: string | undefined;
  if (!supportsCategoryAllocations(tx)) error = "请在详情中核对这笔交易的分录";
  else if (target === undefined || target <= 0n || !allocations.length || allocations.length > MAX_CATEGORY_ALLOCATIONS) error = "交易金额或分类数量无效";
  else if (!/^(Assets|Liabilities):/.test(tx.fundingAccount)) error = "请选择资金账户";
  else if (allocations.some(({ account }) => !accountPattern.test(account) || account === tx.fundingAccount)) error = "请选择有效的分类账户";
  else if (tx.eventType === "refund" && allocations.some(({ account }) => account.startsWith("Income:"))) error = "退款请冲回原费用";
  else if (amounts.some(({ units, amount }) => units === undefined || amountUnits(amountText(amount)) !== units)) error = "请为每个分类填写有效金额";
  else if (remaining !== 0n) error = "分类金额合计须等于交易金额";
  const sign = tx.direction === "in" ? 1 : -1;
  const postings: DraftPosting[] | undefined = error ? undefined : [
    { account: tx.fundingAccount, amount: sign * tx.amount, currency: tx.currency },
    ...allocations.map(({ account }, index) => {
      const amount = amounts[index].amount;
      return { account, amount: amount === 0 ? 0 : -sign * amount, currency: tx.currency };
    }),
  ];
  return { total, remaining, error, postings };
}

export function savedCategoryAllocations(tx: ParsedTx): CategoryAllocation[] | undefined {
  if (!supportsCategoryAllocations(tx) || !tx.postings || tx.postings.length < 3) return;
  const sign = tx.direction === "in" ? 1 : -1;
  const funding = tx.postings.filter(({ account }) => account === tx.fundingAccount);
  if (funding.length !== 1 || amountText(funding[0].amount) !== amountText(sign * tx.amount)
    || tx.postings.some(({ currency }) => currency !== tx.currency)) return;
  const allocations = tx.postings.filter(({ account }) => account !== tx.fundingAccount)
    .map(({ account, amount }) => ({ account, amount: amountText(-sign * amount) }));
  if (!planCategoryAllocations(tx, allocations).error) return allocations;
}
