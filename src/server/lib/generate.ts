/** Generate only reviewed, balanced transactions; provenance makes later imports auditable. */
import type { DraftPosting, GenerateResult, ParsedTx } from "../../shared/types.js";

const accountPattern = /^(Assets|Liabilities|Equity|Income|Expenses)(?::[A-Za-z0-9-]+)+$/;
const currencyPattern = /^[A-Z][A-Z0-9._'-]*$/;
const quote = (value: string) => JSON.stringify(value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, " "));
const amountText = (amount: number) => (Object.is(amount, -0) ? 0 : amount).toFixed(8).replace(/(\.\d{2}\d*?)0+$/, "$1");
const validDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

export function transactionPostings(tx: ParsedTx): DraftPosting[] {
  if (tx.postings) return tx.postings;
  const amount = tx.amount, currency = tx.currency;
  if (tx.fundingAccount2) return [{ account: tx.fundingAccount, amount: -amount, currency }, { account: tx.fundingAccount2, amount, currency }];
  const fundingAmount = tx.direction === "in" ? amount : -amount;
  return [{ account: tx.fundingAccount, amount: fundingAmount, currency }, { account: tx.finalAccount, amount: -fundingAmount, currency }];
}

function validate(tx: ParsedTx, postings: DraftPosting[]): string[] {
  const errors: string[] = [];
  if (!validDate(tx.date)) errors.push("交易日期无效");
  if (tx.excludedReason) errors.push(`原始流水不可入账：${tx.excludedReason}`);
  if (!Number.isFinite(tx.amount) || tx.amount <= 0) errors.push("交易金额须大于零");
  if (!tx.postings && (tx.fundingParts?.length ?? 0) > 1) errors.push("组合付款需确认完整分录及优惠分摊");
  if (!tx.postings && tx.eventType === "refund" && tx.finalAccount.startsWith("Income:")) errors.push("退款请冲回原费用，不应自动归入收入");
  if (!tx.postings && tx.eventType === "transfer" && !/^(Assets|Liabilities):/.test(tx.fundingAccount2 || tx.finalAccount)) errors.push("资金转移需指定双方资产或负债账户");
  if (postings.length < 2) errors.push("至少需要两条分录");
  if (new Set(postings.map((posting) => posting.account)).size < 2) errors.push("资金账户与对方账户不能相同");
  const totals = new Map<string, number>();
  for (const posting of postings) {
    if (!accountPattern.test(posting.account) || /(?:^|:)(FixMe|Unknown)(?::|$)/i.test(posting.account)) errors.push(`账户无效或尚未确认：${posting.account}`);
    if (!currencyPattern.test(posting.currency)) errors.push(`币种无效：${posting.currency}`);
    if (!Number.isFinite(posting.amount)) errors.push("分录金额不是有效数字");
    else totals.set(posting.currency, (totals.get(posting.currency) ?? 0) + Number(posting.amount.toFixed(8)));
  }
  for (const [currency, total] of totals) if (Math.abs(total) > 0.0000001) errors.push(`${currency} 分录不平衡，差额 ${amountText(total)}`);
  if (tx.flag && tx.flag !== "*" && tx.flag !== "!") errors.push("交易标记无效");
  for (const tag of tx.tags ?? []) if (!/^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(tag)) errors.push(`标签无效：${tag}`);
  return [...new Set(errors)];
}

export function generateEntries(txs: ParsedTx[], batchId?: string): GenerateResult {
  const monthFiles: Record<string, string> = {}, generated: string[] = [], errors: string[] = [];
  const ready = txs.filter((tx) => tx.status === "ready").sort((a, b) => `${a.date}|${a.time ?? ""}|${a.id}`.localeCompare(`${b.date}|${b.time ?? ""}|${b.id}`));
  for (const tx of ready) {
    const postings = transactionPostings(tx), validation = validate(tx, postings);
    if (validation.length) { errors.push(...validation.map((error) => `${tx.sourceFile}:${tx.row} ${error}`)); continue; }
    const tags = [...new Set(tx.tags ?? [])].map((tag) => ` #${tag}`).join("");
    const narration = [...new Set([tx.note, tx.rawCategory].filter(Boolean))].join(" · ");
    const lines = [`${tx.date} ${tx.flag ?? "*"} ${quote(tx.payee || "未知交易方")} ${quote(narration)}${tags}`];
    const metadata: Record<string, string> = {
      "import-source": tx.source, "import-row-id": tx.id,
      ...(tx.sourceTxId ? { "import-id": tx.sourceTxId } : {}), ...(tx.sourceFileHash ? { "source-file-hash": tx.sourceFileHash } : {}),
      "source-file": tx.sourceFile, "import-event": tx.eventType ?? (tx.direction === "in" ? "income" : "expense"),
      ...(batchId ? { "import-batch": batchId } : {}), ...(tx.time ? { time: tx.time } : {}),
      ...(tx.sourceStatus ? { "source-status": tx.sourceStatus } : {}), ...(tx.originalDirection ? { "source-direction": tx.originalDirection } : {}),
      ...(tx.rawAccount ? { "source-account": tx.rawAccount } : {}), ...(tx.reviewNote ? { "review-note": tx.reviewNote } : {}),
    };
    for (const [key, value] of Object.entries(metadata)) lines.push(`  ${key}: ${quote(value)}`);
    lines.push(`  source-row: ${tx.row}`);
    for (const posting of postings) lines.push(`  ${posting.account}  ${amountText(posting.amount)} ${posting.currency}`);
    const month = tx.date.slice(0, 7).replace("-", "");
    monthFiles[month] = (monthFiles[month] ?? "") + lines.join("\n") + "\n\n";
    generated.push(tx.id);
  }
  // Running balances are not automatically day-end balances. An adapter/reviewer
  // must explicitly certify full-day coverage, and all relevant rows must be resolved.
  const balances = new Map<string, ParsedTx[]>();
  for (const tx of txs) {
    if (!tx.source.startsWith("bank-") || tx.balanceAfter == null || !tx.balanceIsDayEnd) continue;
    const key = `${tx.date}|${tx.fundingAccount}|${tx.currency}`;
    const list = balances.get(key) ?? []; list.push(tx); balances.set(key, list);
  }
  for (const group of balances.values()) {
    const tx = group[0];
    if (group.some((other) => other.balanceAfter !== tx.balanceAfter) || !validDate(tx.date) || !accountPattern.test(tx.fundingAccount) || !currencyPattern.test(tx.currency) || !Number.isFinite(tx.balanceAfter)) continue;
    if (txs.some((other) => other.date === tx.date && other.fundingAccount === tx.fundingAccount && other.currency === tx.currency && other.status !== "duplicate" && !generated.includes(other.id))) continue;
    if (tx.status !== "ready" || !generated.includes(tx.id) || !transactionPostings(tx).some((posting) => posting.account === tx.fundingAccount && posting.currency === tx.currency)) continue;
    const nextDay = new Date(Date.parse(`${tx.date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
    const month = nextDay.slice(0, 7).replace("-", "");
    monthFiles[month] = (monthFiles[month] ?? "") + `${nextDay} balance ${tx.fundingAccount} ${amountText(tx.balanceAfter!)} ${tx.currency}\n\n`;
  }
  const sortedMonths = Object.fromEntries(Object.entries(monthFiles).sort(([a], [b]) => a.localeCompare(b)));
  return { entries: Object.entries(sortedMonths).map(([month, body]) => `; ===== ${month} =====\n${body}`).join("\n"), monthFiles: sortedMonths, generated, errors };
}

/** Open each new account no later than its earliest referenced transaction. */
export function suggestOpens(txs: ParsedTx[], existingAccounts: Set<string>): string[] {
  const earliest = new Map<string, string>();
  for (const tx of txs) {
    if (tx.status !== "ready" || !validDate(tx.date)) continue;
    for (const posting of transactionPostings(tx)) if (accountPattern.test(posting.account) && !existingAccounts.has(posting.account)) {
      const previous = earliest.get(posting.account); if (!previous || tx.date < previous) earliest.set(posting.account, tx.date);
    }
  }
  return [...earliest].sort(([a], [b]) => a.localeCompare(b)).map(([account, date]) => `${date} open ${account}`);
}
