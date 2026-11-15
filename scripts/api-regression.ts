/** API regression uses disposable ledgers only. Real statements, when supplied, are read-only. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { IncomingMessage, ServerResponse } from "node:http";
import { PassThrough } from "node:stream";
import type express from "express";
import { createApp } from "../src/server/index.js";
import { discoverLedgerRoot, loadConfig } from "../src/server/config.js";
import { readTextSmart } from "../src/server/parsers/common.js";
import { discoverPython, parseLedger } from "../src/server/lib/ledger.js";
import type { AppConfig, ImportPreview } from "../src/shared/types.js";

const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bean-api-regression-")));
const python = process.env.ACCOUNT_IMPORT_PYTHON || discoverPython(discoverLedgerRoot());
const applications = new Map<string, ReturnType<typeof createApp>>();
let checks = 0;
const passed = (label: string) => { checks++; console.log(`✓ ${label}`); };
const root = path.join(temporary, "ledger");
fs.mkdirSync(root);
const definitions = [
  'option "operating_currency" "CNY"',
  "2025-01-01 open Assets:CN:BOC:1111 CNY",
  "2025-01-01 open Assets:CN:BOC:2222 CNY",
  "2025-01-01 open Expenses:Food:Meals:Dine CNY",
  "2025-01-01 open Equity:Coupons:Payment CNY",
].join("\n") + "\n";
fs.writeFileSync(path.join(root, "main.bean"), definitions);
const config: AppConfig = {
  ledgerRoot: root, mainFile: "main.bean", pythonPath: python,
  monthlyDir: "years/{year}/imported", annualLayout: true,
  assetMapping: [
    { keyword: "中国银行", cardSuffix: "1111", account: "Assets:CN:BOC:1111", kind: "debit" },
    { keyword: "中国银行", cardSuffix: "2222", account: "Assets:CN:BOC:2222", kind: "debit" },
  ], accounts: [], llm: { provider: "off", apiBase: "", apiKey: "", model: "" },
};
const dataDir = path.join(temporary, "data");
async function boot(settings: AppConfig, directory: string) {
  const id = `http://fixture-${applications.size}.test`;
  applications.set(id, createApp({ config: settings, dataDir: directory }));
  return id;
}
/** Run actual Express and Multer middleware without requiring a listening socket. */
async function transport(base: string, route: string, init?: RequestInit): Promise<Response> {
  const application = applications.get(base)!;
  const input = new Request(base + route, init), bytes = Buffer.from(await input.arrayBuffer());
  return new Promise((resolve, reject) => {
    const socket = new PassThrough();
    const req = new IncomingMessage(socket as never);
    req.method = input.method; req.url = route; req.complete = true;
    req.headers = { ...Object.fromEntries(input.headers), host: "fixture.test", "content-length": String(bytes.length) };
    const res = new ServerResponse(req), chunks: Buffer[] = [];
    const collect = (chunk: string | Uint8Array, encoding?: BufferEncoding) => chunks.push(typeof chunk === "string" ? Buffer.from(chunk, encoding) : Buffer.from(chunk));
    const timer = setTimeout(() => reject(new Error(`middleware timeout: ${route}`)), 30_000);
    res.write = ((chunk: string | Uint8Array, encoding?: BufferEncoding | (() => void), callback?: () => void) => {
      collect(chunk, typeof encoding === "string" ? encoding : undefined);
      if (typeof encoding === "function") encoding(); else callback?.();
      return true;
    }) as typeof res.write;
    res.end = ((chunk?: string | Uint8Array, encoding?: BufferEncoding | (() => void), callback?: () => void) => {
      if (chunk != null) collect(chunk, typeof encoding === "string" ? encoding : undefined);
      res.finished = true; clearTimeout(timer); res.emit("finish");
      if (typeof encoding === "function") encoding(); else callback?.();
      const headers = new Headers();
      for (const [key, value] of Object.entries(res.getHeaders())) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : String(value));
      resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers }));
      socket.destroy();
      return res;
    }) as typeof res.end;
    (application as unknown as (req: express.Request, res: express.Response) => void)(req as express.Request, res as express.Response);
    if (bytes.length) req.push(bytes);
    req.push(null);
  });
}
async function request(base: string, route: string, body?: unknown, expected = 200) {
  const response = await transport(base, route, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const result = await response.json(); assert.equal(response.status, expected, `${route}: ${JSON.stringify(result)}`); return result;
}
function csv(id = "api-source-1", suffix = "1111", date = "2026-01-02") {
  return ["交易时间,交易分类,交易对方,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号",
    `${date} 10:00:00,餐饮美食,测试餐厅,午餐,支出,12.34,中国银行储蓄卡(${suffix}),交易成功,${id}`,
    `${date} 11:00:00,日用百货,测试商店,取消,支出,5,中国银行储蓄卡(${suffix}),交易关闭,${id}-closed`,
  ].join("\n");
}
async function upload(base: string, text: string) {
  const body = new FormData(); body.append("files", new Blob([text]), "alipay.csv");
  const response = await transport(base, "/api/upload", { method: "POST", body });
  const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result));
  return await request(base, `/api/batch/${result.batchId}`) as ImportPreview & { batchId: string; revision: number };
}

try {
  let base = await boot(config, dataDir);
  const info = await request(base, "/api/ledger"); assert.equal(info.accountCount, 4); assert.deepEqual(info.errors, []);
  let batch = await upload(base, csv());
  assert.equal(batch.txs.length, 2); assert.equal(batch.parseStats?.excluded, 1); assert.ok(batch.txs.every((tx) => tx.sourceFileHash?.length === 64));
  assert.equal(batch.txs[0].fundingAccount, "Assets:CN:BOC:1111"); passed("multipart upload retains source rows, exclusion reasons and funding identity");
  const pendingReplay = await upload(base, csv());
  assert.equal(pendingReplay.txs[0].status, "pending");
  assert.ok(pendingReplay.txs[0].matches?.some((match) => match.reason.includes("未提交批次")));
  passed("repeat uploads also reference existing uncommitted import batches");
  const route = `/api/batch/${batch.batchId}`;
  await request(base, route + "/decide", { revision: 0, decisions: [] }, 409);
  const saved = await request(base, route + "/decide", { revision: batch.revision, decisions: [{ id: batch.txs[0].id, account: "Expenses:Food:Meals:Dine", funding: "Assets:CN:BOC:2222", status: "ready", tags: ["trip2026"], flag: "!", reviewNote: '核实 "引号" \\\n下一行' }] });
  batch = await request(base, route); assert.equal(batch.revision, saved.revision); assert.equal(batch.txs[0].fundingAccount, "Assets:CN:BOC:2222"); assert.deepEqual(batch.txs[0].tags, ["trip2026"]);
  const preview = await request(base, route + "/generate", { revision: batch.revision });
  assert.match(preview.entries, /Assets:CN:BOC:2222\s+-12\.34 CNY/); assert.match(preview.entries, / ! .*#trip2026/);
  passed("reviewed funding, tags, flag and note reach server-generated entries");
  const edited = await request(base, route + "/decide", { revision: batch.revision, decisions: [{ id: batch.txs[0].id, tags: ["trip2026", "checked"] }] });
  await request(base, route + "/commit", { revision: batch.revision }, 409);
  await request(base, route + "/commit", { revision: edited.revision }, 409);
  assert.equal(fs.existsSync(path.join(root, "years")), false);
  await request(base, route + "/generate", { revision: edited.revision });
  const committed = await request(base, route + "/commit", { revision: edited.revision });
  assert.equal(committed.ok, true); assert.equal(committed.validation.newErrors.length, 0);
  const monthly = path.join(root, "years/2026/imported/2026-01.bean"), beforeRetry = fs.readFileSync(monthly, "utf8");
  assert.equal(parseLedger(root, "main.bean", python).transactions.length, 1);
  const repeated = await request(base, route + "/commit", { revision: 0 }); assert.equal(repeated.alreadyCommitted, true); assert.equal(fs.readFileSync(monthly, "utf8"), beforeRetry);
  passed("stale previews cannot write; annual include, native validation and retry idempotency work");
  const importedAgain = await upload(base, csv()); assert.equal(importedAgain.txs[0].status, "duplicate"); assert.match(importedAgain.txs[0].duplicateOf?.label ?? "", /交易号/);
  passed("a new upload recognizes durable IDs already in the ledger");
  base = await boot(config, dataDir);
  const restored = await request(base, route); assert.equal(restored.committed, true); assert.deepEqual(restored.txs[0].tags, ["trip2026", "checked"]);
  await request(base, route + "/decide", { revision: restored.revision, decisions: [{ id: restored.txs[0].id, flag: "*" }] }, 409);
  passed("server restart restores review decisions and keeps committed batches read-only");
  let next = await upload(base, csv("api-source-2", "2222"));
  assert.equal(next.txs[0].status, "pending"); assert.ok(next.txs[0].matches?.length); assert.ok(next.txs[0].matches?.[0].file?.endsWith("2026-01.bean"));
  await request(base, `/api/batch/${next.batchId}/decide`, { revision: next.revision, decisions: [{ id: next.txs[0].id, account: "Expenses:Invented" }] }, 400);
  const r = await request(base, `/api/batch/${next.batchId}/decide`, { revision: next.revision, decisions: [{ id: next.txs[0].id, status: "ready", postings: [
    { account: "Expenses:Food:Meals:Dine", amount: 13.34, currency: "CNY" }, { account: "Assets:CN:BOC:2222", amount: -12.34, currency: "CNY" },
  ] }] });
  await request(base, `/api/batch/${next.batchId}/generate`, { revision: r.revision }, 422);
  assert.equal(fs.readFileSync(monthly, "utf8"), beforeRetry);
  const corrected = await request(base, `/api/batch/${next.batchId}/decide`, { revision: r.revision, decisions: [{ id: next.txs[0].id, postings: [
    { account: "Expenses:Food:Meals:Dine", amount: 13.34, currency: "CNY" }, { account: "Assets:CN:BOC:2222", amount: -12.34, currency: "CNY" }, { account: "Equity:Coupons:Payment", amount: -1, currency: "CNY" },
  ] }] });
  await request(base, `/api/batch/${next.batchId}/generate`, { revision: corrected.revision });
  await request(base, `/api/batch/${next.batchId}/commit`, { revision: corrected.revision });
  assert.deepEqual(parseLedger(root, "main.bean", python).errors, []);
  passed("historical amount matches stay reviewable; balanced coupon splits commit, invalid splits do not");
  const otherRoot = path.join(temporary, "other-ledger"); fs.mkdirSync(otherRoot); fs.writeFileSync(path.join(otherRoot, "main.bean"), definitions);
  await request(base, "/api/config", { ledgerRoot: otherRoot }); await request(base, route, undefined, 409); assert.deepEqual(await request(base, "/api/batches"), []);
  await request(base, route + "/commit", { revision: edited.revision }, 409);
  assert.equal(fs.existsSync(path.join(otherRoot, "years")), false);
  await request(base, "/api/config", { ledgerRoot: root }); assert.ok((await request(base, "/api/batches")).length >= 3);
  passed("changing ledger profiles cannot redirect an existing batch");

  // Family card end-to-end: upload my proxy record and the payer's real charge
  // together; the proxy is marked duplicate, the payer's card gets an open.
  const familyRoot = path.join(temporary, "family-ledger"); fs.mkdirSync(familyRoot);
  fs.writeFileSync(path.join(familyRoot, "main.bean"), definitions);
  const familyConfig: AppConfig = { ...config, ledgerRoot: familyRoot, assetMapping: [
    { keyword: "中国银行", cardSuffix: "1111", account: "Assets:CN:BOC:1111", kind: "debit" },
    { keyword: "浙商银行", cardSuffix: "5103", account: "Liabilities:CreditCard:CZBank:5103", kind: "credit" },
  ] };
  base = await boot(familyConfig, path.join(temporary, "family-data"));
  const mine = ["交易时间,交易分类,交易对方,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号",
    "2026-01-02 10:00:00,亲友代付,测试餐厅,亲情卡,支出,12.34,浙商银行信用卡(5103),交易成功,my-proxy-1"].join("\n");
  const theirs = ["交易时间,交易分类,交易对方,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号",
    "2026-01-02 10:00:01,餐饮美食,测试餐厅,午餐,支出,12.34,浙商银行信用卡(5103),交易成功,their-charge-1"].join("\n");
  const familyBody = new FormData();
  familyBody.append("files", new Blob([mine]), "mine-alipay.csv");
  familyBody.append("files", new Blob([theirs]), "theirs-alipay.csv");
  const familyResponse = await transport(base, "/api/upload", { method: "POST", body: familyBody });
  const familyUpload = await familyResponse.json(); assert.equal(familyResponse.status, 200, JSON.stringify(familyUpload));
  const familyBatch = await request(base, `/api/batch/${familyUpload.batchId}`) as ImportPreview & { revision: number };
  assert.equal(familyBatch.txs.length, 2);
  assert.equal(familyBatch.dedup?.familyCardPairs, 1);
  const proxyRow = familyBatch.txs.find((tx) => tx.rawCategory === "亲友代付")!;
  const chargeRow = familyBatch.txs.find((tx) => tx.rawCategory !== "亲友代付")!;
  assert.equal(proxyRow.status, "duplicate");
  assert.equal(proxyRow.duplicateOf?.id, chargeRow.id);
  assert.equal(proxyRow.fundingAccount, ""); // never mapped to my own wallets
  assert.equal(chargeRow.fundingAccount, "Liabilities:CreditCard:CZBank:5103");
  assert.equal(chargeRow.status, "pending");
  const familyDecided = await request(base, `/api/batch/${familyBatch.batchId}/decide`, { revision: familyBatch.revision, decisions: [{ id: chargeRow.id, account: "Expenses:Food:Meals:Dine", status: "ready" }] });
  const familyPreview = await request(base, `/api/batch/${familyBatch.batchId}/generate`, { revision: familyDecided.revision });
  assert.deepEqual(familyPreview.opens, ["2026-01-02 open Liabilities:CreditCard:CZBank:5103"]);
  await request(base, `/api/batch/${familyBatch.batchId}/commit`, { revision: familyDecided.revision });
  const annualFile = fs.readFileSync(path.join(familyRoot, "years/2026/2026.bean"), "utf8");
  assert.match(annualFile, /2026-01-02 open Liabilities:CreditCard:CZBank:5103/);
  const familyLedger = parseLedger(familyRoot, "main.bean", python);
  assert.equal(familyLedger.transactions.length, 1); // only the payer's charge
  assert.match(familyLedger.transactions[0].postings.map((p) => p.account).join(","), /CZBank:5103/);
  assert.deepEqual(familyLedger.errors, []);
  passed("family-card proxy and payer charge pair up; payer's card opens and commits once");

  const statementDirectory = process.argv[2];
  if (statementDirectory) {
    const realData = path.join(temporary, "real-read-only"), realConfig = loadConfig(realData);
    const realRoot = path.resolve(realConfig.ledgerRoot), baseline = parseLedger(realRoot, realConfig.mainFile, realConfig.pythonPath);
    const realBase = await boot(realConfig, realData), body = new FormData();
    // Upload stores keep extensionless files; pick statements by content signature
    // and re-attach a recognizable name so the server's type detection works.
    // An upload store may hold several copies and small synthetic test fixtures;
    // pick the largest Alipay text and the largest WeChat XLSX by content.
    let alipay = "", alipaySize = 0, wechat = "", wechatSize = 0;
    for (const name of fs.readdirSync(statementDirectory)) {
      const bytes = fs.readFileSync(path.join(statementDirectory, name));
      if (bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
        if (bytes.length > wechatSize) { wechat = name; wechatSize = bytes.length; }
      } else if (readTextSmart(bytes).includes("支付宝") && bytes.length > alipaySize) {
        alipay = name; alipaySize = bytes.length;
      }
    }
    assert.ok(alipay && wechat, "need one Alipay text and one WeChat XLSX by content signature");
    for (const [name, uploadName] of [[alipay, "alipay.csv"], [wechat, "wechat.xlsx"]] as const) {
      body.append("files", new Blob([fs.readFileSync(path.join(statementDirectory, name))]), uploadName);
    }
    const response = await transport(realBase, "/api/upload", { method: "POST", body }), uploaded = await response.json();
    assert.equal(response.status, 200, JSON.stringify(uploaded));
    const realBatch = await request(realBase, `/api/batch/${uploaded.batchId}`) as ImportPreview;
    assert.equal(realBatch.txs.length, 1508); assert.equal(realBatch.parseStats?.excluded, 38); assert.equal(realBatch.errors.length, 0);
    assert.equal(realBatch.txs.filter((tx) => tx.source === "alipay" && tx.eventType === "refund" && tx.direction === "in").length, 30);
    assert.ok(realBatch.txs.filter((tx) => /信用卡/.test(tx.rawAccount) && tx.fundingAccount).every((tx) => tx.fundingAccount.startsWith("Liabilities:")));
    assert.ok(realBatch.txs.filter((tx) => tx.matches?.length).length > 0);
    // The real ledger evolves outside this regression; only assert the upload
    // itself never touches it, not hardcoded account/transaction counts.
    assert.ok(baseline.accounts.length > 0);
    const after = parseLedger(realRoot, realConfig.mainFile, realConfig.pythonPath);
    assert.equal(after.accounts.length, baseline.accounts.length);
    assert.equal(after.transactions.length, baseline.transactions.length); assert.deepEqual(after.errors, baseline.errors);
    passed("real multipart CSV + XLSX upload accounts for all 1508 rows and references the unchanged real ledger");
  }
  console.log(`API regression passed (${checks} groups).`);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
