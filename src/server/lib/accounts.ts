/** Funding inference only selects defined accounts; ambiguity is a review task. */
import type { AppConfig, LedgerInfo, ParsedAccount, ParsedTx } from "../../shared/types.js";

const BANKS: Array<{ code: string; aliases: string[] }> = [
  { code: "BOC", aliases: ["中国银行", "中行", "BOC"] },
  { code: "ABC", aliases: ["农业银行", "农行", "ABC"] },
  { code: "ICBC", aliases: ["工商银行", "工行", "ICBC"] },
  { code: "CCB", aliases: ["建设银行", "建行", "CCB"] },
  { code: "CMB", aliases: ["招商银行", "招行", "CMB"] },
  { code: "SPDB", aliases: ["浦发银行", "浦发", "SPDB"] },
  { code: "CITIC", aliases: ["中信银行", "中信", "CITIC"] },
  { code: "CMBC", aliases: ["民生银行", "民生", "CMBC"] },
  { code: "BCM", aliases: ["交通银行", "交行", "BCM"] },
  { code: "CIB", aliases: ["兴业银行", "兴业", "CIB"] },
  { code: "PSBC", aliases: ["邮政储蓄", "邮储", "PSBC"] },
  { code: "PAB", aliases: ["平安银行", "平安", "PAB"] },
  { code: "WeBank", aliases: ["微众银行", "微众", "WeBank"] },
  { code: "WangShangBank", aliases: ["网商银行", "网商", "WangShangBank"] },
  { code: "CZBank", aliases: ["浙商银行", "浙商", "CZBank"] },
];

export function accountIsActive(account: ParsedAccount, date: string, currency?: string): boolean {
  if (account.openedAt && account.openedAt > date) return false;
  if (account.closedAt && account.closedAt < date) return false;
  const currencies = account.currencies ?? (account.currency ? [account.currency] : []);
  return !currency || !currencies.length || currencies.includes(currency);
}

export function cardSuffix(raw: string): string | null {
  const m = raw.match(/(?:[（(]|尾号\s*|末四位\s*)(\d{3,6})(?:[）)]|\b)/);
  if (m) return m[1];
  const last = raw.match(/\b(\d{4,6})$/);
  return last ? last[1] : null;
}

/** Derive local mappings from definitions, never embed personal card data in code. */
export function buildAssetMapping(accounts: ParsedAccount[], date = new Date().toISOString().slice(0, 10)): AppConfig["assetMapping"] {
  const result: AppConfig["assetMapping"] = [];
  for (const a of accounts) {
    if (!/^(Assets|Liabilities):/.test(a.account) || !accountIsActive(a, date)) continue;
    const parts = a.account.split(":");
    const kind = a.account.startsWith("Liabilities:") ? "credit" : "debit";
    const suffix = /^\d{3,6}$/.test(parts.at(-1) || "") ? parts.at(-1) : undefined;
    let aliases: string[] = [];
    const bank = BANKS.find((b) => parts.some((p) => p.toLowerCase() === b.code.toLowerCase()));
    if (bank) aliases = bank.aliases;
    else if (/:(?:Alipay|Alipay\d+)$/i.test(a.account)) aliases = ["支付宝", "alipay", "余额"];
    else if (/:(?:WeChat|WeChat\d+)$/i.test(a.account)) aliases = ["微信", "wechat", "零钱"];
    else if (/:(?:YuEBao|YueBao)$/i.test(a.account)) aliases = ["余额宝"];
    else if (/:(?:LingQianTong|LQT)$/i.test(a.account)) aliases = ["零钱通"];
    else if (/:Huabei$/i.test(a.account)) aliases = ["花呗"];
    else if (/:Baitiao$/i.test(a.account)) aliases = ["白条"];
    for (const keyword of aliases) result.push({ keyword, account: a.account, kind, ...(suffix ? { cardSuffix: suffix } : {}) });
  }
  return result;
}

export interface FundingGuess {
  account: string;
  confidence: number;
  issues?: string[];
  reason?: string;
}

export function inferFundingAccount(tx: ParsedTx, config: AppConfig, ledger?: LedgerInfo): FundingGuess {
  const unknown = (message: string): FundingGuess => ({ account: "", confidence: 0, issues: [message], reason: message });
  if ((tx.fundingParts?.length ?? 0) > 1 || /[&＋+]|组合支付|组合付款/.test(tx.rawAccount || "")) return unknown("组合支付需要逐项确认资金分录");
  let raw = (tx.rawAccount || "").trim();
  if (!raw && tx.source.startsWith("bank-")) raw = tx.source.slice(5);
  if (!raw || /^[\s/—-]+$/.test(raw)) return unknown("账单未提供可确定的资金账户");

  const available = ledger?.accounts;
  const valid = (name: string) => {
    if (!/^(Assets|Liabilities):/.test(name)) return false;
    if (!available) return true; // Explicit mappings are validated at generation too.
    const a = available.find((entry) => entry.account === name);
    return !!a && accountIsActive(a, tx.date, tx.currency);
  };
  const suffix = cardSuffix(raw);
  const credit = /信用卡|贷记卡|花呗|白条/i.test(raw);
  const debit = /储蓄卡|借记卡/i.test(raw);
  const mappings = config.assetMapping.filter((m) => valid(m.account));
  const dynamic = available ? buildAssetMapping(available, tx.date).filter((m) => valid(m.account)) : [];
  const keywords = (m: AppConfig["assetMapping"][number]) => raw.toLowerCase().includes(m.keyword.toLowerCase());

  // Wallet investment products must not fall through to the cash wallet.
  const investment = /零钱通/.test(raw) ? "零钱通" : /余额宝/.test(raw) ? "余额宝" : undefined;
  const eligible = (m: AppConfig["assetMapping"][number]) => keywords(m)
    && m.account.startsWith(m.kind === "credit" ? "Liabilities:" : "Assets:")
    && (!investment || m.keyword.includes(investment))
    && (!credit || (m.kind === "credit" && m.account.startsWith("Liabilities:")))
    && (!debit || (m.kind === "debit" && m.account.startsWith("Assets:")))
    // An unrecognised card suffix is never mapped to the institution default.
    && (!suffix || (m.cardSuffix ?? cardSuffix(m.keyword) ?? m.account.match(/:(\d{3,6})$/)?.[1]) === suffix);
  const configured = mappings.filter(eligible);
  let matches = configured.length ? configured : dynamic.filter(eligible);

  if (!matches.length) return unknown(investment ? `${investment}没有独立且有效的账本账户，请绑定后重试` : "支付方式尚未绑定到有效的账本账户");
  // Prefer an explicit specific mapping (e.g. 微信账号B) over generic aliases.
  const specific = matches.filter((m) => config.assetMapping.includes(m) && m.keyword.length > 4 && raw.toLowerCase().includes(m.keyword.toLowerCase()));
  if (specific.length) matches = specific;
  const unique = [...new Set(matches.map((m) => m.account))];
  if (unique.length !== 1) return unknown(`支付方式对应 ${unique.length} 个账户，请明确选择钱包或银行卡`);
  return { account: unique[0], confidence: suffix || matches.some((m) => raw === m.keyword) ? 0.98 : 0.9, reason: "匹配已定义的资金账户" };
}

export function detectAccounts(txs: ParsedTx[]): Array<{ raw: string; guess: string; txCount: number }> {
  const groups = new Map<string, { txCount: number; guesses: Set<string> }>();
  for (const tx of txs) {
    const raw = tx.rawAccount || "(空)";
    const group = groups.get(raw) ?? { txCount: 0, guesses: new Set<string>() };
    group.txCount++;
    if (tx.fundingAccount) group.guesses.add(tx.fundingAccount);
    groups.set(raw, group);
  }
  return [...groups].sort((a, b) => b[1].txCount - a[1].txCount).map(([raw, g]) => ({ raw, guess: g.guesses.size === 1 ? [...g.guesses][0] : "", txCount: g.txCount }));
}
