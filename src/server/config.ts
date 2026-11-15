import fs from "node:fs";
import path from "node:path";
import type { AppConfig } from "../shared/types.js";

const DEFAULT_CONFIG: AppConfig = {
  ledgerRoot: "../beancount-import-auto",
  mainFile: "main.beancount",
  monthlyDir: "data",
  assetMapping: [
    { keyword: "支付宝", account: "Assets:Alipay:Cash", kind: "debit" },
    { keyword: "微信", account: "Assets:WeChat:Cash", kind: "debit" },
    { keyword: "工商银行", account: "Assets:Bank:ICBC", kind: "debit" },
    { keyword: "建设银行", account: "Assets:Bank:CCB", kind: "debit" },
    { keyword: "中国银行", account: "Assets:Bank:BOC", kind: "debit" },
    { keyword: "农业银行", account: "Assets:Bank:ABC", kind: "debit" },
    { keyword: "浙商银行", account: "Assets:Bank:CZBank", kind: "debit" },
    { keyword: "浦发", account: "Assets:Bank:SPDB", kind: "debit" },
  ],
  accounts: [
    "Expenses:Food",
    "Expenses:Shopping",
    "Expenses:Transport",
    "Expenses:Housing",
    "Expenses:Entertainment",
    "Expenses:Health",
    "Expenses:Car",
    "Expenses:Other",
    "Income:Salary",
    "Income:RedPacket",
    "Income:Refund",
    "Income:Investment",
    "Equity:Opening-Balances",
  ],
  llm: {
    provider: "off",
    apiBase: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    apiKey: "",
  },
};

export function loadConfig(root: string): AppConfig {
  const file = path.join(root, "config.json");
  if (fs.existsSync(file)) {
    const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as Partial<AppConfig>;
    return {
      ...DEFAULT_CONFIG,
      ...raw,
      llm: { ...DEFAULT_CONFIG.llm, ...(raw.llm ?? {}) },
      assetMapping: raw.assetMapping?.length
        ? (raw.assetMapping as AppConfig["assetMapping"])
        : DEFAULT_CONFIG.assetMapping,
    };
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(DEFAULT_CONFIG, null, 2), "utf-8");
  return DEFAULT_CONFIG;
}

export function saveConfig(root: string, config: AppConfig) {
  fs.writeFileSync(
    path.join(root, "config.json"),
    JSON.stringify(config, null, 2),
    "utf-8",
  );
}
