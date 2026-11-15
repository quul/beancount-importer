/** Transfer matches are reversible review suggestions, never automatic deletions. */
import type { ParsedTx } from "../../shared/types.js";
const TRANSFER_RE = /还款|转账|转出|转入|充值|提现|取现|存现|余额宝|零钱通/i;
export interface PairResult { pairs: Array<{ from: ParsedTx; to: ParsedTx }>; absorbed: Set<string> }
const dateDiff = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86400000;
const transfer = (tx: ParsedTx) => tx.eventType === "transfer" || TRANSFER_RE.test(`${tx.payee} ${tx.note} ${tx.rawCategory}`);

export function pairTransfers(txs: ParsedTx[]): PairResult {
  const pairs: PairResult["pairs"] = [], used = new Set<string>();
  const candidates = txs.filter((tx) => tx.status !== "excluded" && tx.status !== "duplicate" && !tx.excludedReason && transfer(tx)
    && /^(Assets|Liabilities):/.test(tx.fundingAccount) && !/FixMe|Unknown/.test(tx.fundingAccount));
  for (const from of candidates.filter((tx) => tx.direction === "out")) {
    if (used.has(from.id)) continue;
    const matches = candidates.filter((to) => !used.has(to.id) && to.id !== from.id && to.direction === "in"
      && to.fundingAccount !== from.fundingAccount && to.currency === from.currency && dateDiff(from.date, to.date) <= 2 && Math.abs(from.amount - to.amount) < 0.005);
    if (matches.length !== 1) continue;
    const to = matches[0];
    // Ambiguous many-to-one matches stay untouched rather than choosing input order.
    const competing = candidates.filter((other) => other.direction === "out" && !used.has(other.id) && other.currency === to.currency
      && other.fundingAccount !== to.fundingAccount && dateDiff(other.date, to.date) <= 2 && Math.abs(other.amount - to.amount) < 0.005);
    if (competing.length !== 1) continue;
    used.add(from.id); used.add(to.id);
    const postings = [{ account: from.fundingAccount, amount: -from.amount, currency: from.currency }, { account: to.fundingAccount, amount: to.amount, currency: to.currency }];
    for (const [tx, counterpart] of [[from, to], [to, from]]) {
      tx.status = "pending";
      tx.issues = [...new Set([...(tx.issues ?? []), "存在转账配对建议；确认双方分录后保留一笔并排除另一笔"] )];
      tx.matches ??= [];
      tx.matches.push({ id: counterpart.id, date: counterpart.date, payee: counterpart.payee, narration: counterpart.note,
        file: counterpart.sourceFile, line: counterpart.row, reason: "转账配对建议：同币种等额反向、不同资金账户；需人工确认", postings });
    }
    pairs.push({ from, to });
  }
  return { pairs, absorbed: new Set() };
}

/** Clear only pairing suggestions; user-entered accounting fields are preserved. */
export function clearTransferSuggestion(tx: ParsedTx): void {
  tx.matches = tx.matches?.filter((match) => !match.reason.startsWith("转账配对建议"));
  tx.issues = tx.issues?.filter((issue) => !issue.startsWith("存在转账配对建议"));
  delete tx.fundingAccount2;
}
