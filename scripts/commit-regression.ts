/** Commit isolation/recovery fixtures. Only disposable ledgers are ever written. */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverLedgerRoot } from "../src/server/config.js";
import { discoverPython, parseLedger } from "../src/server/lib/ledger.js";
import { profileId, type StoredBatch } from "../src/server/lib/batches.js";
import { commitBatch, ImportError } from "../src/server/lib/commit.js";
import { generateEntries } from "../src/server/lib/generate.js";
import type { AppConfig, ParsedTx } from "../src/shared/types.js";

const python = discoverPython(discoverLedgerRoot());
const requestedTmp = fs.mkdtempSync(path.join(os.tmpdir(), "bean-commit-regression-"));
const tmp = fs.realpathSync(requestedTmp);
let checks = 0;
let serial = 0;
function check(label: string, run: () => void) { run(); checks++; console.log(`✓ ${label}`); }
function fixture(name: string) {
  const home = path.join(tmp, name), root = path.join(home, "ledger"), data = path.join(home, "data");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "accounts.bean"), "2020-01-01 open Assets:Test CNY\n2020-01-01 open Expenses:Test\n");
  fs.writeFileSync(path.join(root, "main.bean"), 'include "accounts.bean"\n');
  const config: AppConfig = { ledgerRoot: root, mainFile: "main.bean", monthlyDir: "years/{year}/imported", annualLayout: true, pythonPath: python, assetMapping: [], accounts: [], llm: { provider: "off", apiBase: "", apiKey: "", model: "" } };
  return { root, data, config };
}
function batch(root: string, overrides: Partial<ParsedTx> = {}): StoredBatch {
  serial++;
  const tx: ParsedTx = { id: `row-${serial}`, date: "2025-02-01", time: "12:00:00", amount: serial + 1, direction: "out", currency: "CNY", payee: "Fixture merchant", note: "", rawCategory: "", rawAccount: "test", source: "alipay", sourceTxId: `source-${serial}`, sourceFile: "fixture.csv", row: serial, status: "ready", fundingAccount: "Assets:Test", finalAccount: "Expenses:Test", suggestedAccount: "Expenses:Test", confidence: 1, eventType: "expense", ...overrides };
  const value: StoredBatch = { batchId: `b${Date.now()}-${crypto.randomBytes(6).toString("hex")}`, file: "fixture.csv", source: "alipay", txCount: 1, txs: [tx], errors: [], accountsDetected: [], createdAt: Date.now(), revision: 1, committed: false, ledgerProfile: profileId(root, "main.bean") };
  value.preview = { revision: 1, result: generateEntries(value.txs, value.batchId), opens: [] };
  return value;
}
function expectError(run: () => unknown, status: number, message: RegExp) {
  assert.throws(run, (error) => error instanceof ImportError && error.status === status && message.test(error.message));
}

try {
  check("pre-existing diagnostics stay baseline and expose original paths", () => {
    const f = fixture("baseline");
    fs.writeFileSync(path.join(f.root, "old.bean"), '2025-01-01 * "old"\n  Assets:NotOpen -1 CNY\n  Expenses:Test 1 CNY\n');
    fs.appendFileSync(path.join(f.root, "main.bean"), 'include "old.bean"\n');
    const result = commitBatch(batch(f.root), f.config, f.root, f.data);
    assert.equal(result.ok, true);
    assert.equal(result.validation?.baselineErrors.length, 1);
    assert.equal(result.validation?.newErrors.length, 0);
    assert.equal(result.validation?.baselineErrors[0].file, path.join(f.root, "old.bean"));
  });
  check("internal absolute includes remain isolated after planned main/annual writes", () => {
    const f = fixture("absolute");
    fs.mkdirSync(path.join(f.root, "years", "2025"), { recursive: true });
    fs.renameSync(path.join(f.root, "accounts.bean"), path.join(f.root, "accounts.txt"));
    const aliasRoot = path.join(requestedTmp, "absolute", "ledger").replaceAll("\\", "/");
    fs.writeFileSync(path.join(f.root, "years", "2025", "2025.bean"), "; annual\n");
    fs.writeFileSync(path.join(f.root, "main.bean"), `include "${aliasRoot}/accounts.txt"\ninclude "${aliasRoot}/years/2025/2025.bean"\n`);
    const input = batch(f.root);
    const result = commitBatch(input, f.config, f.root, f.data);
    assert.equal(result.ok, true);
    const actual = parseLedger(f.root, "main.bean", python);
    assert.deepEqual(actual.errors, []);
    assert.equal(actual.transactions.filter((tx) => tx.metadata?.["import-batch"] === input.batchId).length, 1);
    assert.equal(fs.readFileSync(path.join(f.root, "main.bean"), "utf8").split("\n").filter((line) => line.includes("2025.bean")).length, 1);
  });
  check("external absolute includes reject before original ledger changes", () => {
    const f = fixture("outside");
    const external = path.join(tmp, "outside", "external.bean");
    fs.writeFileSync(external, "; external\n");
    fs.appendFileSync(path.join(f.root, "main.bean"), `include "${external.replaceAll("\\", "/")}"\n`);
    const before = fs.readFileSync(path.join(f.root, "main.bean"), "utf8");
    expectError(() => commitBatch(batch(f.root), f.config, f.root, f.data), 422, /include 超出/);
    assert.equal(fs.readFileSync(path.join(f.root, "main.bean"), "utf8"), before);
    assert.equal(fs.existsSync(path.join(f.root, "years")), false);
  });
  check("symlink includes reject explicitly", () => {
    const f = fixture("symlink");
    const destination = path.join(f.root, "definitions");
    fs.mkdirSync(destination);
    fs.renameSync(path.join(f.root, "accounts.bean"), path.join(destination, "accounts.bean"));
    fs.symlinkSync(destination, path.join(f.root, "linked"), "junction");
    fs.writeFileSync(path.join(f.root, "main.bean"), 'include "linked/accounts.bean"\n');
    expectError(() => commitBatch(batch(f.root), f.config, f.root, f.data), 400, /符号链接/);
  });
  check("a partial older batch is rolled back before a different batch commits", () => {
    const f = fixture("recovery");
    const main = fs.readFileSync(path.join(f.root, "main.bean"), "utf8");
    const oldBatch = batch(f.root), newBatch = batch(f.root);
    const leftover = "; interrupted draft\n";
    fs.writeFileSync(path.join(f.root, "leftover.bean"), leftover);
    fs.mkdirSync(path.join(f.data, "commits"), { recursive: true });
    const journal = path.join(f.data, "commits", `${oldBatch.batchId}.json`);
    fs.writeFileSync(journal, JSON.stringify({ batchId: oldBatch.batchId, ledgerProfile: oldBatch.ledgerProfile, status: "writing", changes: [
      { relative: "leftover.bean", before: null, after: leftover },
      { relative: "main.bean", before: main, after: main + 'include "leftover.bean"\n' },
    ], written: ["leftover.bean"], validation: { baselineErrors: [], newErrors: [] } }));
    assert.equal(commitBatch(newBatch, f.config, f.root, f.data).ok, true);
    assert.equal(fs.existsSync(path.join(f.root, "leftover.bean")), false);
    assert.equal(JSON.parse(fs.readFileSync(journal, "utf8")).status, "rolled-back");
    assert.equal(parseLedger(f.root, "main.bean", python).transactions.length, 1);
  });
  check("a source ID added after preview is detected from the snapshot", () => {
    const f = fixture("late-duplicate");
    const input = batch(f.root);
    fs.writeFileSync(path.join(f.root, "late.bean"), input.preview!.result.entries);
    fs.appendFileSync(path.join(f.root, "main.bean"), 'include "late.bean"\n');
    expectError(() => commitBatch(input, f.config, f.root, f.data), 409, /已包含/);
    assert.equal(fs.existsSync(path.join(f.root, "years")), false);
  });
  check("new native validation errors prevent every original write", () => {
    const f = fixture("invalid");
    const before = fs.readFileSync(path.join(f.root, "main.bean"), "utf8");
    const input = batch(f.root, { finalAccount: "Expenses:NotOpen" });
    expectError(() => commitBatch(input, f.config, f.root, f.data), 422, /新增校验错误/);
    assert.equal(fs.readFileSync(path.join(f.root, "main.bean"), "utf8"), before);
    assert.equal(fs.existsSync(path.join(f.root, "years")), false);
  });
  check("template routes each reviewed transaction and includes each account open only once", () => {
    const f = fixture("routed");
    f.config.monthlyDir = "years/{year}/{month}/{source}/{account}";
    const input = batch(f.root, { finalAccount: "Expenses:New" });
    input.txs.push(...batch(f.root, { source: "wechat", finalAccount: "Expenses:New", postings: [
      { account: "Assets:Other", amount: -6, currency: "CNY" },
      { account: "Expenses:New", amount: 6, currency: "CNY" },
    ] }).txs);
    const preview = generateEntries(input.txs, input.batchId, f.config);
    input.preview = { revision: 1, result: preview, opens: ["2025-02-01 open Assets:Other CNY", "2025-02-01 open Expenses:New"] };
    const files = ["years/2025/02/alipay/Assets_Test/2025-02.bean", "years/2025/02/wechat/Assets_Other/2025-02.bean"];
    assert.deepEqual(Object.keys(preview.files), files);
    expectError(() => commitBatch(input, { ...f.config, monthlyDir: "elsewhere" }, f.root, f.data), 409, /预览与当前批次不一致/);
    assert.deepEqual(commitBatch(input, f.config, f.root, f.data).written, files);
    for (const [index, file] of files.entries()) {
      const contents = fs.readFileSync(path.join(f.root, file), "utf8");
      assert.ok(contents.includes(input.txs[index].id));
      assert.ok(!contents.includes(input.txs[1 - index].id));
    }
    const actual = parseLedger(f.root, "main.bean", python);
    assert.deepEqual(actual.errors, []);
    assert.equal(actual.transactions.length, 2);
  });
  check("flat-layout templates also route month-end balances by their directive date", () => {
    const f = fixture("balance");
    f.config.annualLayout = false;
    f.config.monthlyDir = "months/{year}\\{month}/{source}/{account}";
    const input = batch(f.root, { source: "bank-boc", date: "2025-02-28", amount: 12.34, balanceIsDayEnd: true, balanceAfter: -12.34 });
    input.preview!.result = generateEntries(input.txs, input.batchId, f.config);
    const result = commitBatch(input, f.config, f.root, f.data);
    assert.deepEqual(result.written, ["months/2025/02/bank-boc/Assets_Test/202502.beancount", "months/2025/03/bank-boc/Assets_Test/202503.beancount"]);
    assert.match(fs.readFileSync(path.join(f.root, result.written[1]), "utf8"), /2025-03-01 balance Assets:Test/);
    assert.deepEqual(parseLedger(f.root, "main.bean", python).errors, []);
  });
  console.log(`${checks} isolated commit regressions passed`);
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
