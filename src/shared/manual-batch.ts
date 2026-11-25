import { accountIsActive, isFundingAccount } from "./funding.js";
import { isExchangeCurrency, validDate } from "./postings.js";
import { readPositiveCnyAmount } from "./settlement.js";
import { readExchangeQuantity } from "./currency-exchange.js";
import type { ParsedAccount } from "./types.js";

export const MANUAL_BATCH_LABEL = "手动录入";
export const MAX_MANUAL_ROWS = 500;
export const MAX_MANUAL_DESCRIPTION = 500;
export const DEFAULT_MANUAL_CURRENCY = "CNY";
export const isManualCurrency = (value: string) => value === DEFAULT_MANUAL_CURRENCY || isExchangeCurrency(value);

export interface ManualTransactionInput {
  date: string;
  amount: string;
  currency?: string;
  description: string;
  fundingAccount?: string;
}

export interface ManualBatchInput {
  batchId: string;
  ledgerProfile: string;
  fundingAccount: string;
  rows: ManualTransactionInput[];
}

export function manualFundingProblem(account: ParsedAccount | undefined, date?: string, currency?: string): string {
  if (!account || !isFundingAccount(account.account)) {
    return "请选择账本中的资产、负债或收入账户";
  }
  const currencies = account.currencies ?? (account.currency ? [account.currency] : []);
  if (currency && currencies.length && !currencies.includes(currency)) return "此账户不支持 " + currency;
  if (date && !accountIsActive(account, date)) return "此账户在交易日未生效";
  return "";
}

export function validateManualTransaction(row: ManualTransactionInput, account: ParsedAccount | undefined, requireCnySettlement = false) {
  const date = validDate(row.date) ? "" : "请输入有效的交易日期";
  const currency = row.currency ?? DEFAULT_MANUAL_CURRENCY;
  const currencyProblem = isManualCurrency(currency) ? "" : "请输入有效的币种代码";
  const cny = currency === DEFAULT_MANUAL_CURRENCY;
  const signedAmount = row.amount.normalize("NFKC").trim().replace(/^−/, "-");
  const isRefund = signedAmount.startsWith("-");
  const magnitude = isRefund ? signedAmount.slice(1) : signedAmount;
  const absoluteAmount = magnitude !== magnitude.trimStart() ? undefined
    : cny ? readPositiveCnyAmount(magnitude) : readExchangeQuantity(magnitude);
  const amount = absoluteAmount === undefined ? undefined : isRefund ? -absoluteAmount : absoluteAmount;
  const fundingCurrency = requireCnySettlement ? DEFAULT_MANUAL_CURRENCY : currencyProblem ? undefined : currency;
  return {
    amount, signedAmount, currency,
    problems: {
      date,
      amount: amount === undefined ? "请输入非零金额，最多" + (cny ? "两" : "八") + "位小数。退款填负数。" : "",
      currency: currencyProblem,
      fundingAccount: manualFundingProblem(account, date ? undefined : row.date, fundingCurrency),
    },
  };
}
