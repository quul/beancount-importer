import fs from "node:fs";
import { isFamilyCard, type Direction, type RawTx } from "../../shared/types.js";
import { isMissingPaymentMethod } from "../lib/accounts.js";

interface WechatRuleConditions {
  category: string | string[];
  direction?: Direction;
  status?: string;
  payeePrefix?: string;
}

type WechatRule = { when: WechatRuleConditions } & (
  { exclude: string; label?: never; fundingMethod?: never }
  | { exclude?: never; label: string; fundingMethod: string }
);

const rulesPath = "config/wechat-rules.json";
const nonEmptyText = (value: unknown) => typeof value === "string" && value.length > 0 && value === value.trim();
const conditionKeys = new Set(["category", "direction", "status", "payeePrefix"]);

export function loadWechatRules(): WechatRule[] {
  let rules: unknown;
  try {
    rules = JSON.parse(fs.readFileSync(new URL(`../../../${rulesPath}`, import.meta.url), "utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new Error(`无法读取微信识别配置 ${rulesPath}：${(error as Error).message}`);
  }
  if (!Array.isArray(rules)) throw new Error(`${rulesPath} 应为规则数组`);
  for (const [index, rule] of rules.entries()) {
    const when = rule?.when;
    const category = when?.category;
    const validCategory = Array.isArray(category) ? category.length > 0 && category.every(nonEmptyText) : nonEmptyText(category);
    if (!validCategory || Object.keys(when).some((key) => !conditionKeys.has(key))
      || (when.direction !== undefined && when.direction !== "in" && when.direction !== "out")
      || (when.status !== undefined && !nonEmptyText(when.status))
      || (when.payeePrefix !== undefined && !nonEmptyText(when.payeePrefix))) {
      throw new Error(`${rulesPath} 第 ${index + 1} 条规则的 when 条件无效`);
    }
    const validAction = rule.exclude !== undefined
      ? nonEmptyText(rule.exclude) && rule.label === undefined && rule.fundingMethod === undefined
      : nonEmptyText(rule.label) && nonEmptyText(rule.fundingMethod) && !isMissingPaymentMethod(rule.fundingMethod);
    if (!validAction) {
      throw new Error(`${rulesPath} 第 ${index + 1} 条规则需要配置 exclude，或同时配置 label 和 fundingMethod`);
    }
  }
  return rules as WechatRule[];
}

function matchesWechatRule(tx: RawTx, { category, direction, status, payeePrefix }: WechatRuleConditions): boolean {
  return (Array.isArray(category) ? category.includes(tx.rawCategory) : tx.rawCategory === category)
    && (direction === undefined || tx.direction === direction)
    && (status === undefined || tx.sourceStatus === status)
    && (payeePrefix === undefined || tx.payee.startsWith(payeePrefix));
}

export function wechatExclusionReason(tx: RawTx, rules: readonly WechatRule[]): string | undefined {
  if (tx.source !== "wechat" || tx.excludedReason) return;
  return rules.find((rule) => rule.exclude !== undefined && matchesWechatRule(tx, rule.when))?.exclude;
}

export function recognizeWechatTransaction(tx: RawTx, rules: readonly WechatRule[]): RawTx["recognition"] {
  if (tx.source !== "wechat" || tx.excludedReason || tx.fundingParts?.length || isFamilyCard(tx) || !isMissingPaymentMethod(tx.rawAccount)) return;
  const rule = rules.find((candidate) => candidate.fundingMethod !== undefined && matchesWechatRule(tx, candidate.when));
  if (rule?.fundingMethod !== undefined) return { label: rule.label, fundingMethod: rule.fundingMethod };
}
