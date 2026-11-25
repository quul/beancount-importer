import { allocationAmountText, amountUnits } from "./categoryAllocations.js";
import { isFundingAccount } from "./funding.js";
import { amountText, transactionPostings, validateTransaction } from "./postings.js";
import { originalForeignAmount } from "./settlement.js";
import { isSuspectedDuplicate, type DraftPosting, type MergedSource, type ParsedTx } from "./types.js";

const assetOrLiability = /^(Assets|Liabilities):/;

export function activeTransactions(txs: readonly ParsedTx[]): ParsedTx[] {
  const mergedIds = new Set(txs.flatMap((tx) => tx.merge?.originals.map(({ id }) => id) ?? []));
  return txs.filter((tx) => !mergedIds.has(tx.id));
}

export function sourceKey(source?: string, id?: string, fileHash?: string, row?: string | number): string | undefined {
  if (!source) return undefined;
  if (id) return `${source}|id:${id}`;
  if (fileHash && row != null && /^\d+$/.test(String(row))) return `${source}|file:${fileHash}|row:${row}`;
  return undefined;
}

export function mergeSource(tx: ParsedTx): MergedSource {
  const { id, source, sourceTxId, sourceFile, sourceFileHash, row, date, time, amount, currency, direction, cnySettlement } = tx;
  const originalAmount = originalForeignAmount(tx);
  return { id, source, sourceTxId, sourceFile, sourceFileHash, row, date, time, amount, currency, direction,
    ...(originalAmount && { originalAmount }), ...(cnySettlement && { cnySettlement }) };
}

export function planTransactionMerge(members: readonly ParsedTx[], accounts: ReadonlySet<string>) {
  const errors: string[] = [];
  const warnings: string[] = [];
  const postings: DraftPosting[] = [];
  const totals = new Map<string, bigint>();
  const funds = new Set<string>();
  const incomeFundingTotals = new Map<string, bigint>();
  if (members.length < 2) errors.push("请选择至少两笔原交易");
  if (members.some((tx) => tx.merge)) errors.push("先撤销所选交易的现有合并，再选择原交易");
  if (members.some((tx) => tx.currencyExchange)) errors.push("货币兑换须单独入账");
  if (members.some((tx) => tx.refundCounterpartId)) errors.push("已配对的消费和退款按各自的日期记账");
  const keys = members.map((tx) => sourceKey(tx.source, tx.sourceTxId, tx.sourceFileHash, tx.row)).filter(Boolean);
  if (new Set(keys).size !== keys.length || members.some((tx) => tx.status === "duplicate" || isSuspectedDuplicate(tx)
    || tx.matches?.some(({ id }) => id.startsWith("batch:")))) {
    warnings.push("所选交易中有重复或疑似重复项，请核对原流水");
  }
  if (members.some((tx) => tx.status === "excluded")) warnings.push("所选交易中有已排除的流水，请核对是否纳入合并");

  for (const tx of members) {
    const legs = transactionPostings(tx);
    const funding = legs.filter(({ account }) => assetOrLiability.test(account) || (account === tx.fundingAccount && isFundingAccount(account)));
    const label = `${tx.date} ${tx.payee || "（无商户）"}`;
    const problem = legs.some(({ account }) => !account) || !funding.length
      ? "请先补齐资金账户和分类账户"
      : validateTransaction(tx, legs)[0];
    if (problem) errors.push(`${label} · ${problem}`);
    else if (legs.some(({ account }) => !accounts.has(account))) errors.push(`${label} · 请重新选择当前账本中的账户`);
    postings.push(...legs);
    for (const { account, amount, currency } of funding) {
      if (!amount) continue;
      funds.add(account);
      if (!account.startsWith("Income:")) continue;
      const units = amountUnits(amountText(amount));
      if (units !== undefined) incomeFundingTotals.set(currency, (incomeFundingTotals.get(currency) ?? 0n) + units);
    }
    const units = amountUnits(amountText(tx.amount));
    if (units === undefined) errors.push(`${label} · 金额无效`);
    else totals.set(tx.currency, (totals.get(tx.currency) ?? 0n) + (tx.direction === "in" ? units : -units));
  }

  const skipsPosting = funds.size === 1 && [...totals.values(), ...incomeFundingTotals.values()].every((units) => units === 0n);
  return { errors: [...new Set(errors)], warnings, postings, skipsPosting, funds: [...funds],
    totals: [...totals].map(([currency, amount]) => ({ currency, amount: Number(allocationAmountText(amount)) })) };
}
