/** Transfer matches are reversible review suggestions, never automatic deletions. */
import { isFamilyCard } from "../../shared/types.js";
import type { ParsedTx } from "../../shared/types.js";
const TRANSFER_RE = /还款|转账|转出|转入|充值|提现|取现|存现|余额宝|零钱通/i;
export interface PairResult { pairs: Array<{ from: ParsedTx; to: ParsedTx }>; absorbed: Set<string>; familyCardPairs: number }
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
      tx.issues = [...new Set([...(tx.issues ?? []), "这可能是同一笔转账的两条流水，采用后请排除另一条"] )];
      tx.matches ??= [];
      tx.matches.push({ id: counterpart.id, date: counterpart.date, payee: counterpart.payee, narration: counterpart.note,
        file: counterpart.sourceFile, line: counterpart.row, reason: "转账配对建议：可能是同一笔转账", postings });
    }
    pairs.push({ from, to });
  }
  return { pairs, absorbed: new Set(), familyCardPairs: pairFamilyCards(txs) };
}

/**
 * 亲情卡/亲友代付 appears twice when both sides' statements are imported:
 * once as a proxy-pay record (my alipay "亲友代付·亲情卡") and once as the
 * real card charge in the payer's statement. Same merchant + same amount within
 * ±2 days means the same purchase: keep the real charge, mark the proxy record
 * as a duplicate. Refund rows follow their original purchase.
 */
function pairFamilyCards(txs: ParsedTx[]): number {
  const clean = (s: string) => s.replace(/[\s（）()]/g, "").toLowerCase();
  const proxies = txs.filter((tx) => isFamilyCard(tx) && !tx.excludedReason && tx.status !== "excluded" && tx.status !== "duplicate");
  if (!proxies.length) return 0;
  const charges = txs.filter((tx) => !isFamilyCard(tx) && !tx.excludedReason && tx.status !== "excluded" && tx.status !== "duplicate"
    && tx.eventType !== "transfer");
  let paired = 0;
  const used = new Set<string>();
  for (const proxy of proxies) {
    const refundProxy = /退款/.test(proxy.rawCategory ?? "") || proxy.eventType === "refund";
    // The real charge has the same direction as the proxy record describes.
    const candidates = charges.filter((tx) => !used.has(tx.id)
      && tx.sourceFile !== proxy.sourceFile
      && tx.direction === proxy.direction
      && tx.currency === proxy.currency
      && Math.abs(tx.amount - proxy.amount) < 0.005
      && dateDiff(tx.date, proxy.date) <= 2
      && clean(tx.payee) === clean(proxy.payee)
      && (refundProxy ? tx.eventType === "refund" || /退款|退还/.test(`${tx.rawCategory ?? ""}${tx.sourceStatus ?? ""}`) : tx.eventType !== "refund"));
    if (candidates.length !== 1) continue; // ambiguous or unmatched: leave for manual review
    const charge = candidates[0];
    used.add(charge.id);
    proxy.status = "duplicate";
    proxy.duplicateOf = { id: charge.id, where: charge.sourceFile, label: "亲情卡消费已由对方账单扣款，保留对方一笔" };
    proxy.matches = [{ id: charge.id, date: charge.date, payee: charge.payee, narration: charge.note,
      file: charge.sourceFile, line: charge.row, reason: "对方账单中的实际扣款", postings: charge.postings ?? [] }];
    paired++;
  }
  return paired;
}

/** Clear only pairing suggestions; user-entered accounting fields are preserved. */
export function clearTransferSuggestion(tx: ParsedTx): void {
  tx.matches = tx.matches?.filter((match) => !match.reason.startsWith("转账配对建议"));
  tx.issues = tx.issues?.filter((issue) => !issue.startsWith("这可能是同一笔转账的两条流水"));
  delete tx.fundingAccount2;
}
