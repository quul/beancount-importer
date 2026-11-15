/** Read-only real-statement regression plus accounting boundary cases.
 * node --import tsx scripts/import-regression.ts [statement-directory]
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as XLSX from "xlsx";
import { parseAlipay } from "../src/server/parsers/alipay.js";
import { parseWechat } from "../src/server/parsers/wechat.js";
import { parseDate, parseCsv, readSheet, txId } from "../src/server/parsers/common.js";
import { markDuplicates } from "../src/server/lib/dedup.js";
import { pairTransfers, clearTransferSuggestion } from "../src/server/lib/transfers.js";
import { generateEntries, suggestOpens } from "../src/server/lib/generate.js";
import { parseLedgerText, validateLedgerText } from "../src/server/lib/ledger.js";
import type { LedgerTx, ParsedTx } from "../src/shared/types.js";

let checks = 0;
function check(label: string, test: () => void) { test(); checks++; console.log(`✓ ${label}`); }
function tx(patch: Partial<ParsedTx> = {}): ParsedTx {
  return { id: "sample", date: "2025-10-31", time: "12:00:00", amount: 5, direction: "out", currency: "CNY", payee: "商户甲", note: "商品", rawCategory: "日用百货", rawAccount: "农业银行信用卡(9065)", source: "alipay", sourceFile: "sample.csv", row: 2, sourceTxId: "source-001", status: "ready", fundingAccount: "Liabilities:CreditCard:ABC:9065", suggestedAccount: "Expenses:Shopping", finalAccount: "Expenses:Shopping", confidence: 0.9, eventType: "expense", ...patch };
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bean-import-regression-"));
try {
  check("strict dates and CSV tabs preserve source identifiers", () => {
    assert.equal(parseDate("2025-02-30"), null); assert.equal(parseDate("2025-13-01"), null); assert.equal(parseDate("2025-01-01 25:00"), null);
    assert.deepEqual(parseCsv("a,b,c\n1,ID\t,3"), [["a", "b", "c"], ["1", "ID\t", "3"]]);
    assert.equal(txId("2025-01-01", 5, "out", "商户", 1, "alipay", "id"), txId("2026-01-01", 8, "in", "别名", 99, "alipay", "id"));
  });
  check("extensionless Excel follows the binary signature", () => {
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["交易时间", "金额"], ["2025-01-01", "5"]]), "流水");
    const file = path.join(tmp, "extensionless"); fs.writeFileSync(file, XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
    assert.equal(readSheet(file).rows.length, 2);
  });
  const alipayHeader = "交易时间,交易分类,交易对方,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号";
  const aliRows = [
    "2025-10-31 10:00:00,餐饮美食,餐馆,原订单,不计收支,20,农业银行信用卡(9065),退款成功,original",
    "2025-10-31 11:00:00,退款,餐馆,退款,不计收支,20,农业银行信用卡(9065),退款成功,refund",
    "2025-10-31 12:00:00,日用百货,商店,关闭,支出,5,余额,交易关闭,closed",
    "2025-10-31 13:00:00,日用百货,商店,免费,支出,0,余额,交易成功,free",
    "2025-10-31 14:00:00,信用借还,银行,还款,不计收支,500,余额,还款成功,repay",
  ];
  const aliFile = path.join(tmp, "alipay.csv"); fs.writeFileSync(aliFile, [alipayHeader, ...aliRows].join("\n"));
  check("refund originals, refund inflows and excluded rows all remain visible", () => {
    const parsed = parseAlipay(aliFile); assert.equal(parsed.txs.length, 5);
    assert.equal(parsed.txs[0].eventType, "expense"); assert.equal(parsed.txs[0].direction, "out");
    assert.equal(parsed.txs[1].eventType, "refund"); assert.equal(parsed.txs[1].direction, "in");
    assert.ok(parsed.txs[2].excludedReason); assert.ok(parsed.txs[3].excludedReason); assert.equal(parsed.txs[4].eventType, "transfer");
    const ids = new Map(parsed.txs.map((item) => [item.sourceTxId, item.id]));
    fs.writeFileSync(aliFile, ["导出说明", alipayHeader, ...[...aliRows].reverse()].join("\n"));
    for (const item of parseAlipay(aliFile).txs) assert.equal(item.id, ids.get(item.sourceTxId));
  });
  check("unknown WeChat states are retained and visibly need review", () => {
    const file = path.join(tmp, "wechat.csv");
    fs.writeFileSync(file, "交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号\n2025-01-01 12:00:00,其他,平台,说明,收入,10,零钱,新状态,wx-unknown");
    const parsed = parseWechat(file); assert.equal(parsed.txs.length, 1); assert.ok(parsed.txs[0].issues?.some((issue) => issue.includes("未识别交易状态")));
  });
  const ledger: LedgerTx[] = [{ id: "booked-1", date: "2025-10-31", payee: "商户甲", narration: "人工账本", file: "history.bean", line: 10, postings: [{ account: "Liabilities:CreditCard:ABC:9065", amount: -5, currency: "CNY" }, { account: "Expenses:Shopping", amount: 5, currency: "CNY" }] }];
  check("two same-value purchases do not disappear against one historical posting", () => {
    const rows = [tx(), tx({ id: "other", payee: "商户乙", sourceTxId: "source-002" })];
    const result = markDuplicates(rows, ledger); assert.equal(result.stats.ledgerDuplicates, 0); assert.ok(rows.every((item) => item.status === "pending" && item.matches?.length === 1));
  });
  check("opposite directions, currencies and unrelated funding accounts do not match", () => {
    const rows = [tx({ direction: "in" }), tx({ id: "usd", currency: "USD", sourceTxId: "usd" })];
    markDuplicates(rows, ledger); assert.ok(rows.every((item) => item.status === "ready" && item.matches?.every((match) => match.reason === "历史分类参考，不作为重复依据")));
    const cross = [tx({ fundingAccount: "Assets:Bank:BOC" }), tx({ id: "bank", source: "bank-icbc", sourceTxId: "bank", fundingAccount: "Assets:Bank:ICBC" })];
    markDuplicates(cross, []); assert.ok(cross.every((item) => item.status === "ready"));
  });
  check("source transaction IDs provide repeat-upload and ledger idempotency", () => {
    const rows = [tx(), tx({ id: "instance-2" })]; assert.equal(markDuplicates(rows, []).stats.crossSourceDuplicates, 1); assert.equal(rows[1].status, "duplicate");
    const existing = [{ ...ledger[0], source: "alipay", sourceTxId: "source-001" }]; const imported = tx();
    assert.equal(markDuplicates([imported], existing).stats.ledgerDuplicates, 1); assert.equal(imported.duplicateOf?.id, "booked-1");
  });
  check("proven ledger duplicates expose the complete original posting evidence", () => {
    const imported = tx(), existing = [{ ...ledger[0], source: "alipay", sourceTxId: imported.sourceTxId }];
    markDuplicates([imported], existing); assert.equal(imported.status, "duplicate"); assert.equal(imported.matches?.length, 1);
    assert.deepEqual(imported.matches?.[0], { id: "booked-1", date: "2025-10-31", payee: "商户甲", narration: "人工账本", file: "history.bean", line: 10, postings: ledger[0].postings, reason: "来源交易号已存在于账本" });
  });
  check("different-value merchant history is reference only, including unresolved wallets", () => {
    const reference = tx({ amount: 99, date: "2026-01-01", fundingAccount: "", confidence: 0.63, issues: ["钱包待确认"] });
    const originals = Array.from({ length: 8 }, (_, index) => ({ ...ledger[0], id: `history-${index}`, date: `2025-10-${String(index + 1).padStart(2, "0")}` }));
    markDuplicates([reference], originals); assert.equal(reference.status, "ready"); assert.equal(reference.confidence, 0.63); assert.deepEqual(reference.issues, ["钱包待确认"]);
    assert.equal(reference.matches?.length, 5); assert.ok(reference.matches?.every((match) => match.reason === "历史分类参考，不作为重复依据"));
    assert.equal(reference.matches?.[0].date, "2025-10-08"); assert.equal(new Set(reference.matches?.map((match) => match.id)).size, 5);
  });
  check("ID-less files use file hash plus row without collapsing identical source lines", () => {
    const sourceFileHash = "a".repeat(64), noId = { sourceTxId: undefined, sourceFileHash, source: "bank-icbc" as const };
    const rows = [tx({ ...noId, id: "line-1", row: 2 }), tx({ ...noId, id: "line-2", row: 3 }), tx({ ...noId, id: "reupload-line-1", row: 2 })];
    assert.equal(markDuplicates(rows, []).stats.crossSourceDuplicates, 1); assert.equal(rows[0].status, "ready"); assert.equal(rows[1].status, "ready"); assert.equal(rows[2].status, "duplicate");
    const imported = [{ ...ledger[0], source: "bank-icbc", sourceTxId: undefined, metadata: { "source-file-hash": sourceFileHash, "source-row": "2" } }];
    assert.equal(markDuplicates([tx({ ...noId, row: 2 })], imported).stats.ledgerDuplicates, 1);
    assert.equal(markDuplicates([tx({ ...noId, row: 3 })], imported).stats.ledgerDuplicates, 0);
    assert.equal(markDuplicates([tx({ ...noId, sourceFileHash: "b".repeat(64), row: 2 })], imported).stats.ledgerDuplicates, 0);
  });
  check("transfer suggestions never consume both matching inflows or auto-approve", () => {
    const base = { eventType: "transfer" as const, payee: "转账", sourceTxId: undefined, status: "pending" as const };
    const a = tx({ ...base, id: "a", direction: "in", fundingAccount: "Assets:A" });
    const b = tx({ ...base, id: "b", direction: "out", fundingAccount: "Assets:B" });
    const c = tx({ ...base, id: "c", direction: "in", fundingAccount: "Assets:C" });
    assert.equal(pairTransfers([a, b, c]).pairs.length, 0);
    const result = pairTransfers([a, b]); assert.equal(result.pairs.length, 1); assert.equal(result.absorbed.size, 0); assert.equal(a.status, "pending");
    assert.equal(b.matches?.[0].id, "a"); assert.equal(b.matches?.[0].postings[0].amount, -5);
    clearTransferSuggestion(b); assert.equal(b.matches?.length, 0);
  });
  check("generator preserves currency, reviewed postings, tags and provenance", () => {
    const row = tx({ currency: "HKD", flag: "!", tags: ["trip", "refund"], reviewNote: "核对完成", postings: [{ account: "Expenses:Shopping", amount: 6, currency: "HKD" }, { account: "Assets:Wallet", amount: -5, currency: "HKD" }, { account: "Equity:Coupons:Payment", amount: -1, currency: "HKD" }] });
    const result = generateEntries([row], "batch-test"); assert.deepEqual(result.errors, []); assert.equal(result.generated.length, 1);
    assert.match(result.entries, /2025-10-31 ! .* #trip #refund/); assert.match(result.entries, /import-batch: "batch-test"/); assert.match(result.entries, /import-id: "source-001"/);
    assert.match(result.entries, /Equity:Coupons:Payment  -1\.00 HKD/); assert.ok(!result.entries.includes(" CNY"));
    assert.ok(suggestOpens([row], new Set()).every((line) => line.startsWith("2025-10-31 open")));
  });
  check("unbalanced, incomplete split and income-classified refunds are rejected", () => {
    assert.ok(generateEntries([tx({ postings: [{ account: "Assets:A", amount: 5, currency: "CNY" }, { account: "Expenses:Other", amount: -4, currency: "CNY" }] })]).errors?.length);
    assert.ok(generateEntries([tx({ fundingParts: [{ rawAccount: "银行卡" }, { rawAccount: "红包" }] })]).errors?.length);
    assert.ok(generateEntries([tx({ eventType: "refund", direction: "in", finalAccount: "Income:Refund" })]).errors?.length);
  });
  check("only certified day-end balance becomes a next-day standalone directive", () => {
    const row = tx({ source: "bank-icbc", fundingAccount: "Assets:Bank:ICBC", balanceAfter: 100 });
    assert.ok(!generateEntries([row]).entries.includes(" balance "));
    const result = generateEntries([{ ...row, balanceIsDayEnd: true }]);
    assert.match(result.entries, /2025-11-01 balance Assets:Bank:ICBC 100\.00 CNY/); assert.ok(result.monthFiles["202511"]); assert.ok(!result.entries.includes(" = "));
    const pending = tx({ id: "pending", fundingAccount: row.fundingAccount, status: "pending" });
    assert.ok(!generateEntries([{ ...row, balanceIsDayEnd: true }, pending]).entries.includes(" balance "));
  });
  const configFile = path.resolve(import.meta.dirname, "../server-data/config.json");
  const nativePython = process.env.ACCOUNT_IMPORT_PYTHON || (fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, "utf8")).pythonPath as string | undefined : undefined);
  if (nativePython) {
    check("native Beancount validates generated metadata, tags, currencies and next-day balance", () => {
      const row = tx({ source: "bank-icbc", fundingAccount: "Assets:Bank:ICBC", balanceAfter: 100, balanceIsDayEnd: true, tags: ["reviewed", "trip.one"], flag: "!", sourceFile: 'source "quoted".csv', note: "商品\\备注\n第二行" });
      const output = generateEntries([row], "native-test"); assert.deepEqual(output.errors, []);
      const text = ["2025-10-30 open Assets:Bank:ICBC CNY", "2025-10-30 open Equity:Opening CNY", "2025-10-30 open Expenses:Shopping CNY", '2025-10-30 * "Opening"', "  Assets:Bank:ICBC 105 CNY", "  Equity:Opening -105 CNY", output.entries].join("\n");
      const validation = validateLedgerText(text, nativePython); assert.deepEqual(validation.errors, []); assert.equal(validation.ok, true);
      const parsed = parseLedgerText(text, nativePython), imported = parsed.transactions.find((item) => item.sourceTxId === "source-001");
      assert.ok(imported); assert.equal(imported.source, "bank-icbc"); assert.ok(imported.tags?.includes("reviewed")); assert.equal(imported.time, "12:00:00");
      assert.equal(markDuplicates([tx({ source: "bank-icbc", fundingAccount: "Assets:Bank:ICBC" })], parsed.transactions).stats.ledgerDuplicates, 1);
      const foreign = tx({ currency: "HKD", fundingAccount: "Assets:Wallet", postings: [{ account: "Assets:Wallet", amount: -5, currency: "HKD" }, { account: "Expenses:Shopping", amount: 5, currency: "HKD" }] });
      const foreignText = [...suggestOpens([foreign], new Set()), generateEntries([foreign]).entries].join("\n");
      assert.deepEqual(validateLedgerText(foreignText, nativePython).errors, []);
      const noId = tx({ sourceTxId: undefined, source: "bank-icbc", sourceFileHash: "a".repeat(64) });
      const noIdText = [...suggestOpens([noId], new Set()), generateEntries([noId]).entries].join("\n");
      const noIdLedger = parseLedgerText(noIdText, nativePython); assert.deepEqual(noIdLedger.errors, []);
      assert.equal(markDuplicates([structuredClone(noId)], noIdLedger.transactions).stats.ledgerDuplicates, 1);
    });
  } else console.log("Native generation validation skipped: set ACCOUNT_IMPORT_PYTHON to a Beancount environment.");

  const statementDir = process.argv[2] ?? process.env.STATEMENT_DIR;
  if (statementDir) {
    const names = fs.readdirSync(statementDir), ali = names.find((name) => name.endsWith(".csv")), wx = names.find((name) => name.endsWith(".xlsx"));
    assert.ok(ali && wx, "real regression needs the Alipay CSV and WeChat XLSX");
    const alipay = parseAlipay(path.join(statementDir, ali)), wechat = parseWechat(path.join(statementDir, wx));
    check("real source completeness: 1064 Alipay + 444 WeChat = 1508 rows", () => {
      assert.equal(alipay.txs.length, 1064); assert.equal(wechat.txs.length, 444); assert.equal(alipay.errors.length + wechat.errors.length, 0);
      assert.equal(alipay.txs.filter((item) => item.excludedReason).length, 38);
      assert.equal(wechat.txs.filter((item) => item.excludedReason).length, 0);
      assert.ok(wechat.txs.filter((item) => ["已到账", "已全额退款", "对方已退还", "资金已到账", "充值完成"].includes(item.sourceStatus ?? "")).length >= 89);
    });
    check("real 30 refund inflows, 31 refunded originals and split amounts survive", () => {
      const refunds = alipay.txs.filter((item) => item.rawCategory === "退款"); assert.equal(refunds.length, 30); assert.ok(refunds.every((item) => item.eventType === "refund" && item.direction === "in"));
      const originals = alipay.txs.filter((item) => item.sourceStatus === "退款成功" && item.rawCategory !== "退款"); assert.equal(originals.length, 31); assert.ok(originals.every((item) => item.direction === "out" && item.eventType === "expense"));
      const split = wechat.txs.find((item) => item.fundingParts?.length === 2); assert.deepEqual(split?.fundingParts?.map((part) => part.amount), [78.41, 31.59]);
      assert.equal(alipay.txs.filter((item) => item.fundingParts?.length).length, 259);
      assert.equal(alipay.txs.filter((item) => item.fundingParts?.length && !item.excludedReason).length, 253);
    });
    check("real XLSX parses identically from an upload-style extensionless path", () => {
      const uploaded = path.join(tmp, "uploaded-file"); fs.copyFileSync(path.join(statementDir, wx), uploaded);
      const parsed = parseWechat(uploaded); assert.equal(parsed.txs.length, 444); assert.deepEqual(parsed.txs.map((item) => item.id), wechat.txs.map((item) => item.id));
    });
    console.log(JSON.stringify({ realRows: 1508, excluded: alipay.txs.filter((item) => item.excludedReason).length, alipayRefunds: 30, wechatRefunds: wechat.txs.filter((item) => item.eventType === "refund").length }));
  }
  console.log(`Import regression passed (${checks} checks).`);
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
