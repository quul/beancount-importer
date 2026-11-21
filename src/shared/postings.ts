import { defaultNarration, type DraftPosting, type ParsedTx } from "./types.js";

export const accountPattern = /^(Assets|Liabilities|Equity|Income|Expenses)(?::[\p{Lu}\p{Nd}][\p{L}\p{Nd}-]*)+$/u;
const isPostingAccount = (account: string) => accountPattern.test(account) && !/(?:^|:)(FixMe|Unknown)(?::|$)/i.test(account);
export const currencyPattern = /^[A-Z][A-Z0-9._'-]*$/;
export const amountText = (amount: number) => (Object.is(amount, -0) ? 0 : amount).toFixed(8).replace(/(\.\d{2}\d*?)0+$/, "$1");
export const validDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const quote = (value: string) => JSON.stringify(value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, " "));

/** An income source is credited, while an incoming refund reverses the original funding leg. */
export function fundingPostingSign(tx: Pick<ParsedTx, "direction" | "eventType" | "fundingAccount">): 1 | -1 {
  const incomeSource = tx.fundingAccount?.startsWith("Income:") && tx.eventType !== "refund";
  return tx.direction === "in" && !incomeSource ? 1 : -1;
}

export function transactionPostings(tx: ParsedTx): DraftPosting[] {
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
  if (tx.postings) return tx.postings.length < 2 || tx.postings.some(({ account }) => !isPostingAccount(account)) ? "postings" : undefined;
  if (!isPostingAccount(tx.fundingAccount)) return "funding";
  if (!isPostingAccount(tx.fundingAccount2 || tx.finalAccount)) return "category";
}

export function statusAfterCategorization(tx: ParsedTx): ParsedTx["status"] {
  if (!missingPostingAccount(tx)) return "ready";
  return tx.status === "ready" ? "pending" : tx.status;
}

export function validateTransaction(tx: ParsedTx, postings: DraftPosting[]): string[] {
  const errors: string[] = [];
  if (!validDate(tx.date)) errors.push("交易日期无效");
  if (tx.excludedReason) errors.push(`原始流水不可入账：${tx.excludedReason}`);
  if (!Number.isFinite(tx.amount) || tx.amount < 0 || (!tx.merge && tx.amount === 0)) errors.push("交易金额须大于零");
  if (!tx.postings && (tx.fundingParts?.length ?? 0) > 1) errors.push("请拆分组合支付");
  if (!tx.postings && tx.eventType === "refund" && tx.finalAccount.startsWith("Income:")) errors.push("请冲回原费用");
  if (!tx.postings && tx.eventType === "transfer" && !/^(Assets|Liabilities):/.test(tx.fundingAccount2 || tx.finalAccount)) errors.push("请选择转账对方账户");
  if (postings.length < 2) errors.push("至少需要两条分录");
  if (new Set(postings.map((posting) => posting.account)).size < 2) errors.push("资金账户与对方账户不能相同");
  const totals = new Map<string, number>();
  for (const posting of postings) {
    if (!isPostingAccount(posting.account)) errors.push(`账户无效或尚未确认：${posting.account}`);
    if (!currencyPattern.test(posting.currency)) errors.push(`币种无效：${posting.currency}`);
    if (!Number.isFinite(posting.amount)) errors.push("分录金额不是有效数字");
    else totals.set(posting.currency, (totals.get(posting.currency) ?? 0) + Number(posting.amount.toFixed(8)));
  }
  for (const [currency, total] of totals) if (Math.abs(total) > 0.0000001) errors.push(`${currency} 分录不平衡，差额 ${amountText(total)}`);
  if (tx.flag && tx.flag !== "*" && tx.flag !== "!") errors.push("交易标记无效");
  for (const tag of tx.tags ?? []) if (!/^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(tag)) errors.push(`标签无效：${tag}`);
  return [...new Set(errors)];
}

export function formatTransactionHeader(tx: ParsedTx): string {
  const tags = [...new Set(tx.tags ?? [])].map((tag) => ` #${tag}`).join("");
  const narration = tx.narration ?? defaultNarration(tx);
  return `${tx.date} ${tx.flag ?? "*"} ${quote(tx.payee || "未知交易方")} ${quote(narration)}${tags}`;
}

export function formatPosting(posting: DraftPosting): string {
  return `  ${posting.account}  ${amountText(posting.amount)} ${posting.currency}`;
}

export function formatTransactionEntry(tx: ParsedTx, postings: readonly DraftPosting[], batchId?: string): string {
  const lines = [formatTransactionHeader(tx)];
  const metadata: Record<string, string> = {
    "import-source": tx.source, "import-row-id": tx.id,
    ...(tx.sourceTxId ? { "import-id": tx.sourceTxId } : {}), ...(tx.sourceFileHash ? { "source-file-hash": tx.sourceFileHash } : {}),
    "source-file": tx.sourceFile, "import-event": tx.eventType ?? (tx.direction === "in" ? "income" : "expense"),
    ...(batchId ? { "import-batch": batchId } : {}), ...(tx.time ? { time: tx.time } : {}),
    ...(tx.sourceStatus ? { "source-status": tx.sourceStatus } : {}), ...(tx.originalDirection ? { "source-direction": tx.originalDirection } : {}),
    ...(tx.rawAccount ? { "source-account": tx.rawAccount } : {}), ...(tx.reviewNote ? { "review-note": tx.reviewNote } : {}),
    ...(tx.merge ? { "import-members": JSON.stringify(tx.merge.originals) } : {}),
  };
  for (const [key, value] of Object.entries(metadata)) lines.push(`  ${key}: ${quote(value)}`);
  lines.push(`  source-row: ${tx.row}`);
  for (const posting of postings) lines.push(formatPosting(posting));
  return lines.join("\n");
}
