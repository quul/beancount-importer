/** Native-loader, profile, funding and classification regressions. No real ledger writes. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverLedgerRoot, loadConfig } from "../src/server/config.js";
import { discoverPython, parseLedger, parseLedgerText, validateLedgerFile, validateLedgerText } from "../src/server/lib/ledger.js";
import { accountIsActive, buildAssetMapping, inferFundingAccount } from "../src/server/lib/accounts.js";
import { classifyLocal, classifyWithLlm, suggestRefundsFromBatch } from "../src/server/lib/classify.js";
import type { AppConfig, ParsedTx } from "../src/shared/types.js";

const realRoot = discoverLedgerRoot();
const python = discoverPython(realRoot);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bean-ledger-regression-"));
let checks = 0;
function check(label: string, fn: () => void) { fn(); checks++; console.log(`✓ ${label}`); }
const source = `2020-01-01 open Assets:Bank:Multi CNY, USD ; inline comment
2020-01-01 open Assets:CN:Bank:BOC:5678 CNY
2020-01-01 open Liabilities:CreditCard:BOC:1234 CNY
2020-01-01 open Assets:CN:Wallet:WeChat CNY
2020-01-01 open Assets:CN:Wallet:WeChat2 CNY
2020-01-01 open Assets:Old CNY
2020-01-01 open Assets:Padded CNY
2020-01-01 open Expenses:Food:Meals:Dine
2020-01-01 open Expenses:Food:Drinks
2020-01-01 open Income:Gifts
2020-01-01 open Income:Salary
2020-01-01 open Equity:Opening
2024-01-01 close Assets:Old
2025-01-01 pad Assets:Padded Equity:Opening
2025-01-02 balance Assets:Padded 100 CNY
2025-02-01 * "Merchant" "comma and inferred amount" #meal ^order-1 ; comment
  time: "12:00:00"
  source: "alipay"
  source-tx-id: "test-order"
  Assets:CN:Bank:BOC:5678 -1,234.50 CNY
  Expenses:Food:Meals:Dine
2025-02-02 * "Foreign" "currency price"
  Assets:Bank:Multi -1 USD @ 7 CNY
  Expenses:Food:Drinks 7 CNY
`;

try {
  fs.writeFileSync(path.join(tmp, "entries.bean"), source);
  fs.writeFileSync(path.join(tmp, "main.bean"), 'include "entries.bean"\n');
  const ledger = parseLedger(tmp, "main.bean", python);
  check("native includes, comments, tags, comma amounts and implicit postings", () => {
    assert.equal(ledger.loader, "beancount-native");
    assert.equal(ledger.accounts.length, 12);
    assert.equal(ledger.transactions.length, 2); // Generated pad is omitted.
    assert.deepEqual(ledger.errors, []);
    const tx = ledger.transactions[0];
    assert.equal(tx.postings[1].amount, 1234.5);
    assert.equal(tx.sourceTxId, "test-order");
    assert.equal(tx.source, "alipay");
    assert.equal(tx.time, "12:00:00");
    assert.deepEqual(tx.tags, ["meal"]);
    assert.deepEqual(tx.links, ["order-1"]);
    assert.equal(tx.file, fs.realpathSync(path.join(tmp, "entries.bean")));
    assert.ok(tx.line);
    assert.deepEqual(ledger.accounts.find((a) => a.account === "Assets:Bank:Multi")?.currencies, ["CNY", "USD"]);
  });
  check("stable source references and native text parsing", () => {
    assert.deepEqual(parseLedger(tmp, "main.bean", python).transactions.map((t) => t.id), ledger.transactions.map((t) => t.id));
    assert.equal(parseLedgerText(source, python).transactions.length, 2);
    assert.equal(validateLedgerFile(path.join(tmp, "main.bean"), python).ok, true);
  });
  check("native validation rejects invalid balances, Chinese tags and inactive accounts", () => {
    assert.equal(validateLedgerText('2020-01-01 open Assets:A\n2025-01-01 * "test"\n  Assets:A = 1 CNY\n', python).ok, false);
    assert.equal(validateLedgerText('2020-01-01 open Assets:A\n2025-01-01 * "test" #中文标签\n  Assets:A 0 CNY\n', python).ok, false);
    assert.equal(validateLedgerText('2026-01-01 open Assets:A\n2025-01-01 * "test"\n  Assets:A 0 CNY\n', python).ok, false);
    const old = ledger.accounts.find((a) => a.account === "Assets:Old")!;
    assert.equal(accountIsActive(old, "2023-01-01", "CNY"), true);
    assert.equal(accountIsActive(old, "2025-01-01", "CNY"), false);
    assert.equal(accountIsActive(ledger.accounts[0], "2025-01-01", "JPY"), false);
  });
  check("missing Python and missing ledger fail explicitly", () => {
    assert.throws(() => parseLedger(tmp, "missing.bean", python), /入口不存在/);
    assert.throws(() => parseLedger(tmp, "main.bean", path.join(tmp, "missing-python")), /无法启动/);
  });
  const config: AppConfig = { ledgerRoot: tmp, mainFile: "main.bean", monthlyDir: "years/{year}/imported", annualLayout: true, pythonPath: python, assetMapping: buildAssetMapping(ledger.accounts), accounts: ledger.accounts.map((a) => a.account), llm: { provider: "off", apiBase: "", model: "", apiKey: "" } };
  const tx = (overrides: Partial<ParsedTx> = {}): ParsedTx => ({ id: "test", date: "2025-02-03", amount: 1234.5, currency: "CNY", direction: "out", payee: "Merchant", note: "", rawCategory: "", rawAccount: "中国银行储蓄卡(5678)", source: "alipay", sourceFile: "test.csv", row: 1, status: "pending", fundingAccount: "Assets:CN:Bank:BOC:5678", suggestedAccount: "", finalAccount: "", confidence: 0, ...overrides });
  check("card suffix and debit/credit determine the actual defined account", () => {
    assert.equal(inferFundingAccount(tx(), config, ledger).account, "Assets:CN:Bank:BOC:5678");
    assert.equal(inferFundingAccount(tx({ rawAccount: "中国银行信用卡(1234)" }), config, ledger).account, "Liabilities:CreditCard:BOC:1234");
    assert.equal(inferFundingAccount(tx({ rawAccount: "中国银行(9999)" }), config, ledger).account, "");
    assert.equal(inferFundingAccount(tx({ rawAccount: "中国银行" }), config, ledger).account, "");
  });
  check("wallet ambiguity, investment wallets and combined payments remain pending", () => {
    assert.equal(inferFundingAccount(tx({ rawAccount: "零钱", source: "wechat" }), config, ledger).account, "");
    assert.equal(inferFundingAccount(tx({ rawAccount: "零钱通", source: "wechat" }), config, ledger).account, "");
    assert.equal(inferFundingAccount(tx({ fundingParts: [{ rawAccount: "零钱" }, { rawAccount: "中国银行(5678)" }] }), config, ledger).account, "");
    const bound = { ...config, assetMapping: [{ keyword: "零钱", account: "Assets:CN:Wallet:WeChat2", kind: "debit" as const }] };
    assert.equal(inferFundingAccount(tx({ rawAccount: "零钱", source: "wechat" }), bound, ledger).account, "Assets:CN:Wallet:WeChat2");
  });
  check("classification rejects undefined memory, wrong direction and transfers as income", () => {
    assert.equal(classifyLocal(tx({ payee: "咖啡" }), { mapping: { "咖啡|": "Expenses:Undefined" } }, ledger)?.account, "Expenses:Food:Drinks");
    assert.equal(classifyLocal(tx({ direction: "in", payee: "咖啡" }), { mapping: {} }, ledger), null);
    assert.equal(classifyLocal(tx({ direction: "in", payee: "转账", eventType: "transfer" }), { mapping: { "转账|": "Income:Gifts" } }, ledger), null);
    assert.equal(classifyLocal(tx({ direction: "in", payee: "微信红包" }), { mapping: {} }, ledger)?.account, "Income:Gifts");
  });
  check("refunds suggest reversing original expenses without auto acceptance", () => {
    const suggestion = classifyLocal(tx({ direction: "in", eventType: "refund", rawCategory: "退款" }), { mapping: { "Merchant|退款": "Income:Gifts" } }, ledger);
    assert.equal(suggestion?.account, "Expenses:Food:Meals:Dine");
    assert.ok(suggestion!.confidence < 0.9);
    const purchase = tx({ id: "new-purchase", payee: "New Merchant", finalAccount: "Expenses:Food:Drinks", confidence: 0.9 });
    const refund = tx({ id: "new-refund", payee: "New Merchant", direction: "in", eventType: "refund" });
    assert.equal(suggestRefundsFromBatch([purchase, refund], ledger), 1);
    assert.equal(refund.finalAccount, "Expenses:Food:Drinks");
    assert.equal(refund.status, "pending");
  });
  assert.equal((await classifyWithLlm([tx()], config, ledger)).size, 0);
  checks++;
  console.log("✓ LLM remains disabled by default");
  if (realRoot) {
    const cache = path.join(realRoot, ".main.bean.picklecache");
    const before = fs.existsSync(cache) ? fs.statSync(cache).mtimeMs : null;
    const actual = parseLedger(realRoot, "main.bean", python);
    check("real ledger reads preserve baseline diagnostics and existing cache", () => {
      assert.equal(actual.loader, "beancount-native");
      assert.ok(actual.accounts.length > 0);
      assert.ok(actual.transactions.length > 0);
      assert.equal(fs.existsSync(cache) ? fs.statSync(cache).mtimeMs : null, before);
    });
  }
  check("legacy settings move into the verified ledger and reload without a project config", () => {
    const cfgRoot = path.join(tmp, "config"), oldFile = path.join(cfgRoot, "config.json");
    fs.mkdirSync(cfgRoot);
    const mapping = [{ keyword: "测试卡", account: "Assets:CN:Bank:BOC:5678", kind: "debit", cardSuffix: "5678" }];
    fs.writeFileSync(oldFile, JSON.stringify({
      ledgerRoot: tmp, mainFile: "main.bean", monthlyDir: "fixture/{year}", annualLayout: false, pythonPath: python,
      assetMapping: mapping, llm: { apiKey: "fixture-secret", model: "fixture-model" }, futurePreference: ["fixture"],
    }));
    const originalEnvironment = process.env.ACCOUNT_IMPORT_LEDGER_ROOT;
    try {
      process.env.ACCOUNT_IMPORT_LEDGER_ROOT = tmp;
      const migrated = loadConfig(cfgRoot);
      assert.equal(migrated.ledgerRoot, tmp);
      assert.deepEqual(migrated.assetMapping, mapping);
      assert.equal(fs.existsSync(oldFile), false);
      const saved = JSON.parse(fs.readFileSync(path.join(tmp, ".beancount-importer.json"), "utf8"));
      assert.deepEqual(saved.futurePreference, ["fixture"]);
      assert.equal(saved.llm.apiKey, "fixture-secret");
      assert.equal(loadConfig(cfgRoot).monthlyDir, "fixture/{year}");
      assert.equal(fs.existsSync(oldFile), false);
    } finally {
      if (originalEnvironment === undefined) delete process.env.ACCOUNT_IMPORT_LEDGER_ROOT;
      else process.env.ACCOUNT_IMPORT_LEDGER_ROOT = originalEnvironment;
    }
  });
  console.log(`${checks} ledger/profile regressions passed`);
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
