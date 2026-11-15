/**
 * Transfer pairing: match two legs of the same money movement.
 *
 * Cases:
 *  1. Credit card repayment paid from a debit card: one tx in the debit
 *     statement (out, payee "信用卡还款"), one tx in the credit statement
 *     (in). Both legs are real postings of ONE transaction:
 *       Liabilities:CC:XXX  -3500
 *       Assets:Bank:YYY
 *  2. Self-transfer between own accounts (余额宝→银行卡 etc.)
 *  3. Alipay/wechat top-up (充值) from bank → alipay balance
 *
 * Match rule: same day (±2 days for bank booking lag), opposite direction,
 * equal amount (±0.01), and at least one side looks like a transfer
 * (还款/转账/充值/提现 keyword or target is own asset account).
 *
 * Paired txs get fundingAccount2 set; generate.ts then emits a 2-leg
 * transfer entry and skips the expense/income leg.
 */

import type { ParsedTx } from "../../shared/types.js";

const TRANSFER_RE = /还款|转账|转出|转入|充值|提现|取现|存现|还款成功|信用卡|余额宝|零钱通/i;

export interface PairResult {
  pairs: Array<{ from: ParsedTx; to: ParsedTx }>;
  /** ids that are the "to" side of a pair and should be absorbed */
  absorbed: Set<string>;
}

function dateDiff(a: string, b: string): number {
  return Math.abs(
    Date.parse(a) - Date.parse(b),
  ) / 86400000;
}

export function pairTransfers(txs: ParsedTx[]): PairResult {
  const pairs: PairResult["pairs"] = [];
  const absorbed = new Set<string>();

  const candidates = txs.filter(
    (t) => t.status !== "excluded" && t.status !== "duplicate",
  );

  for (let i = 0; i < candidates.length; i++) {
    const a = candidates[i];
    if (absorbed.has(a.id)) continue;
    if (!TRANSFER_RE.test(`${a.payee}${a.note}${a.rawCategory}`)) continue;

    for (let j = i + 1; j < candidates.length; j++) {
      const b = candidates[j];
      if (absorbed.has(b.id)) continue;
      if (b.direction === a.direction) continue;
      if (dateDiff(a.date, b.date) > 2) continue;
      if (Math.abs(a.amount - b.amount) > 0.01) continue;
      // skip if both look like real purchases (e.g. two same-amount purchases)
      if (!TRANSFER_RE.test(`${b.payee}${b.note}${b.rawCategory}`)) continue;
      // don't pair an expense-classified tx with obvious consumption payees
      if (a.finalAccount.startsWith("Expenses:") && /餐|食|车|店|超市|加油/.test(a.payee)) continue;
      if (b.finalAccount.startsWith("Expenses:") && /餐|食|车|店|超市|加油/.test(b.payee)) continue;

      // a = money leaves (out), b = money arrives (in)
      const from = a.direction === "out" ? a : b;
      const to = a.direction === "out" ? b : a;

      from.fundingAccount2 = to.fundingAccount;
      from.status = from.status === "pending" ? "ready" : from.status;
      // transfer classification: the expense leg becomes the target account
      from.finalAccount = to.fundingAccount;
      from.reason = "转账配对";
      from.confidence = Math.max(from.confidence, 0.9);

      absorbed.add(to.id);
      to.status = "duplicate";
      to.duplicateOf = {
        id: from.id,
        where: "transfer-pairing",
        label: `转账的另一腿 · ${from.payee || from.rawAccount}`,
      };

      pairs.push({ from, to });
      break;
    }
  }

  return { pairs, absorbed };
}
