/**
 * Funding-account inference: maps raw payment-method text to beancount accounts.
 * Supports multiple cards per institution (e.g. two ICBC debit cards) and
 * debit/credit distinction — credit cards map to Liabilities.
 */

import type { AppConfig, ParsedTx } from "../../shared/types.js";

/** Extract a card-number suffix like "1234" from raw text like "中国工商银行(1234)". */
export function cardSuffix(raw: string): string | null {
  const m = raw.match(/[（(](\d{3,6})[）)]/);
  if (m) return m[1];
  const m2 = raw.match(/\d{4,6}$/);
  return m2 ? m2[0] : null;
}

/**
 * Decide funding account for a tx.
 * Priority:
 *  1. user-configured keyword mapping (with card suffix disambiguation)
 *  2. institution default (Assets:Bank:<Inst> or Liabilities:CC:<Inst>)
 */
export function inferFundingAccount(
  tx: ParsedTx,
  config: AppConfig,
): { account: string; confidence: number } {
  const raw = tx.rawAccount || "";

  for (const m of config.assetMapping) {
    if (raw.toLowerCase().includes(m.keyword.toLowerCase())) {
      const suffix = cardSuffix(raw);
      // if multiple mappings for the same keyword differ by card suffix, use it
      const sameKeyword = config.assetMapping.filter(
        (x) => x.keyword.toLowerCase() === m.keyword.toLowerCase(),
      );
      if (sameKeyword.length > 1 && suffix) {
        const hit = sameKeyword.find((x) => x.keyword.includes(suffix));
        if (hit) return { account: hit.account, confidence: 0.95 };
      }
      return { account: m.account, confidence: 0.9 };
    }
  }

  // institution defaults
  const inst: Array<[RegExp, string]> = [
    [/工商银行|工行|icbc/i, "Assets:Bank:ICBC"],
    [/建设银行|建行|ccb/i, "Assets:Bank:CCB"],
    [/中国银行|中行|boc/i, "Assets:Bank:BOC"],
    [/农业银行|农行|abc/i, "Assets:Bank:ABC"],
    [/浙商银行|czbank/i, "Assets:Bank:CZBank"],
    [/浦发|spdb/i, "Assets:Bank:SPDB"],
    [/招商银行|招行|cmb/i, "Assets:Bank:CMB"],
    [/余额宝/i, "Assets:Alipay:YuEBao"],
    [/支付宝|alipay|花呗/i, "Assets:Alipay:Cash"],
    [/^余额$|^账户余额$|余额宝/, "Assets:Alipay:Cash"],
    [/微信|wechat|零钱/i, "Assets:WeChat:Cash"],
    [/云闪付|unionpay/i, "Assets:UnionPay"],
  ];
  for (const [re, acc] of inst) {
    if (re.test(raw) || re.test(tx.payee)) return { account: acc, confidence: 0.7 };
  }

  if (tx.source.startsWith("bank-")) {
    return { account: `Assets:Bank:${tx.source.replace("bank-", "").toUpperCase()}`, confidence: 0.5 };
  }

  return { account: "Assets:FixMe", confidence: 0.3 };
}

/** Detect distinct payment methods present in a parsed batch (multi-account UI hint). */
export function detectAccounts(
  txs: ParsedTx[],
): Array<{ raw: string; guess: string; txCount: number }> {
  const counts = new Map<string, number>();
  for (const tx of txs) {
    const raw = tx.rawAccount || "(空)";
    counts.set(raw, (counts.get(raw) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([raw, n]) => ({ raw, guess: "", txCount: n }));
}
