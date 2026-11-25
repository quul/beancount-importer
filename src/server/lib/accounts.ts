/** Funding inference only selects defined accounts; ambiguity is a review task. */
import { isFamilyCard } from "../../shared/types.js";
import type { AppConfig, LedgerInfo, ParsedAccount, ParsedTx, SourceType } from "../../shared/types.js";
import { accountIsActive, isCombinedPayment, isFundingAccount, isMissingPaymentMethod, normalizePaymentMethod, singlePaymentMethod } from "../../shared/funding.js";
import { parseFundingParts } from "../parsers/common.js";

export { accountIsActive, isMissingPaymentMethod, normalizePaymentMethod, singlePaymentMethod } from "../../shared/funding.js";

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

export function setExactFundingMapping(mappings: AppConfig["assetMapping"], source: SourceType, keyword: string, account: string): AppConfig["assetMapping"] {
  const key = normalizePaymentMethod(keyword);
  return [...mappings.filter((item) => !item.exact || item.source !== source || normalizePaymentMethod(item.keyword) !== key),
    { keyword, source, exact: true, account, kind: account.startsWith("Liabilities:") ? "credit" : "debit" }];
}

export function confirmFundingAccount(tx: ParsedTx, account: string): void {
  if (tx.postings && tx.fundingAccount !== account) {
    tx.postings = tx.postings.map((posting) => posting.account === tx.fundingAccount ? { ...posting, account } : posting);
  }
  tx.fundingAccount = account;
  tx.fundingConfidence = 1;
  delete tx.fundingReason;
}

export const fundingMappingIssue = (issue: string) => issue === "账户未映射" || issue === "账户映射冲突"
  || issue === "支付方式缺失" || /未绑定账本账户|^支付方式对应 \d+ 个账户|^账单未注明支付方式/.test(issue);

const unknown = (message: string): FundingGuess => ({ account: "", confidence: 0, issues: [message], reason: message });
export const isPaymentAccountPart = ({ rawAccount }: { rawAccount: string }) =>
  !isMissingPaymentMethod(rawAccount) && !/红包|积分|优惠|立减|满减|折扣|补贴|抵扣|代金券|消费券|淘金币|集分宝|京豆/.test(rawAccount);

export function unallocatedFundingParts(tx: ParsedTx): ParsedTx["fundingParts"] {
  if (!isCombinedPayment(tx) || isFamilyCard(tx)) return;
  const parts = tx.fundingParts ?? parseFundingParts(tx.rawAccount).fundingParts;
  if (parts && parts.length > 1 && parts.some(({ amount }) => amount == null) && parts.some(isPaymentAccountPart)) return parts;
}

export function inferFundingAccount(tx: ParsedTx, config: AppConfig, ledger?: LedgerInfo): FundingGuess {
  // 亲情卡/代付: the payment method belongs to the other person. Never match it
  // against my own wallet/card mappings (e.g. their 花呗 is not my Huabei account).
  if (isFamilyCard(tx)) return unknown("对方付款");
  if (isCombinedPayment(tx)) {
    for (const { rawAccount } of unallocatedFundingParts(tx) ?? []) {
      if (!isPaymentAccountPart({ rawAccount })) continue;
      const matched = matchFundingAccount(rawAccount.trim(), tx, config, ledger);
      if (!isFundingAccount(matched.account) || (ledger && !ledger.accounts.some((entry) =>
        entry.account === matched.account && accountIsActive(entry, tx.date, tx.currency)))) continue;
      return {
        account: matched.account, confidence: Math.min(matched.confidence, 0.98),
        reason: `按组合支付中的「${rawAccount.trim()}」预填，分摊金额待确认`, issues: ["组合支付，分摊待确认"],
      };
    }
    return unknown("组合支付");
  }
  const raw = singlePaymentMethod(tx) || (!tx.rawAccount?.trim() && tx.source.startsWith("bank-") ? tx.source.slice(5) : "");
  if (!raw) return unknown("支付方式缺失");
  return matchFundingAccount(raw, tx, config, ledger);
}

export function matchFundingAccount(raw: string, tx: ParsedTx, config: AppConfig, ledger?: LedgerInfo, configuredOnly = false): FundingGuess {
  const available = ledger?.accounts;
  const valid = (name: string) => {
    if (!isFundingAccount(name)) return false;
    if (!available) return true; // Explicit mappings are validated at generation too.
    const a = available.find((entry) => entry.account === name);
    return !!a && accountIsActive(a, tx.date, tx.currency);
  };
  const suffix = cardSuffix(raw);
  const credit = /信用卡|贷记卡|花呗|白条/i.test(raw);
  const debit = /储蓄卡|借记卡/i.test(raw);
  // An explicitly configured mapping is the user's intent even when the account
  // is not opened in the ledger yet (e.g. the family-card payer's new card):
  // generation suggests the missing `open` instead of silently dropping it.
  const normalized = normalizePaymentMethod(raw);
  const exact = config.assetMapping.filter((m) => m.exact && (!m.source || m.source === tx.source)
    && normalizePaymentMethod(m.keyword) === normalized);
  if (exact.length) {
    const scoped = exact.filter((m) => m.source === tx.source);
    const choices = scoped.length ? scoped : exact;
    const accounts = [...new Set(choices.map((m) => m.account))];
    if (accounts.length > 1) return unknown("账户映射冲突");
    return valid(accounts[0])
      ? { account: accounts[0], confidence: 1, reason: `完整匹配已保存的付款方式「${choices[0].keyword}」` }
      : unknown("账户未映射");
  }
  // A statement with the full bank and credit card label can reuse a matching payment mapping.
  const statementCard = tx.source.startsWith("bank-") && /^.+信用卡(?:\([0-9]{4}\))?$/.test(normalized);
  if (statementCard && !suffix) return unknown("账单未识别出卡尾号");
  if (statementCard && suffix) {
    const cardAccounts = [...new Set(config.assetMapping.filter((m) => m.exact && m.kind === "credit"
      && normalizePaymentMethod(m.keyword) === normalized && valid(m.account) && m.account.startsWith("Liabilities:")).map((m) => m.account))];
    if (cardAccounts.length > 1) return unknown("账户映射冲突");
    if (cardAccounts.length === 1) return { account: cardAccounts[0], confidence: 0.98, reason: `卡尾号 ${suffix} 与已保存的信用卡映射一致` };
  }
  const mappings = config.assetMapping.filter((m) => !m.exact && isFundingAccount(m.account)
    && (!configuredOnly || !m.source || m.source === tx.source));
  const dynamic = available && !configuredOnly ? buildAssetMapping(available, tx.date).filter((m) => valid(m.account)) : [];
  const keywords = (m: AppConfig["assetMapping"][number]) => raw.toLowerCase().includes(m.keyword.toLowerCase());

  // Wallet investment products must not fall through to the cash wallet.
  const investment = /零钱通/.test(raw) ? "零钱通" : /余额宝/.test(raw) ? "余额宝" : undefined;
  const eligible = (m: AppConfig["assetMapping"][number]) => keywords(m)
    && (m.account.startsWith(m.kind === "credit" ? "Liabilities:" : "Assets:") || m.account.startsWith("Income:"))
    && (!investment || m.keyword.includes(investment))
    && (!credit || (m.kind === "credit" && m.account.startsWith("Liabilities:")))
    && (!debit || (m.kind === "debit" && m.account.startsWith("Assets:")))
    // An unrecognised card suffix is never mapped to the institution default.
    && (!suffix || (m.cardSuffix ?? cardSuffix(m.keyword) ?? m.account.match(/:(\d{3,6})$/)?.[1]) === suffix);
  const configured = mappings.filter(eligible);
  let matches = configured.length ? configured : dynamic.filter(eligible);

  if (!matches.length) return unknown("账户未映射");
  // Prefer an explicit specific mapping (e.g. 微信账号B) over generic aliases.
  const specific = matches.filter((m) => config.assetMapping.includes(m) && m.keyword.length > 4 && raw.toLowerCase().includes(m.keyword.toLowerCase()));
  if (specific.length) matches = specific;
  const unique = [...new Set(matches.map((m) => m.account))];
  if (unique.length !== 1) return unknown("账户映射冲突");
  const fullMatch = matches.find((m) => raw === m.keyword);
  const keyword = (fullMatch ?? matches[0]).keyword;
  const reason = suffix ? `关键词「${keyword}」和卡尾号 ${suffix} 匹配`
    : fullMatch ? `完整匹配付款方式「${keyword}」` : `关键词「${keyword}」匹配`;
  return { account: unique[0], confidence: suffix || fullMatch ? 0.98 : 0.9, reason };
}

export function detectAccounts(txs: ParsedTx[]): Array<{ raw: string; guess: string; txCount: number }> {
  const groups = new Map<string, { txCount: number; guesses: Set<string> }>();
  for (const tx of txs) {
    const raw = tx.recognition?.fundingMethod || tx.rawAccount || "(空)";
    const group = groups.get(raw) ?? { txCount: 0, guesses: new Set<string>() };
    group.txCount++;
    if (tx.fundingAccount) group.guesses.add(tx.fundingAccount);
    groups.set(raw, group);
  }
  return [...groups].sort((a, b) => b[1].txCount - a[1].txCount).map(([raw, g]) => ({ raw, guess: g.guesses.size === 1 ? [...g.guesses][0] : "", txCount: g.txCount }));
}
