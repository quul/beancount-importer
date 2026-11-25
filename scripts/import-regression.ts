/** Read-only real-statement regression plus accounting boundary cases.
 * node --import tsx scripts/import-regression.ts [statement-directory]
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import iconv from "iconv-lite";
import * as XLSX from "xlsx";
import { isAlipay, parseAlipay } from "../src/server/parsers/alipay.js";
import { parseWechat } from "../src/server/parsers/wechat.js";
import { parseDate, parseCsv, readSheet, readTextSmart, txId } from "../src/server/parsers/common.js";
import { markDuplicates } from "../src/server/lib/dedup.js";
import { matchStatementRefunds, syncStatementRefunds } from "../src/server/lib/refunds.js";
import { pairTransfers, clearTransferSuggestion } from "../src/server/lib/transfers.js";
import { generateEntries, suggestOpens } from "../src/server/lib/generate.js";
import { inferFundingAccount } from "../src/server/lib/accounts.js";
import { parseLedgerText, validateLedgerText } from "../src/server/lib/ledger.js";
import { readStoredConfig } from "../src/server/config.js";
import { isFamilyCard } from "../src/shared/types.js";
import type { AppConfig, LedgerTx, ParsedTx } from "../src/shared/types.js";

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
  check("Alipay excludes only uniquely paired balance transfers to Yu'ebao", () => {
    const file = path.join(tmp, "alipay-wallet-transfers.csv");
    const receipt = (time: string, amount: number, id: string, method = "账户余额", status = "交易成功") =>
      `${time},转账红包,测试付款人,收款,收入,${amount},${method},${status},${id}`;
    const transfer = (time: string, amount: number, id: string, description = "转账收款到余额宝") =>
      `${time},投资理财,余额宝,${description},不计收支,${amount},账户余额,交易成功,${id}`;
    fs.writeFileSync(file, [alipayHeader + ",备注",
      transfer("2026-01-02 00:00:20", 10, "paired") + ",测试备注",
      receipt("2026-01-01 23:59:50", 10, "kept"),
      transfer("2026-01-02 12:00:10", 20, "ambiguous"),
      receipt("2026-01-02 12:00:06", 20, "receipt-one"),
      receipt("2026-01-02 12:00:07", 20, "receipt-two"),
      transfer("2026-01-02 12:00:11", 30, "shared-one"),
      transfer("2026-01-02 12:00:12", 30, "shared-two"),
      receipt("2026-01-02 12:00:09", 30, "shared-receipt"),
      transfer("2026-01-02 12:00:31", 40, "too-late"),
      receipt("2026-01-02 12:00:00", 40, "old-receipt"),
      transfer("2026-01-02 12:00:10", 50, "bank-receipt"),
      receipt("2026-01-02 12:00:09", 50, "bank", "银行卡"),
      transfer("2026-01-02 12:00:10", 60, "failed-receipt"),
      receipt("2026-01-02 12:00:09", 60, "failed", "账户余额", "交易失败"),
      transfer("2026-01-02 12:00:10", 70, "remark-only", "普通说明") + ",转账收款到余额宝",
      receipt("2026-01-02 12:00:09", 70, "ordinary-receipt"),
      transfer("2026-01-02 12:00", 80, "missing-seconds"),
      receipt("2026-01-02 11:59:59", 80, "before-minute"),
      "2026-01-02 12:00:10,投资理财,测试基金,余额宝-2026.01.01-收益发放,不计收支,1,余额宝,交易成功,interest",
    ].join("\n"));
    const { txs, errors } = parseAlipay(file);
    assert.deepEqual(errors, []);
    assert.equal(txs.length, 19);
    assert.deepEqual(txs.filter((tx) => tx.excludedReason).map(({ sourceTxId, excludedReason }) => [sourceTxId, excludedReason]), [
      ["paired", "支付宝余额转入余额宝"], ["failed", "交易未完成：交易失败"],
    ]);
    assert.equal(txs[0].eventType, "transfer");
    assert.deepEqual([txs[1].direction, txs[1].eventType], ["in", "income"]);
    assert.ok(txs[2].issues?.includes("收支待确认"));
  });
  check("Alipay posts successful Yu'ebao distributions as income when the export labels them neutral", () => {
    const file = path.join(tmp, "alipay-yuebao-interest.csv");
    fs.writeFileSync(file, [alipayHeader + ",备注",
      "2026-01-02 12:00:00,投资理财,测试基金,余额宝-2026.01.01-收益发放,不计收支,0.06,余额宝,交易成功,interest,测试备注",
      "2026-01-02 12:00:01,投资理财,测试基金,余额宝-2026.01.01-收益发放,不计收支,0.06,余额宝,交易失败,failed",
      "2026-01-02 12:00:02,投资理财,测试基金,其他理财业务,不计收支,0.06,余额宝,交易成功,other,余额宝-2026.01.01-收益发放",
      "2026-01-02 12:00:03,餐饮美食,测试商户,午餐,支出,12,余额宝,交易成功,purchase",
    ].join("\n"));
    const { txs, errors } = parseAlipay(file);
    assert.deepEqual(errors, []);
    assert.deepEqual(txs.map(({ direction, eventType, excludedReason }) => [direction, eventType, excludedReason]), [
      ["in", "income", undefined],
      ["out", "unknown", "交易未完成：交易失败"],
      ["out", "unknown", undefined],
      ["out", "expense", undefined],
    ]);
    assert.equal(txs[0].originalDirection, "不计收支");
    assert.deepEqual(txs[0].issues, []);
  });
  check("legacy Alipay GBK headers parse transaction columns and skip the report summary", () => {
    const file = path.join(tmp, "renamed-statement.csv");
    const text = [
      "支付宝交易记录明细查询",
      "交易号,商家订单号,交易创建时间,付款时间,最近修改时间,交易来源地,类型,交易对方,商品名称,金额（元）,收/支,交易状态,服务费（元）,成功退款（元）,备注,资金状态,",
      "2026112000000001\t,订单甲,2026-11-20 23:58:00,2026-11-21 00:02:00,2026-11-21 00:02:00,,即时到账交易,示例商店,示例商品,12.34,支出,交易成功,0.03,0.00,测试备注,已支出,",
      "2026112000000002\t,订单乙,2026-11-20 18:00:00,,,,支付宝担保交易,示例商店,其他商品,5.00,不计收支,交易关闭,0.00,0.00,,,",
      "------------------------",
      "共2笔记录",
      "收入共0笔,0.00",
      "支出共1笔,12.34",
    ].join("\r\n");
    fs.writeFileSync(file, iconv.encode(text, "gbk"));
    assert.ok(isAlipay(file, path.basename(file)));
    const { txs, errors } = parseAlipay(file);
    assert.deepEqual(errors, []);
    assert.equal(txs.length, 2);
    assert.equal(txs[0].sourceTxId, "2026112000000001");
    assert.equal(txs[0].date, "2026-11-20");
    assert.equal(txs[0].time, "23:58:00");
    assert.equal(txs[0].amount, 12.34);
    assert.equal(txs[0].payee, "示例商店");
    assert.equal(txs[0].rawCategory, "即时到账交易");
    assert.equal(txs[0].rawAccount, "");
    assert.ok(txs[1].excludedReason);
  });
  check("unknown WeChat states are retained and visibly need review", () => {
    const file = path.join(tmp, "wechat.csv");
    fs.writeFileSync(file, "交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号\n2025-01-01 12:00:00,其他,平台,说明,收入,10,零钱,新状态,wx-unknown");
    const parsed = parseWechat(file); assert.equal(parsed.txs.length, 1); assert.ok(parsed.txs[0].issues?.some((issue) => issue.includes("未识别交易状态")));
  });
  check("WeChat rules detect paid activity rewards with missing payment methods", () => {
    const file = path.join(tmp, "wechat-activity.csv");
    fs.writeFileSync(file, [
      "交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,备注",
      "2026-08-29 23:45:16,其他,活动奖励_01_测试,/,收入,¥0.38,/,已到账,reward,活动奖励_01_测试",
      "2026-08-29 23:46:16,其他,活动奖励_01_测试,/,收入,0.38,／,已到账,reward-wide,活动奖励_01_测试",
      "2026-08-29 23:47:16,其他,活动奖励_01_测试,/,收入,0.38,银行卡,已到账,explicit",
      "2026-08-29 23:48:16,其他,普通收款,/,收入,0.38,/,已到账,ordinary,活动奖励_01_测试",
      "2026-08-29 23:49:16,其他,活动奖励_01_测试,/,收入,0.38,/,等待到账,waiting",
      "2026-08-29 23:50:16,其他,活动奖励_01_测试,/,支出,0.38,/,已到账,expense",
      "2026-08-29 23:51:16,商户消费,活动奖励_01_测试,/,收入,0.38,/,已到账,different-category",
    ].join("\n"));
    const parsed = parseWechat(file);
    assert.deepEqual(parsed.errors, []);
    assert.deepEqual(parsed.txs.filter((item) => item.recognition).map((item) => item.sourceTxId), ["reward", "reward-wide"]);
    const reward = parsed.txs[0];
    assert.deepEqual(reward.recognition, { label: "活动奖励", fundingMethod: "零钱" });
    assert.equal(reward.eventType, "income");
    assert.equal(reward.rawCategory, "其他");
    assert.equal(reward.rawAccount, "/");
    assert.equal(parseWechat(file, []).txs[0].recognition, undefined);
  });
  check("WeChat wallet and Lingqiantong moves are excluded in both directions", () => {
    const file = path.join(tmp, "wechat-internal-transfers.csv");
    fs.writeFileSync(file, [
      "交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号",
      "2026-08-29 12:00:00,转入零钱通-来自零钱,/,/,/,10,零钱,支付成功,to-investment",
      "2026-08-29 13:00:00,零钱通转出-到零钱,/,/,/,10,/,已到账,to-wallet",
      "2026-08-29 14:00:00,转入零钱通,/,/,/,20,中国银行储蓄卡(1111),支付成功,from-bank",
      "2026-08-29 15:00:00,零钱通转出-到银行卡,/,/,/,30,中国银行储蓄卡(1111),已到账,to-bank",
      "2026-08-29 16:00:00,商户消费,测试商户,午餐,支出,5,零钱通,支付成功,purchase",
      "2026-08-29 17:00:00,转入零钱通-来自零钱,/,/,/,10,零钱,支付失败,failed",
    ].join("\n"));
    const parsed = parseWechat(file);
    assert.deepEqual(parsed.errors, []);
    assert.deepEqual(parsed.txs.map((item) => item.excludedReason), [
      "零钱与零钱通互转", "零钱与零钱通互转", undefined, undefined, undefined, "交易未完成：支付失败",
    ]);
    assert.ok(parsed.txs.slice(0, 2).every((item) => item.eventType === "transfer"));
    assert.equal(parsed.txs[4].eventType, "expense");
    assert.equal(parseWechat(file, []).txs[0].excludedReason, undefined);
  });
  check("WeChat refund links require a uniquely matching reported amount, merchant, card and time", () => {
    const purchase = tx({ id: "purchase", sourceTxId: "pay-1", source: "wechat", amount: 100, time: "14:36:31",
      sourceStatus: "已退款（￥79.35）", rawAccount: "中信银行信用卡(1778)" });
    const refund = tx({ ...purchase, id: "refund", sourceTxId: "refund-1", amount: 79.35, time: "17:06:42",
      eventType: "refund", direction: "in", sourceStatus: "已退款¥79.35", rawAccount: "中信银行信用卡（1778）" });
    const expected = new Map([["purchase", "refund"], ["refund", "purchase"]]);
    assert.deepEqual(matchStatementRefunds([refund, purchase]), expected);
    assert.deepEqual(matchStatementRefunds([purchase, { ...purchase, id: "duplicate-copy", status: "duplicate" }, refund]), expected);
    assert.deepEqual(matchStatementRefunds([{ ...purchase, sourceStatus: "已全额退款" }, { ...refund, amount: 100 }]), expected);
    for (const unrelated of [
      { ...refund, amount: 79.36 }, { ...refund, payee: "别的商户" }, { ...refund, rawAccount: "中信银行信用卡(2222)" },
      { ...refund, time: "14:35:00" }, { ...refund, source: "alipay" as const }, { ...refund, excludedReason: "交易未完成" },
    ]) {
      assert.equal(matchStatementRefunds([purchase, unrelated]).size, 0);
    }
    assert.equal(matchStatementRefunds([purchase, { ...purchase, id: "other-purchase", sourceTxId: "pay-2" }, refund]).size, 0);
    assert.equal(matchStatementRefunds([purchase, refund, { ...refund, id: "other-refund", sourceTxId: "refund-2" }]).size, 0);
  });
  check("the same card and amount fallback works across statement types and requires one candidate on both sides", () => {
    const purchase = tx({ id: "purchase", source: "bank-future", time: undefined, sourceTxId: undefined, rawAccount: "未来银行(123456)" });
    const refund = { ...purchase, id: "refund", eventType: "refund", direction: "in", status: "pending" } satisfies ParsedTx;
    const expected = new Map([[purchase.id, refund.id], [refund.id, purchase.id]]);
    assert.deepEqual(matchStatementRefunds([purchase, refund]), expected);
    for (const source of ["wechat", "alipay"] as const) {
      assert.deepEqual(matchStatementRefunds([{ ...purchase, source }, { ...refund, source, sourceStatus: "退款成功" }]), expected);
    }
    assert.deepEqual(matchStatementRefunds([purchase, refund].map((row) => ({ ...row, rawAccount: "", refundEvidence: { cardIdentity: "card-token" } }))), expected);
    for (const unrelated of [
      { ...refund, rawAccount: "未来银行(654321)" }, { ...refund, payee: "其他商户" }, { ...refund, currency: "USD" },
      { ...refund, date: "2025-11-01" }, { ...refund, amount: refund.amount - 0.01 }, { ...refund, eventType: "income" as const },
      { ...refund, refundEvidence: { originalSourceTxId: "different-order" } },
    ]) assert.equal(matchStatementRefunds([purchase, unrelated]).size, 0);
    assert.equal(matchStatementRefunds([{ ...purchase, rawAccount: "未来银行" }, { ...refund, rawAccount: "未来银行" }]).size, 0);
    assert.equal(matchStatementRefunds([purchase, refund, { ...purchase, id: "another-purchase" }]).size, 0);
    assert.equal(matchStatementRefunds([purchase, refund, { ...refund, id: "another-refund" }]).size, 0);
  });
  check("overlapping statements retain one refund and same-statement or ambiguous rows stay reviewable", () => {
    const first = tx({ id: "first", source: "bank-future", sourceTxId: undefined, rawAccount: "未来银行(1234)",
      sourceFile: "first.pdf", sourceFileHash: "a".repeat(64), eventType: "refund", direction: "in" });
    const second = { ...first, id: "second", status: "pending", sourceFile: "second.pdf", sourceFileHash: "b".repeat(64) } satisfies ParsedTx;
    const copies = [structuredClone(first), structuredClone(second)];
    assert.equal(syncStatementRefunds(copies), true);
    assert.equal(copies[1].status, "duplicate");
    assert.equal(copies[1].duplicateOf?.id, first.id);
    assert.equal(syncStatementRefunds(copies), false);
    copies[0].status = "excluded";
    assert.equal(syncStatementRefunds(copies), false);
    assert.equal(copies[1].status, "duplicate");

    const ambiguous = [structuredClone(first), structuredClone(second), { ...first, id: "third", row: 3 }];
    assert.equal(syncStatementRefunds(ambiguous), false);
    assert.equal(ambiguous.filter((row) => row.status === "duplicate").length, 0);
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
  check("family-card rows are recognized and never mapped to my own wallets", () => {
    // Alipay proxy-pay row: 亲友代付 + 亲情卡, funded by the OTHER person's card.
    const proxy = tx({ payee: "不愧是大佬(*峰)", note: "亲情卡", rawCategory: "亲友代付", rawAccount: "浙商银行信用卡(5103)", eventType: "familyCard", status: "pending", fundingAccount: "" });
    assert.equal(isFamilyCard(proxy), true);
    const config: AppConfig = { ledgerRoot: ".", mainFile: "main.bean", monthlyDir: "data", assetMapping: [{ keyword: "花呗", account: "Liabilities:CreditCard:Huabei", kind: "credit" }], accounts: [], llm: { provider: "off", apiBase: "", model: "", apiKey: "" } };
    // Their Huabei is not my Huabei: funding inference must refuse my mapping.
    const huabei = tx({ ...proxy, rawAccount: "花呗" });
    assert.equal(inferFundingAccount(huabei, config).account, "");
    assert.ok(inferFundingAccount(huabei, config).issues?.[0].includes("对方"));
    // A normal row still maps my own Huabei.
    assert.equal(inferFundingAccount(tx({ rawAccount: "花呗" }), config).account, "Liabilities:CreditCard:Huabei");
  });
  check("family-card proxy pairs with the payer statement's real charge across sources", () => {
    // My alipay says 亲友代付; the payer's alipay has the real charge next day.
    const proxy = tx({ id: "proxy", date: "2025-10-31", payee: "某商户", note: "亲情卡", rawCategory: "亲友代付", source: "alipay", sourceFile: "mine.csv", eventType: "familyCard", status: "pending", fundingAccount: "", suggestedAccount: "", finalAccount: "", confidence: 0 });
    const charge = tx({ id: "charge", date: "2025-11-01", payee: "某商户", note: "商品", rawCategory: "餐饮美食", rawAccount: "浙商银行信用卡(5103)", source: "alipay", sourceFile: "theirs.csv", row: 3, sourceTxId: "theirs-001", status: "pending", fundingAccount: "Liabilities:CreditCard:CZBank:5103" });
    const result = pairTransfers([proxy, charge]);
    assert.equal(result.familyCardPairs, 1);
    assert.equal(proxy.status, "duplicate");
    assert.equal(proxy.duplicateOf?.id, "charge");
    assert.equal(charge.status, "pending"); // the real charge stays for review
    // Refund proxy pairs with the payer's real refund row.
    const refundProxy = tx({ id: "rproxy", date: "2025-11-02", direction: "in", amount: 5, payee: "某商户", note: "退款-亲情卡", rawCategory: "退款", source: "alipay", sourceFile: "mine.csv", eventType: "refund", status: "pending", fundingAccount: "" });
    const refundCharge = tx({ id: "rcharge", date: "2025-11-02", direction: "in", amount: 5, payee: "某商户", note: "退款", rawCategory: "退款", source: "alipay", sourceFile: "theirs.csv", row: 4, sourceTxId: "theirs-002", status: "pending", fundingAccount: "Liabilities:CreditCard:CZBank:5103", eventType: "refund" });
    const refundResult = pairTransfers([refundProxy, refundCharge]);
    assert.equal(refundResult.familyCardPairs, 1);
    assert.equal(refundProxy.status, "duplicate");
    // Ambiguity (two same-amount charges) leaves the proxy for manual review.
    const other = { ...charge, id: "charge2", row: 5, sourceTxId: "theirs-003" };
    assert.equal(pairTransfers([structuredClone(proxy), charge, other]).familyCardPairs, 0);
    assert.equal(proxy.status, "duplicate"); // unchanged from the earlier pairing in this scope
  });
  check("suggestOpens proposes the payer's card before its earliest transaction", () => {
    const charge = tx({ fundingAccount: "Liabilities:CreditCard:CZBank:5103", date: "2025-10-31" });
    const opens = suggestOpens([charge], new Set(["Expenses:Shopping"]));
    assert.deepEqual(opens, ["2025-10-31 open Liabilities:CreditCard:CZBank:5103"]);
  });
  check("generator preserves currency, reviewed postings, tags and provenance", () => {
    const row = tx({ currency: "HKD", flag: "!", tags: ["trip", "refund"], reviewNote: "核对完成", postings: [{ account: "Expenses:Shopping", amount: 6, currency: "HKD" }, { account: "Assets:Wallet", amount: -5, currency: "HKD" }, { account: "Equity:Coupons:Payment", amount: -1, currency: "HKD" }] });
    const result = generateEntries([row], "batch-test"); assert.deepEqual(result.errors, []); assert.equal(result.generated.length, 1);
    assert.match(result.entries, /2025-10-31 ! .* #trip #refund/); assert.match(result.entries, /import-batch: "batch-test"/); assert.match(result.entries, /import-id: "source-001"/);
    assert.match(result.entries, /Equity:Coupons:Payment  -1\.00 HKD/); assert.ok(!result.entries.includes(" CNY"));
    assert.ok(suggestOpens([row], new Set()).every((line) => line.startsWith("2025-10-31 open")));
  });
  check("invalid splits are rejected and a refund can use an income account", () => {
    assert.ok(generateEntries([tx({ postings: [{ account: "Assets:A", amount: 5, currency: "CNY" }, { account: "Expenses:Other", amount: -4, currency: "CNY" }] })]).errors?.length);
    assert.ok(generateEntries([tx({ fundingParts: [{ rawAccount: "银行卡" }, { rawAccount: "红包" }] })]).errors?.length);
    const refund = generateEntries([tx({ eventType: "refund", direction: "in", finalAccount: "Income:Refund" })]);
    assert.deepEqual(refund.errors, []);
    assert.match(refund.entries, /Income:Refund  -5\.00 CNY/);
  });
  check("only certified day-end balance becomes a next-day standalone directive", () => {
    const row = tx({ source: "bank-icbc", fundingAccount: "Assets:Bank:ICBC", balanceAfter: 100 });
    assert.ok(!generateEntries([row]).entries.includes(" balance "));
    const result = generateEntries([{ ...row, balanceIsDayEnd: true }]);
    assert.match(result.entries, /2025-11-01 balance Assets:Bank:ICBC 100\.00 CNY/); assert.ok(result.monthFiles["202511"]); assert.ok(!result.entries.includes(" = "));
    const pending = tx({ id: "pending", fundingAccount: row.fundingAccount, status: "pending" });
    assert.ok(!generateEntries([{ ...row, balanceIsDayEnd: true }, pending]).entries.includes(" balance "));
  });
  const configDirectory = process.env.BEAN_IMPORT_DATA_DIR ?? path.resolve(import.meta.dirname, "../server-data");
  const nativePython = process.env.ACCOUNT_IMPORT_PYTHON || readStoredConfig(configDirectory).pythonPath;
  if (nativePython) {
    check("only a native rounded funding leg with an exact reconstructed amount suggests a duplicate", () => {
      const card = "Liabilities:CreditCard:ABC:9065";
      const example = [
        "2025-10-01 open Expenses:Property CNY", "2025-10-01 open Assets:Wallet CNY", `2025-10-01 open ${card} CNY`,
        '2025-10-31 * "Property"', "  Expenses:Property  100.13 CNY", "  Assets:Wallet  109.0 CNY", "  Assets:Wallet  109.0 CNY",
      ].join("\n");
      const automatic = parseLedgerText(`${example}\n  ${card}\n`, nativePython);
      assert.deepEqual(automatic.errors, []);
      const [booked] = automatic.transactions;
      assert.equal(booked.postings.at(-1)?.amount, -318.1);
      assert.deepEqual(booked.unroundedFunding, { account: card, amount: -318.13, currency: "CNY" });
      const row = tx({ amount: 318.13 });
      assert.equal(markDuplicates([row], [booked]).stats.ledgerDuplicates, 0);
      assert.equal(row.status, "pending");
      assert.match(row.matches?.[0].reason ?? "", /自动补全时发生舍入.*318\.13 CNY/);
      for (const different of [
        tx({ amount: 318.12 }), tx({ amount: 318.13, direction: "in" }),
        tx({ amount: 318.13, currency: "HKD" }), tx({ amount: 318.13, fundingAccount: "Liabilities:Card:Other" }),
      ]) {
        markDuplicates([different], [booked]);
        assert.equal(different.status, "ready");
      }
      const explicit = parseLedgerText(`${example}\n  ${card}  -318.10 CNY\n`, nativePython);
      assert.deepEqual(explicit.errors, []);
      assert.equal(explicit.transactions[0].unroundedFunding, undefined);
      const explicitRow = tx({ amount: 318.13 });
      markDuplicates([explicitRow], explicit.transactions);
      assert.equal(explicitRow.status, "ready");
    });
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
    // Discovery works on upload stores too, where multer strips extensions:
    // identify by content signature instead of file name.
    const discover = (directory: string) => {
      const found: { alipay?: string; wechat?: string } = {};
      for (const name of fs.readdirSync(directory)) {
        const bytes = fs.readFileSync(path.join(directory, name));
        if (bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) { found.wechat ??= name; continue; } // xlsx: ZIP signature
        const text = readTextSmart(bytes); // GBK-aware, same as the parsers
        if (text.includes("支付宝")) found.alipay ??= name;
        if (text.includes("微信支付")) found.wechat ??= name;
      }
      return found;
    };
    const found = discover(statementDir);
    const ali = found.alipay, wx = found.wechat;
    assert.ok(ali && wx, "real regression needs the Alipay CSV and WeChat XLSX (by content signature)");
    const alipay = parseAlipay(path.join(statementDir, ali)), wechat = parseWechat(path.join(statementDir, wx));
    check("real source completeness: 1064 Alipay + 444 WeChat = 1508 rows", () => {
      assert.equal(alipay.txs.length, 1064); assert.equal(wechat.txs.length, 444); assert.equal(alipay.errors.length + wechat.errors.length, 0);
      assert.equal(alipay.txs.filter((item) => item.excludedReason).length, 38);
      const walletMoves = wechat.txs.filter((item) => ["转入零钱通-来自零钱", "零钱通转出-到零钱"].includes(item.rawCategory));
      assert.deepEqual(wechat.txs.filter((item) => item.excludedReason), walletMoves);
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
    check("real family-card rows: 163 proxy purchases + 14 proxy refunds, all flagged as the payer's", () => {
      const family = alipay.txs.filter((item) => isFamilyCard(item));
      assert.equal(family.length, 177);
      assert.equal(family.filter((item) => item.eventType === "familyCard" && item.direction === "out").length, 163);
      assert.equal(family.filter((item) => /退款/.test(item.rawCategory)).length, 14);
      assert.ok(family.every((item) => item.issues?.some((issue) => issue.includes("对方"))));
    });
    console.log(JSON.stringify({ realRows: 1508, excluded: alipay.txs.filter((item) => item.excludedReason).length, alipayRefunds: 30, wechatRefunds: wechat.txs.filter((item) => item.eventType === "refund").length }));
  }
  console.log(`Import regression passed (${checks} checks).`);
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
