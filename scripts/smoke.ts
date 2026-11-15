/**
 * Smoke test: build synthetic statements (alipay GBK csv, wechat csv, ICBC csv),
 * run them through the parse → classify → dedup → generate pipeline in-process,
 * and print a report. No server needed.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import iconv from "iconv-lite";
import { parseAlipay } from "../src/server/parsers/alipay.js";
import { parseWechat } from "../src/server/parsers/wechat.js";
import { parseBank, detectBank } from "../src/server/parsers/banks.js";
import { parsePdfBank } from "../src/server/parsers/pdf.js";
import { pairTransfers } from "../src/server/lib/transfers.js";
import { readSheet } from "../src/server/parsers/common.js";
import { markDuplicates } from "../src/server/lib/dedup.js";
import { inferFundingAccount } from "../src/server/lib/accounts.js";
import { generateEntries } from "../src/server/lib/generate.js";
import { parseLedger } from "../src/server/lib/ledger.js";
import type { ParsedTx } from "../src/shared/types.js";
import { loadConfig } from "../src/server/config.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bean-smoke-"));
const config = loadConfig(tmp);

// --- alipay GBK csv ---
const alipayCsv = [
  "支付宝交易明细查询",
  "账号:[test]",
  "交易时间,交易分类,交易对方,对方账号,商品说明,收/支,金额,收/付款方式,交易状态,交易分类.1,交易订单号,商户订单号,备注",
  "2026-11-01 08:30:00,餐饮美食,瑞幸咖啡,xxx,拿铁,支出,18.00,中国工商银行(1234),交易成功,餐饮,20261101001,m001,",
  "2026-11-01 12:10:00,日用百货,全家便利店,xxx,午餐,支出,25.50,余额,交易成功,购物,20261101002,m002,",
  "2026-11-02 10:00:00,转账,张三,xxx,还款,收入,500.00,余额,交易成功,转账,20261102003,m003,",
  "2026-11-02 23:00:00,交通出行,滴滴出行,xxx,快车,支出,42.10,中国工商银行(1234),交易成功,交通,20261102004,m004,",
  "2026-11-03 09:00:00,退款,美团,xxx,退款,收入,30.00,余额,退款成功,退款,20261103005,m005,",
].join("\n");
const alipayFile = path.join(tmp, "alipay_record.csv");
fs.writeFileSync(alipayFile, iconv.encode(alipayCsv, "gbk"));

// --- ICBC bank csv (same purchases as alipay ones paid via ICBC card → dedup test) ---
const icbcCsv = [
  "中国工商银行 交易明细",
  "交易日期,摘要,交易对方,借方金额,贷方金额,余额,交易流水号",
  "2026-11-01,消费,瑞幸咖啡,18.00,,4882.11,ICBC001",
  "2026-11-02,消费,滴滴出行,42.10,,4840.01,ICBC002",
  "2026-11-05,工资,某公司,,12000.00,16840.01,ICBC003",
  "2026-11-06,信用卡还款,信用卡还款,3500.00,,13340.01,ICBC004",
].join("\n");
const icbcFile = path.join(tmp, "icbc_flow.csv");
fs.writeFileSync(icbcFile, icbcCsv, "utf-8");

// --- wechat csv ---
const wechatCsv = [
  "微信支付账单明细",
  "交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,商户单号,备注",
  "2026-11-01 09:00:00,商户消费,星巴克,拿铁,支出,35.00,零钱,支付成功,wx001,s001,",
  "2026-11-02 18:00:00,微信红包,李四,,支出,88.00,零钱,已存入零钱,wx002,s002,生日红包",
  "2026-11-03 14:00:00,商户消费,京东,书籍,支出,89.00,中国建设银行(5678),支付成功,wx003,s003,",
].join("\n");
const wechatFile = path.join(tmp, "wechat.csv");
fs.writeFileSync(wechatFile, wechatCsv, "utf-8");

// --- ledger with one existing tx (same as alipay row 1 → ledger dedup test) ---
const ledgerDir = path.join(tmp, "ledger");
fs.mkdirSync(ledgerDir);
fs.writeFileSync(
  path.join(ledgerDir, "main.beancount"),
  `2026-01-01 open Assets:Bank:ICBC
2026-01-01 open Expenses:Food

2026-11-01 * "瑞幸咖啡" "拿铁"
  Expenses:Food  18.00 CNY
  Assets:Bank:ICBC  -18.00 CNY
`,
);

// ============ run pipeline ============
const assert = (cond: boolean, msg: string) => {
  if (!cond) {
    console.error(`✗ FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`✓ ${msg}`);
  }
};

const results = [
  parseAlipay(alipayFile),
  parseWechat(wechatFile),
  (() => {
    const { rows } = readSheet(icbcFile);
    const def = detectBank("工商银行 icbc_flow.csv", rows)!;
    return parseBank(icbcFile, def);
  })(),
];
const icbcTxs = results[2].txs;

const ledger = parseLedger(ledgerDir, "main.beancount");
console.log(`ledger accounts: ${ledger.accounts.length}, txs: ${ledger.transactions.length}`);

let all: ParsedTx[] = [];
for (const r of results) {
  console.log(`\n[${r.source}] parsed ${r.txs.length} txs, ${r.errors.length} errors`);
  for (const e of r.errors) console.log(`  ERR row ${e.row}: ${e.message}`);
  for (const raw of r.txs) {
    const tx: ParsedTx = {
      ...raw,
      status: "pending",
      fundingAccount: inferFundingAccount(raw as ParsedTx, config).account,
      suggestedAccount: "Expenses:Other",
      confidence: 0,
      finalAccount: "",
    };
    // crude local classify (rules only, mirroring classifyLocal without memory/llm)
    const text = `${tx.payee} ${tx.note} ${tx.rawCategory}`;
    if (/瑞幸|咖啡/.test(text)) { tx.suggestedAccount = "Expenses:Food:Coffee"; tx.confidence = 0.95; }
    else if (/滴滴/.test(text)) { tx.suggestedAccount = "Expenses:Transport:Taxi"; tx.confidence = 0.95; }
    else if (/全家|便利店/.test(text)) { tx.suggestedAccount = "Expenses:Shopping:Daily"; tx.confidence = 0.95; }
    else if (/美团|退款/.test(text)) { tx.suggestedAccount = "Income:Refund"; tx.confidence = 0.95; }
    else if (/工资/.test(text)) { tx.suggestedAccount = "Income:Salary"; tx.confidence = 0.95; }
    else if (/信用卡还款/.test(text)) { tx.suggestedAccount = "Liabilities:CC:ICBC"; tx.confidence = 0.9; }
    else if (/红包/.test(text)) { tx.suggestedAccount = "Income:RedPacket"; tx.confidence = 0.9; }
    else { tx.confidence = 0.5; }
    tx.finalAccount = tx.suggestedAccount;
    if (tx.confidence >= 0.9) tx.status = "ready";
    all.push(tx);
  }
}

const { txs: deduped, stats } = markDuplicates(all, ledger.transactions);

// ============ transfer pairing test ============
// icbcTx[3] is the 3500 CC repayment (out, from Assets:Bank:ICBC);
// add the credit-card statement leg: 3500 arrives at Liabilities:CC:ICBC
const ccTx: ParsedTx = {
  ...icbcTxs[3],
  id: "cc-leg",
  direction: "in",
  payee: "信用卡还款",
  note: "自动还款入账",
  rawCategory: "还款",
  suggestedAccount: "Income:Refund",
  confidence: 0.5,
  finalAccount: "Income:Refund",
  fundingAccount: "Liabilities:CC:ICBC",
  status: "pending",
};
const pairResult = pairTransfers([...deduped.filter((t) => t.status !== "duplicate"), ccTx]);
console.log(`\ntransfer pairs: ${pairResult.pairs.length}`);
for (const p of pairResult.pairs) {
  console.log(`  PAIR: ${p.from.date} ${p.from.amount.toFixed(2)} ${p.from.fundingAccount} → ${p.from.fundingAccount2} (absorbed: ${p.to.id})`);
}
assert(pairResult.pairs.length === 1, "1 transfer pair found (credit card repayment)");
assert(pairResult.pairs[0].from.fundingAccount2 === "Liabilities:CC:ICBC", "pair sets fundingAccount2 to credit card account");
assert(pairResult.pairs[0].from.finalAccount === "Liabilities:CC:ICBC", "pair reclassifies to transfer");

// ============ PDF parse test ============
// build a small bank-like PDF with pdf-lib and parse it back
const { PDFDocument, StandardFonts } = await import("pdf-lib");
const pdfDoc = await PDFDocument.create();
const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
const page = pdfDoc.addPage([595, 842]);
const pdfLines = [
  "Bank Statement ICBC",
  "Transaction Date  Description        Debit   Credit  Balance",
  "2026-11-05        Salary             0.00    12000.00   16840.01",
  "2026-11-06        CC Repayment       3500.00  0.00       13340.01",
];
pdfLines.forEach((l, i) => page.drawText(l, { x: 50, y: 800 - i * 20, size: 10, font }));
const pdfBytes = Buffer.from(await pdfDoc.save());
const pdfFile = path.join(tmp, "icbc.pdf");
fs.writeFileSync(pdfFile, pdfBytes);
const pdfResult = await parsePdfBank(pdfFile, "bank-icbc");
console.log(`\npdf parsed ${pdfResult.txs.length} txs, ${pdfResult.errors.length} errors`);
for (const t of pdfResult.txs) {
  console.log(`  PDF: ${t.date} ${t.direction} ${t.amount.toFixed(2)} bal=${t.balanceAfter}`);
}
assert(pdfResult.txs.length === 2, "pdf parses 2 txs");
assert(pdfResult.txs[0].direction === "in" && pdfResult.txs[0].amount === 12000, "pdf salary in via credit column");
assert(pdfResult.txs[1].direction === "out" && pdfResult.txs[1].amount === 3500, "pdf repayment out via debit column");
assert(pdfResult.txs[1].balanceAfter === 13340.01, "pdf running balance captured");
console.log(`\ndedup: cross-source=${stats.crossSourceDuplicates}, in-ledger=${stats.ledgerDuplicates}`);
for (const t of deduped.filter((x) => x.status === "duplicate")) {
  console.log(`  DUP: [${t.source}] ${t.date} ${t.payee} ${t.amount.toFixed(2)} → ${t.duplicateOf?.label}`);
}

const { entries, generated } = generateEntries(deduped);
console.log(`\ngenerated ${generated.length} entries:\n`);
console.log(entries);

// assertions
const alipayTxs = results[0].txs;
assert(alipayTxs.length === 5, "alipay parses 5 txs");
assert(results[1].txs.length === 3, "wechat parses 3 txs");
assert(icbcTxs.length === 4, "icbc parses 4 txs");
assert(icbcTxs[2].direction === "in" && icbcTxs[2].amount === 12000, "icbc salary direction=in via 贷方金额");
assert(icbcTxs[0].balanceAfter === 4882.11, "icbc running balance captured");
assert(stats.crossSourceDuplicates === 1, "1 cross-source duplicate (滴滴 via ICBC; 瑞幸 was in-ledger)");
assert(stats.ledgerDuplicates === 2, "2 already-in-ledger duplicates (瑞幸 alipay + 瑞幸 icbc)");
assert(generated.length === 6, "6 ready after dedup (12 - 1 cross - 2 ledger - 3 low-confidence pending)");
assert(entries.includes("Assets:Bank:ICBC = 16840.01 CNY"), "balance assertion generated");

fs.rmSync(tmp, { recursive: true, force: true });
console.log("\nsmoke done");
