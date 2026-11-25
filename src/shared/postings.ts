import { defaultNarration, reviewPayeeText, type DraftPosting, type ParsedTx, type ReviewProblem } from "./types.js";
import { CNY_SETTLEMENT_REQUIRED, needsCnySettlement, originalForeignAmount } from "./settlement.js";
import { isCurrencyExchangePayment, readExchangeQuantity } from "./currency-exchange.js";

export const FUNDING_SPLIT_REQUIRED = "请拆分组合支付";
export const requiresFundingSplit = (tx: ParsedTx) => !tx.postings && (tx.fundingParts?.length ?? 0) > 1;

export const accountPattern = /^(Assets|Liabilities|Equity|Income|Expenses)(?::[\p{Lu}\p{Nd}][\p{L}\p{Nd}-]*)+$/u;
const isPostingAccount = (account: string) => accountPattern.test(account) && !/(?:^|:)(FixMe|Unknown)(?::|$)/i.test(account);
export const isExchangeAssetAccount = (account: string) => account.startsWith("Assets:") && isPostingAccount(account);
export const isExchangeFundingAccount = (account: string) => /^(Assets|Liabilities):/.test(account) && isPostingAccount(account);
export const currencyPattern = /^[A-Z][A-Z0-9._'-]*$/;
export const isExchangeCurrency = (currency: string) => currency !== "CNY" && currency.length <= 24
  && currencyPattern.test(currency) && /[A-Z0-9]$/.test(currency);
export const amountText = (amount: number) => (Object.is(amount, -0) ? 0 : amount).toFixed(8).replace(/(\.\d{2}\d*?)0+$/, "$1");
export const validDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const quote = (value: string) => JSON.stringify(value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, " "));

/** An income source is credited, while an incoming refund reverses the original funding leg. */
export function fundingPostingSign(tx: Pick<ParsedTx, "direction" | "eventType" | "fundingAccount">): 1 | -1 {
  const incomeSource = tx.fundingAccount?.startsWith("Income:") && tx.eventType !== "refund";
  return tx.direction === "in" && !incomeSource ? 1 : -1;
}

export function transactionPostings(tx: ParsedTx): DraftPosting[] {
  if (tx.currencyExchange) {
    const { account, amount, currency } = tx.currencyExchange;
    return [{ account: tx.fundingAccount, amount: -tx.amount, currency: "CNY" }, { account, amount, currency }];
  }
  if (tx.postings) return tx.postings;
  const amount = tx.amount, currency = tx.currency;
  if (tx.fundingAccount2) return [{ account: tx.fundingAccount, amount: -amount, currency }, { account: tx.fundingAccount2, amount, currency }];
  const fundingAmount = fundingPostingSign(tx) * amount;
  return [{ account: tx.fundingAccount, amount: fundingAmount, currency }, { account: tx.finalAccount, amount: -fundingAmount, currency }];
}

export const missingPostingAccountMessage = {
  funding: "请先选择资金账户",
  category: "请先选择分类账户",
  postings: "请先补齐分录账户",
};

export function missingPostingAccount(tx: ParsedTx): keyof typeof missingPostingAccountMessage | undefined {
  if (tx.currencyExchange) {
    if (!isExchangeFundingAccount(tx.fundingAccount)) return "funding";
    return isExchangeAssetAccount(tx.currencyExchange.account) ? undefined : "category";
  }
  if (tx.postings) return tx.postings.length < 2 || tx.postings.some(({ account }) => !isPostingAccount(account)) ? "postings" : undefined;
  if (requiresFundingSplit(tx)) return "postings";
  if (!isPostingAccount(tx.fundingAccount)) return "funding";
  if (!isPostingAccount(tx.fundingAccount2 || tx.finalAccount)) return "category";
}

export function statusAfterCategorization(tx: ParsedTx): ParsedTx["status"] {
  if (!needsCnySettlement(tx) && !missingPostingAccount(tx)) return "ready";
  return tx.status === "ready" ? "pending" : tx.status;
}

export function transactionReviewProblems(tx: ParsedTx, postings: DraftPosting[]): ReviewProblem[] {
  const problems: ReviewProblem[] = [];
  const add = (message: string, field?: ReviewProblem["field"]) => {
    if (!problems.some((problem) => problem.field === field && problem.message === message)) problems.push({ id: tx.id, field, message });
  };
  if (!validDate(tx.date)) add("交易日期无效");
  if (needsCnySettlement(tx)) add(CNY_SETTLEMENT_REQUIRED, "settlement");
  if (tx.excludedReason) add(`原始流水不可入账：${tx.excludedReason}`);
  if (!Number.isFinite(tx.amount) || tx.amount < 0 || (!tx.merge && tx.amount === 0)) add("交易金额须大于零");
  if (requiresFundingSplit(tx)) add(FUNDING_SPLIT_REQUIRED, "postings");
  if (postings.length < 2) add("至少需要两条分录", "postings");
  const exchange = tx.currencyExchange;
  const [payment, receipt] = postings;
  const exchangeValid = exchange && isCurrencyExchangePayment(tx) && postings.length === 2
    && isExchangeFundingAccount(tx.fundingAccount) && isExchangeAssetAccount(exchange.account)
    && tx.fundingAccount !== exchange.account && isExchangeCurrency(exchange.currency)
    && Number.isFinite(exchange.amount) && readExchangeQuantity(amountText(exchange.amount)) === exchange.amount
    && payment?.account === tx.fundingAccount && payment.currency === "CNY" && payment.amount === -tx.amount
    && receipt?.account === exchange.account && receipt.currency === exchange.currency && receipt.amount === exchange.amount;
  if (exchange && !exchangeValid) add("请核对货币兑换分录", "exchange");
  const sameAccount = new Set(postings.map((posting) => posting.account)).size < 2;
  if (sameAccount && postings.every(({ account }) => isPostingAccount(account))) {
    add("资金账户与对方账户不能相同", tx.postings ? "postings" : "category");
  }
  const totals = new Map<string, number>();
  for (const [index, posting] of postings.entries()) {
    if (!isPostingAccount(posting.account)) {
      const field = tx.postings ? "postings" : index === 0 ? "funding" : "category";
      add(posting.account ? `请选择有效账户（${posting.account}）` : missingPostingAccountMessage[field], field);
    }
    if (!currencyPattern.test(posting.currency)) add(`币种无效：${posting.currency}`, tx.postings ? "postings" : undefined);
    if (!Number.isFinite(posting.amount)) add("分录金额不是有效数字", tx.postings ? "postings" : undefined);
    else {
      const weight = exchangeValid && index === 1 ? { currency: "CNY", amount: tx.amount } : posting;
      totals.set(weight.currency, (totals.get(weight.currency) ?? 0) + Number(weight.amount.toFixed(8)));
    }
  }
  for (const [currency, total] of totals) if (Math.abs(total) > 0.0000001) add(`${currency} 分录不平衡，差额 ${amountText(total)}`, "postings");
  if (tx.flag && tx.flag !== "*" && tx.flag !== "!") add("交易标记无效");
  for (const tag of tx.tags ?? []) if (!/^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(tag)) add(`标签无效：${tag}`, "tags");
  return problems;
}

export function validateTransaction(tx: ParsedTx, postings: DraftPosting[]): string[] {
  return [...new Set(transactionReviewProblems(tx, postings).map(({ message }) => message))];
}

export function formatTransactionHeader(tx: ParsedTx): string {
  const tags = [...new Set(tx.tags ?? [])].map((tag) => ` #${tag}`).join("");
  const narration = tx.narration ?? defaultNarration(tx);
  return `${tx.date} ${tx.flag ?? "*"} ${quote(reviewPayeeText(tx) || "未知交易方")} ${quote(narration)}${tags}`;
}

export function formatPosting(posting: DraftPosting): string {
  return `  ${posting.account}  ${amountText(posting.amount)} ${posting.currency}`;
}

export function formatTransactionEntry(tx: ParsedTx, postings: readonly DraftPosting[], batchId?: string): string {
  const lines = [formatTransactionHeader(tx)];
  const metadata: Record<string, string> = {
    "import-source": tx.source, "import-row-id": tx.id,
    ...(tx.sourceTxId ? { "import-id": tx.sourceTxId } : {}), ...(tx.sourceFileHash ? { "source-file-hash": tx.sourceFileHash } : {}),
    ...(tx.orderId ? { "source-order-id": tx.orderId } : {}),
    ...(tx.reviewPayee !== undefined ? { "source-payee": tx.payee } : {}),
    "source-file": tx.sourceFile, "import-event": tx.eventType ?? (tx.direction === "in" ? "income" : "expense"),
    ...(batchId ? { "import-batch": batchId } : {}), ...(tx.time ? { time: tx.time } : {}),
    ...(tx.sourceStatus ? { "source-status": tx.sourceStatus } : {}), ...(tx.originalDirection ? { "source-direction": tx.originalDirection } : {}),
    ...(tx.rawAccount ? { "source-account": tx.rawAccount } : {}), ...(tx.reviewNote ? { "review-note": tx.reviewNote } : {}),
    ...(tx.merge ? { "import-members": JSON.stringify(tx.merge.originals) } : {}),
  };
  for (const [key, value] of Object.entries(metadata)) lines.push(`  ${key}: ${quote(value)}`);
  const originalAmount = tx.merge ? undefined : originalForeignAmount(tx);
  if (originalAmount && originalAmount.currency !== "CNY" && Number.isFinite(originalAmount.amount)
    && currencyPattern.test(originalAmount.currency)) {
    lines.push(`  original-amount: ${amountText(originalAmount.amount)} ${originalAmount.currency}`);
    if (tx.currency === "CNY") {
      lines.push(`  settlement-source: ${quote(tx.cnySettlement?.method ?? "statement")}`);
      const repayment = tx.cnySettlement?.repayment;
      if (repayment) lines.push(`  settlement-repayment: ${quote(JSON.stringify(repayment))}`);
    }
  }
  lines.push(`  source-row: ${tx.row}`);
  for (const [index, posting] of postings.entries()) {
    const cost = tx.currencyExchange && index === 1 ? ` {{${amountText(tx.amount)} CNY}}` : "";
    lines.push(formatPosting(posting) + cost);
  }
  return lines.join("\n");
}
