/** Generate only reviewed, balanced transactions; provenance makes later imports auditable. */
import type { GenerateResult, ParsedTx } from "../../shared/types.js";
import { accountPattern, amountText, currencyPattern, formatTransactionEntry, transactionPostings, validDate, validateTransaction } from "../../shared/postings.js";
import { activeTransactions } from "../../shared/transactionMerge.js";
import { loadWechatRules, wechatExclusionReason } from "../parsers/wechat-rules.js";
import { importTarget, type ImportLayout } from "./import-paths.js";

export { transactionPostings };

export function generateEntries(txs: ParsedTx[], batchId: string | undefined, layout: ImportLayout): GenerateResult & { files: NonNullable<GenerateResult["files"]> };
export function generateEntries(txs: ParsedTx[], batchId?: string): GenerateResult;
export function generateEntries(txs: ParsedTx[], batchId?: string, layout?: ImportLayout): GenerateResult {
  const monthFiles: Record<string, string> = {}, generated: string[] = [], errors: string[] = [];
  const files: NonNullable<GenerateResult["files"]> = {};
  const append = (date: string, source: ParsedTx["source"], account: string, body: string) => {
    const month = date.slice(0, 7).replace("-", "");
    monthFiles[month] = (monthFiles[month] ?? "") + body;
    if (layout) {
      const target = importTarget(layout, date, source, account);
      (files[target] ??= { year: date.slice(0, 4), body: "" }).body += body;
    }
  };
  const ready = activeTransactions(txs).filter((tx) => tx.status === "ready")
    .sort((a, b) => `${a.date}|${a.time ?? ""}|${a.id}`.localeCompare(`${b.date}|${b.time ?? ""}|${b.id}`));
  const originalsById = new Map(txs.map((tx) => [tx.id, tx]));
  const postedOnSourceDate = new Set<string>();
  const shiftedBalances = new Map<string, Array<{ from: string; to: string }>>();
  const wechatRules = ready.some((tx) => tx.source === "wechat" || tx.merge?.originals.some((member) => member.source === "wechat")) ? loadWechatRules() : [];
  for (const tx of ready) {
    const members = tx.merge ? tx.merge.originals.map(({ id }) => originalsById.get(id)) : [tx];
    const exclusion = members.map((member) => member ? wechatExclusionReason(member, wechatRules) : "合并组缺少原交易").find(Boolean);
    if (exclusion) { errors.push(`${tx.sourceFile}:${tx.row} ${exclusion}，请重新载入批次以更新排除项`); continue; }
    const postings = transactionPostings(tx), validation = validateTransaction(tx, postings);
    if (validation.length) { errors.push(...validation.map((error) => `${tx.sourceFile}:${tx.row} ${error}`)); continue; }
    const account = tx.merge ? tx.fundingAccount || "merged" : postings.find((posting) => posting.account === tx.fundingAccount)?.account
      ?? postings.find((posting) => /^(Assets|Liabilities):/.test(posting.account))?.account
      ?? postings[0].account;
    append(tx.date, tx.source, account, formatTransactionEntry(tx, postings, batchId) + "\n\n");
    generated.push(tx.id);
    for (const member of members) {
      if (!member) continue;
      if (member.date === tx.date) { postedOnSourceDate.add(member.id); continue; }
      const [from, to] = [member.date, tx.date].sort();
      for (const posting of transactionPostings(member)) {
        if (!posting.amount || !/^(Assets|Liabilities):/.test(posting.account)) continue;
        const key = `${posting.account}|${posting.currency}`;
        const periods = shiftedBalances.get(key) ?? [];
        periods.push({ from, to });
        shiftedBalances.set(key, periods);
      }
    }
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
    if (shiftedBalances.get(`${tx.fundingAccount}|${tx.currency}`)?.some(({ from, to }) => from <= tx.date && tx.date < to)) continue;
    if (group.some((other) => other.balanceAfter !== tx.balanceAfter) || !validDate(tx.date) || !accountPattern.test(tx.fundingAccount) || !currencyPattern.test(tx.currency) || !Number.isFinite(tx.balanceAfter)) continue;
    if (txs.some((other) => !other.merge && other.date === tx.date && other.fundingAccount === tx.fundingAccount && other.currency === tx.currency && other.status !== "duplicate" && !postedOnSourceDate.has(other.id))) continue;
    if (!postedOnSourceDate.has(tx.id) || !transactionPostings(tx).some((posting) => posting.account === tx.fundingAccount && posting.currency === tx.currency)) continue;
    const nextDay = new Date(Date.parse(`${tx.date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
    append(nextDay, tx.source, tx.fundingAccount, `${nextDay} balance ${tx.fundingAccount} ${amountText(tx.balanceAfter!)} ${tx.currency}\n\n`);
  }
  const sortedMonths = Object.fromEntries(Object.entries(monthFiles).sort(([a], [b]) => a.localeCompare(b)));
  const sortedFiles = Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
  const sections = layout ? Object.entries(sortedFiles).map(([file, { body }]) => [file, body]) : Object.entries(sortedMonths);
  return { entries: sections.map(([file, body]) => `; ===== ${file} =====\n${body}`).join("\n"),
    monthFiles: sortedMonths, ...(layout ? { files: sortedFiles } : {}), generated, errors, opens: [] };
}

/** Open each new account no later than its earliest referenced transaction. */
export function suggestOpens(txs: ParsedTx[], existingAccounts: Set<string>): string[] {
  const earliest = new Map<string, string>();
  for (const tx of activeTransactions(txs)) {
    if (tx.status !== "ready" || !validDate(tx.date)) continue;
    for (const posting of transactionPostings(tx)) if (accountPattern.test(posting.account) && !existingAccounts.has(posting.account)) {
      const previous = earliest.get(posting.account); if (!previous || tx.date < previous) earliest.set(posting.account, tx.date);
    }
  }
  return [...earliest].sort(([a], [b]) => a.localeCompare(b)).map(([account, date]) => `${date} open ${account}`);
}
