/**
 * Classification pipeline (memory → ledger history → LLM batch → fallback).
 *
 * Improvements over the original memory_brain.py:
 *  - LLM called in batches of 20 with JSON output instead of one call per tx
 *  - few-shot examples taken from the user's own ledger history
 *  - confidence + reason returned so the UI can show why
 *  - payee→account memory keyed on normalized payee + category
 */

import fs from "node:fs";
import path from "node:path";
import type { AppConfig, LedgerInfo, ParsedTx } from "../../shared/types.js";

export interface MemoryStore {
  /** normalized payee|category → account */
  mapping: Record<string, string>;
}

export function loadMemory(file: string): MemoryStore {
  try {
    return { mapping: JSON.parse(fs.readFileSync(file, "utf-8")) };
  } catch {
    return { mapping: {} };
  }
}

export function saveMemory(file: string, mem: MemoryStore) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(mem.mapping, null, 2), "utf-8");
}

function normKey(payee: string, category: string): string {
  return `${payee.replace(/\s+/g, "").slice(0, 32)}|${category.slice(0, 24)}`;
}

/** Rule-based quick wins before hitting the LLM. */
const RULES: Array<{
  test: RegExp;
  account: string;
  reason: string;
}> = [
  { test: /滴滴|嘀嗒|高德打车|曹操出行|T3出行|地铁|公交|铁路|12306|航旅|机票|燃油费/i, account: "Expenses:Transport", reason: "交通出行关键词" },
  { test: /美团|饿了么|肯德基|麦当劳|星巴克|瑞幸|咖啡|餐厅|饭店|食堂|外卖/i, account: "Expenses:Food", reason: "餐饮关键词" },
  { test: /话费|流量|宽带|移动|联通|电信|水电煤|燃气|物业费/i, account: "Expenses:Housing", reason: "居住/通信关键词" },
  { test: /淘宝|天猫|京东|拼多多|唯品会|苏宁/i, account: "Expenses:Shopping", reason: "电商平台" },
  { test: /工资|薪金|salary|年终奖/i, account: "Income:Salary", reason: "工资" },
  { test: /红包|转账|压岁钱/i, account: "Income:RedPacket", reason: "红包/转账" },
  { test: /退款|退货|退款/i, account: "Income:Refund", reason: "退款" },
  { test: /余额宝|零钱通|理财|基金|利息/i, account: "Income:Investment", reason: "理财收益" },
];

export interface ClassifyOutcome {
  account: string;
  confidence: number;
  reason: string;
}

/** Determine suggestion source order: memory → ledger history → rules → LLM. */
export function classifyLocal(
  tx: ParsedTx,
  mem: MemoryStore,
  ledger: LedgerInfo,
): ClassifyOutcome | null {
  // 1. memory (user-confirmed mappings)
  const memKey = normKey(tx.payee, tx.rawCategory);
  if (mem.mapping[memKey]) {
    return { account: mem.mapping[memKey], confidence: 0.95, reason: "记忆映射" };
  }
  // 1b. memory by payee alone
  const payeeKey = normKey(tx.payee, "");
  if (mem.mapping[payeeKey]) {
    return { account: mem.mapping[payeeKey], confidence: 0.9, reason: "记忆映射(仅商户)" };
  }

  // 2. ledger history
  const hist = ledger.payeeIndex[tx.payee];
  if (hist && hist.length > 0 && hist[0].count >= 2) {
    return {
      account: hist[0].account,
      confidence: Math.min(0.9, 0.6 + hist[0].count * 0.1),
      reason: `历史账本出现 ${hist[0].count} 次`,
    };
  }

  // 3. rules
  const text = `${tx.payee} ${tx.note} ${tx.rawCategory} ${tx.rawAccount}`;
  for (const r of RULES) {
    if (r.test.test(text)) {
      return { account: r.account, confidence: 0.75, reason: r.reason };
    }
  }
  return null;
}

/** Batch LLM classification for txs that local passes couldn't resolve. */
export async function classifyWithLlm(
  txs: ParsedTx[],
  config: AppConfig,
  ledger: LedgerInfo,
): Promise<Map<string, ClassifyOutcome>> {
  const out = new Map<string, ClassifyOutcome>();
  if (config.llm.provider === "off" || !config.llm.apiKey || txs.length === 0) {
    return out;
  }

  const accounts = [
    ...new Set([...config.accounts, ...ledger.accounts.map((a) => a.account)]),
  ]
    .filter((a) => /^(Expenses|Income|Liabilities|Equity|Assets):/.test(a))
    .sort();

  // few-shot from user's own history
  const examples = Object.entries(ledger.payeeIndex)
    .filter(([, v]) => v[0].count >= 2)
    .slice(0, 15)
    .map(([payee, v]) => `${payee} → ${v[0].account}`)
    .join("\n");

  const BATCH = 20;
  for (let i = 0; i < txs.length; i += BATCH) {
    const batch = txs.slice(i, i + BATCH);
    const items = batch
      .map((t, idx) =>
        [
          `${idx}. 日期:${t.date} ${t.direction === "in" ? "收入" : "支出"}`,
          `商户:${t.payee}`,
          `说明:${t.note}`,
          `原始分类:${t.rawCategory}`,
          `支付方式:${t.rawAccount}`,
        ].join(" | "),
      )
      .join("\n");

    const prompt = `你是一个 Beancount 记账分类助手。请为以下交易从账户列表中各选一个账户。

账户列表:
${accounts.join("\n")}

${examples ? `用户历史分类示例:\n${examples}\n` : ""}
交易列表:
${items}

规则:
1. 优先参考原始分类与商户名。
2. 只能从账户列表中选择。
3. 收入交易选 Income: 开头账户，支出选 Expenses: 开头账户。
4. 若是还款/转账/信用卡还款，选择对应 Liabilities 或 Assets 账户。
5. 不确定时选 Expenses:Other。

只输出 JSON 数组，每项形如 {"idx":0,"account":"Expenses:Food","confidence":0.9,"reason":"外卖平台"}`;

    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 60_000);
      const resp = await fetch(`${config.llm.apiBase.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.llm.apiKey}`,
        },
        body: JSON.stringify({
          model: config.llm.model,
          temperature: 0,
          messages: [{ role: "user", content: prompt }],
          response_format: { type: "json_object" },
        }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!resp.ok) continue;
      const data = (await resp.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = data.choices?.[0]?.message?.content ?? "";
      // model may wrap array in an object or add prose; extract first JSON array
      const m = content.match(/\[[\s\S]*\]/);
      if (!m) continue;
      const parsed = JSON.parse(m[0]) as Array<{
        idx: number;
        account: string;
        confidence?: number;
        reason?: string;
      }>;
      for (const p of parsed) {
        const tx = batch[p.idx];
        if (!tx) continue;
        if (!accounts.includes(p.account)) continue;
        out.set(tx.id, {
          account: p.account,
          confidence: Math.min(0.85, p.confidence ?? 0.6),
          reason: p.reason || "AI 分类",
        });
      }
    } catch {
      // network/API failure: leave unresolved, UI falls back to Expenses:Other
    }
  }
  return out;
}
