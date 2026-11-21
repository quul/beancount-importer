/** API regression uses disposable ledgers only. Real statements, when supplied, are read-only. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { IncomingMessage, ServerResponse } from "node:http";
import { PassThrough } from "node:stream";
import type express from "express";
import { PDFDict, PDFDocument, PDFName, StandardFonts } from "pdf-lib";
import * as XLSX from "xlsx";
import { createApp } from "../src/server/index.js";
import { discoverLedgerRoot, loadConfig } from "../src/server/config.js";
import { readTextSmart } from "../src/server/parsers/common.js";
import { parsePdfBank } from "../src/server/parsers/pdf.js";
import { loadPdfRules } from "../src/server/parsers/pdf-rules.js";
import { discoverPython, parseLedger, parseLedgerText } from "../src/server/lib/ledger.js";
import { BatchStore, profileId } from "../src/server/lib/batches.js";
import { markDuplicates } from "../src/server/lib/dedup.js";
import type { AppConfig, ImportPreview, ParsedTx } from "../src/shared/types.js";

const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bean-api-regression-")));
const python = process.env.ACCOUNT_IMPORT_PYTHON || discoverPython(discoverLedgerRoot());
const applications = new Map<string, ReturnType<typeof createApp>>();
const reviewSessionId = "1234567890abcdef1234567890abcdef";
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
async function boot(settings: AppConfig | undefined, directory: string, activeLedgerFile?: string) {
  const id = `http://fixture-${applications.size}.test`;
  applications.set(id, createApp({ config: settings, dataDir: directory, activeLedgerFile }));
  return id;
}
/** Run actual Express and Multer middleware without requiring a listening socket. */
async function transport(base: string, route: string, init?: RequestInit, peer?: string): Promise<Response> {
  const application = applications.get(base)!;
  const input = new Request(base + route, init), bytes = Buffer.from(await input.arrayBuffer());
  return new Promise((resolve, reject) => {
    const socket = new PassThrough();
    Object.defineProperty(socket, "remoteAddress", { value: peer });
    const req = new IncomingMessage(socket as never);
    req.method = input.method; req.url = route; req.complete = true;
    req.headers = { ...Object.fromEntries(input.headers), host: input.headers.get("host") ?? "fixture.test", "content-length": String(bytes.length) };
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
async function deleteBatch(base: string, id: string, revision: number, expected = 200) {
  const response = await transport(base, `/api/batch/${id}`, {
    method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision }),
  });
  assert.equal(response.status, expected, await response.text());
}
function csv(id = "api-source-1", suffix = "1111", date = "2026-01-02") {
  return ["交易时间,交易分类,交易对方,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号",
    `${date} 10:00:00,餐饮美食,测试餐厅,午餐,支出,12.34,中国银行储蓄卡(${suffix}),交易成功,${id}`,
    `${date} 11:00:00,日用百货,测试商店,取消,支出,5,中国银行储蓄卡(${suffix}),交易关闭,${id}-closed`,
  ].join("\n");
}
function postStatements(base: string, files: ReadonlyArray<readonly [filename: string, data: string | Uint8Array]>) {
  const body = new FormData();
  for (const [file, data] of files) body.append("files", new Blob([typeof data === "string" ? data : new Uint8Array(data)]), file);
  return transport(base, "/api/upload", { method: "POST", body });
}
async function upload(base: string, data: string | Uint8Array, file = "alipay.csv") {
  const response = await postStatements(base, [[file, data]]);
  const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result));
  return await request(base, `/api/batch/${result.batchId}`) as ImportPreview & { batchId: string; revision: number };
}

type PdfRow = readonly [y: number, cells: readonly (readonly [x: number, text: string])[]];

async function fixturePdf(pages: PdfRow[][]): Promise<Uint8Array> {
  // Provide an extractable Unicode map without requiring a system CJK font.
  const unique = new Set(pages.flat().flatMap(([, cells]) => cells.flatMap(([, value]) => [...value])));
  const characters = [...unique].filter((char) => char.charCodeAt(0) > 127);
  const placeholders = Array.from({ length: 94 }, (_, index) => String.fromCharCode(33 + index)).filter((char) => !unique.has(char));
  assert.ok(characters.length <= placeholders.length);
  const codes = new Map(characters.map((char, index) => [char, placeholders[index]]));
  const mapping = characters.map((char) => `<${codes.get(char)!.charCodeAt(0).toString(16)}> <${char.charCodeAt(0).toString(16).padStart(4, "0")}>`);
  const cmap = ["/CIDInit /ProcSet findresource begin", "12 dict begin", "begincmap", "/CMapName /Fixture def", "/CMapType 2 def",
    "1 begincodespacerange", "<00> <ff>", "endcodespacerange", `${mapping.length} beginbfchar`, ...mapping, "endbfchar",
    "endcmap", "CMapName currentdict /CMap defineresource pop", "end", "end"].join("\n");
  const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const rows of pages) {
    const page = pdf.addPage();
    for (const [y, cells] of rows) for (const [x, value] of cells) {
      if (value) page.drawText([...value].map((char) => codes.get(char) ?? char).join(""), { x, y, size: 8, font });
    }
  }
  await pdf.flush();
  pdf.context.lookup(font.ref, PDFDict).set(PDFName.of("ToUnicode"), pdf.context.register(pdf.context.flateStream(cmap)));
  return pdf.save();
}

try {
  let base = await boot(config, dataDir);
  const info = await request(base, "/api/ledger"); assert.equal(info.accountCount, 4); assert.deepEqual(info.errors, []);
  let batch = await upload(base, csv());
  assert.equal(batch.txs.length, 2); assert.equal(batch.parseStats?.excluded, 1); assert.ok(batch.txs.every((tx) => tx.sourceFileHash?.length === 64));
  assert.equal(batch.txs[0].fundingAccount, "Assets:CN:BOC:1111"); passed("multipart upload retains source rows, exclusion reasons and funding identity");
  assert.match(batch.txs[0].fundingReason!, /关键词.*卡尾号 1111/);
  {
    const failureData = path.join(temporary, "failed-imports");
    const importBase = await boot(config, failureData);
    const store = new BatchStore(path.join(failureData, "batches"));
    const uploadDirectory = path.join(failureData, "uploads");
    const archiveDirectory = path.join(root, "uploads");
    const previousArchives = fs.readdirSync(archiveDirectory);
    const header = csv().split("\n")[0];
    const unreadable = "2026-01-03 10:00:00,日用百货,测试商店,商品,支出,错误金额,中国银行储蓄卡(1111),交易成功,unreadable-row";
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["交易时间", "交易对方", "金额(元)"]]), "账单");
    const failedFiles = [
      ["支付宝-空账单.csv", header],
      ["支付宝-金额错误.csv", `${header}\n${unreadable}`],
      ["微信支付-空账单.xlsx", new Uint8Array(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }))],
      ["微信支付-空账单.xls", new Uint8Array(XLSX.write(workbook, { type: "buffer", bookType: "xls" }))],
      ["未解压.zip", "unsupported input"],
    ] as const;
    const rejected = await postStatements(importBase, failedFiles);
    const failure = await rejected.json();
    assert.equal(rejected.status, 422);
    assert.equal(failure.error, "未导入任何账单。");
    assert.equal(failure.batchId, undefined);
    assert.equal(failure.details.length, failedFiles.length);
    for (const [file] of failedFiles) assert.ok(failure.details.some((message: string) => message.startsWith(`${file}：`)));
    assert.deepEqual(await request(importBase, "/api/batches"), []);
    assert.deepEqual(store.list(), []);
    assert.deepEqual(fs.readdirSync(uploadDirectory), []);
    assert.deepEqual(fs.readdirSync(archiveDirectory), previousArchives);

    const good = "支付宝-部分交易.csv";
    const mixed = await postStatements(importBase, [
      failedFiles[1], [good, `${csv("partial-import")}\n${unreadable}`], failedFiles[2],
    ]);
    const result = await mixed.json();
    assert.equal(mixed.status, 200);
    const imported = store.get(result.batchId)!;
    assert.equal(imported.file, good);
    assert.equal(result.preview.file, good);
    assert.equal(imported.source, "alipay");
    assert.equal(imported.txs.length, 3);
    assert.ok(imported.txs.every((tx) => tx.sourceFile === good));
    assert.equal(imported.errors.filter(({ row }) => row === 0).length, 2);
    assert.equal(imported.errors.filter(({ row }) => row > 0).length, 1);
    assert.deepEqual(fs.readdirSync(uploadDirectory), []);
    assert.equal(fs.readFileSync(path.join(archiveDirectory, good), "utf8"), `${csv("partial-import")}\n${unreadable}`);

    const malformed = { ...imported.txs[2], sourceFile: failedFiles[1][0] };
    const hidden = store.create({ ...imported, file: malformed.sourceFile, txCount: 1, txs: [malformed] });
    const legacyMixed = store.create({ ...imported, file: `${malformed.sourceFile}, ${good}`, txCount: 2, txs: [malformed, imported.txs[0]] });
    const listed = await request(importBase, "/api/batches");
    assert.equal(listed.length, 2);
    assert.ok(listed.every(({ file }: { file: string }) => file === good));
    assert.ok(listed.some(({ batchId }: { batchId: string }) => batchId === legacyMixed.batchId));
    assert.ok(store.get(hidden.batchId));
    assert.equal((await request(importBase, `/api/batch/${legacyMixed.batchId}`)).file, good);
    passed("empty and unreadable tabular files create no batches; mixed uploads keep only imported files and their row diagnostics");
  }
  {
    const archiveRoot = path.join(temporary, "statement-archive-ledger");
    const archiveData = path.join(temporary, "statement-archive-data");
    fs.mkdirSync(archiveRoot);
    fs.writeFileSync(path.join(archiveRoot, "main.bean"), definitions);
    const archiveBase = await boot({ ...config, ledgerRoot: archiveRoot }, archiveData);
    const directory = path.join(archiveRoot, "uploads");
    const staged = path.join(archiveData, "uploads");
    const filename = "支付宝-测试账单.csv", first = csv("archive-original"), second = csv("archive-collision");
    const suffix = createHash("sha256").update(second).digest("hex").slice(-4);
    assert.equal((await request(archiveBase, "/api/config")).archiveUploadsInLedger, true);
    await upload(archiveBase, first, filename);
    await Promise.all([upload(archiveBase, second, filename), upload(archiveBase, second, filename)]);
    assert.equal(fs.readFileSync(path.join(directory, filename), "utf8"), first);
    for (const name of [`支付宝-测试账单-${suffix}.csv`, `支付宝-测试账单-2-${suffix}.csv`]) {
      assert.equal(fs.readFileSync(path.join(directory, name), "utf8"), second);
    }
    assert.deepEqual(fs.readdirSync(staged), []);
    await request(archiveBase, "/api/config", { archiveUploadsInLedger: "false" }, 400);
    const saved = await request(archiveBase, "/api/config", { archiveUploadsInLedger: false });
    assert.equal(saved.archiveUploadsInLedger, false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(archiveRoot, ".beancount-importer.json"), "utf8")).archiveUploadsInLedger, false);
    const applicationCopy = csv("application-copy");
    await upload(archiveBase, applicationCopy, "支付宝-关闭归档.csv");
    assert.equal(fs.readdirSync(directory).length, 3);
    const internalFiles = fs.readdirSync(staged);
    assert.equal(internalFiles.length, 1);
    assert.match(internalFiles[0], /^[a-f0-9]{32}\.csv$/);
    assert.equal(fs.readFileSync(path.join(staged, internalFiles[0]), "utf8"), applicationCopy);

    const nextRoot = path.join(temporary, "new-archive-ledger");
    fs.mkdirSync(nextRoot);
    fs.writeFileSync(path.join(nextRoot, "main.bean"), definitions);
    fs.writeFileSync(path.join(nextRoot, "uploads"), "existing file");
    assert.equal((await request(archiveBase, "/api/config", { ledgerRoot: nextRoot })).archiveUploadsInLedger, true);
    const failed = await postStatements(archiveBase, [[filename, first]]);
    assert.equal(failed.status, 422);
    assert.match((await failed.json()).details[0], /无法保存账单副本/);
    assert.deepEqual(await request(archiveBase, "/api/batches"), []);
    assert.deepEqual(fs.readdirSync(staged), internalFiles);
    assert.equal((await request(archiveBase, "/api/config", { ledgerRoot: archiveRoot })).archiveUploadsInLedger, false);
    passed("statement archives preserve filenames, resolve concurrent collisions, and use the saved preference of each ledger");
  }
  {
    const pdfRoot = path.join(temporary, "pdf-statements");
    const credit = "Liabilities:CreditCard:CMB";
    const citic = "Liabilities:CreditCard:CITIC";
    fs.mkdirSync(pdfRoot);
    fs.writeFileSync(path.join(pdfRoot, "main.bean"), definitions + `2025-01-01 open ${credit}\n2025-01-01 open ${citic}\n`);
    const pdfBase = await boot({ ...config, ledgerRoot: pdfRoot, assetMapping: [
      ...config.assetMapping, { keyword: "招商银行信用卡(4141)", account: credit, kind: "credit", exact: true, source: "wechat" },
      { keyword: "中信银行信用卡(6363)", account: citic, kind: "credit", exact: true, source: "wechat" },
    ] }, path.join(temporary, "pdf-data"));
    const columns = [43, 94, 140, 380, 479, 545];
    const rows = [
      ["招商银行信用卡对账单（2026年1月）"],
      ["账单日", "", "2026年1月7日"],
      ["交易日", "记账日", "交易摘要", "人民币金额", "卡号末四位", "原始金额"],
      ["还款"], ["", "01/03", "自动还款", "-300.00", "4141", "-300.00"],
      ["分期"], ["04/13", "12/31", "消费分期", "45.25", "4141", "45.25"],
      ["退款"], ["12/31", "01/02", "商户", "-15.10", "4141", "-15.10"],
      ["消费"], ["12/27", "01/01", "商户", "1,234.56", "4242", "1,234.56"],
      ["交易日", "记账日", "交易摘要", "美元金额", "卡号末四位", "原始金额"],
      ["消费"], ["01/03", "01/04", "商户", "14.41", "4141", "96.31"],
    ];
    const sample = await upload(pdfBase, await fixturePdf([
      rows.map((row, index) => [760 - index * 14, row.map((value, col) => [columns[col], value])]),
      [[760, [[43, "Statement information"]]]],
    ]), "2026-01.pdf");
    assert.equal(sample.source, "bank-cmb");
    assert.deepEqual(sample.errors, []);
    assert.deepEqual(sample.txs.map(({ date, amount, currency, direction, eventType }) => [date, amount, currency, direction, eventType]), [
      ["2026-01-03", 300, "CNY", "in", "transfer"],
      ["2025-12-31", 45.25, "CNY", "out", "expense"],
      ["2025-12-31", 15.10, "CNY", "in", "refund"],
      ["2025-12-27", 1234.56, "CNY", "out", "expense"],
      ["2026-01-03", 14.41, "USD", "out", "expense"],
    ]);
    assert.ok(sample.txs.every((tx) => tx.balanceAfter === undefined));
    assert.equal(sample.txs[0].fundingAccount, credit);
    assert.match(sample.txs[0].fundingReason!, /卡尾号 4141/);
    const prompt = await request(pdfBase, `/api/batch/${sample.batchId}/funding`, { revision: sample.revision });
    assert.deepEqual(prompt.groups.map(({ label, count }: { label: string; count: number }) => [label, count]), [["招商银行信用卡(4242)", 1]]);

    const generic = await PDFDocument.create();
    generic.addPage().drawText("2026-01-02    Cafe    3.25    100.00");
    const other = await upload(pdfBase, await generic.save(), "bank.pdf");
    assert.equal(other.source, "bank-generic");
    assert.deepEqual(other.errors, []);
    assert.deepEqual(other.txs.map(({ date, amount, balanceAfter }) => [date, amount, balanceAfter]), [["2026-01-02", 3.25, 100]]);
    passed("PDF upload recognizes CMB credit-card sections, year rollover, billing currencies and card mappings, while preserving generic PDF parsing");

    const transaction = (y: number, traded: string, booked: string, description: string, original: string, amount: string): PdfRow =>
      [y, [[8, traded], [74, booked], [159, "6363"], [214, description], [370, original], [482, amount]]];
    const citicPdf = await fixturePdf([
      [
        [780, [[43, "中信银行信用卡对账单"]]],
        [735, [[7, "交易日"], [78, "银行记账日"], [148, "卡号后四位"], [259, "交易描述"], [370, "交易货币/金额"], [482, "记账货币/金额"]]],
        [698, [[214, "消费分"]]],
        transaction(690, "20260401", "20260410", "", "USD 7.50", "CNY 54.00"),
        [680, [[214, "期商户"]]],
        transaction(649, "20260412", "20260413", "跨页商户", "USD 8.25", "USD 8.25"),
      ],
      [
        [766, [[214, "有限公司"]]],
        transaction(750, "20260413", "20260414", "自助还款", "CNY -800.00", "CNY -800.00"),
        transaction(724, "20260415", "20260416", "测试退款", "CNY -14.10", "CNY -14.10"),
        transaction(697, "20260416", "20260417", "返现活动", "CNY -2.50", "CNY -2.50"),
      ],
    ]);
    const creditSample = await upload(pdfBase, citicPdf, "card-statement.pdf");
    assert.equal(creditSample.source, "bank-citic");
    assert.deepEqual(creditSample.errors, []);
    assert.deepEqual(creditSample.txs.map(({ date, payee, amount, currency, direction, eventType }) => [date, payee, amount, currency, direction, eventType]), [
      ["2026-04-10", "消费分期商户", 54, "CNY", "out", "expense"],
      ["2026-04-12", "跨页商户有限公司", 8.25, "USD", "out", "expense"],
      ["2026-04-13", "自助还款", 800, "CNY", "in", "transfer"],
      ["2026-04-15", "测试退款", 14.10, "CNY", "in", "refund"],
      ["2026-04-16", "返现活动", 2.50, "CNY", "in", "income"],
    ]);
    assert.ok(creditSample.txs.every((tx) => tx.rawAccount === "中信银行信用卡(6363)" && tx.fundingAccount === citic));
    assert.match(creditSample.txs[0].note, /原交易 USD 7\.50/);
    const alternate = path.join(temporary, "different-pdf-rules.json"), input = path.join(temporary, "renamed.pdf");
    const layouts = JSON.parse(fs.readFileSync(new URL("../config/pdf-rules.json", import.meta.url), "utf8"));
    const copied = layouts.tables.find((layout: { source: string }) => layout.source === "bank-citic");
    fs.writeFileSync(alternate, JSON.stringify({ ...layouts, tables: [{ ...copied, source: "bank-configured-fixture" }] }));
    fs.writeFileSync(input, citicPdf);
    const configured = await parsePdfBank(input, "bank-generic", loadPdfRules(alternate));
    assert.equal(configured.source, "bank-configured-fixture");
    assert.deepEqual(configured.txs.map(({ payee }) => payee), creditSample.txs.map(({ payee }) => payee));
    passed("table PDF layouts come from configuration and preserve settlement amounts, types and descriptions across page breaks");

    const continued = creditSample.txs[1];
    assert.deepEqual(continued.pdfRegions?.map(({ page }) => page), [1, 2]);
    const previewOf = (id: string, txId: string) => `/api/batch/${id}/pdf-preview/${encodeURIComponent(txId)}`;
    const response = await transport(pdfBase, previewOf(creditSample.batchId, continued.id));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json();
    assert.equal(body.file, creditSample.file);
    assert.deepEqual(body.screenshots.map(({ page }: { page: number }) => page), [1, 2]);
    for (const { image } of body.screenshots) {
      assert.match(image, /^data:image\/png;base64,/);
      const png = Buffer.from(image.split(",")[1], "base64");
      assert.equal(png.subarray(1, 4).toString(), "PNG");
      assert.ok(png.readUInt32BE(20) < 150);
    }
    const pdfStore = new BatchStore(path.join(temporary, "pdf-data", "batches"));
    const savedPdfBatch = pdfStore.get(creditSample.batchId)!;
    assert.deepEqual(savedPdfBatch.pdfUploads?.[continued.sourceFileHash!], { archiveName: "card-statement.pdf" });
    assert.equal("pdfUploads" in creditSample, false);
    const ledgerPdfDirectory = path.join(pdfRoot, "uploads");
    const pdfUploadsDirectory = path.join(temporary, "pdf-data", "uploads");
    assert.deepEqual(fs.readFileSync(path.join(ledgerPdfDirectory, "card-statement.pdf")), Buffer.from(citicPdf));
    assert.deepEqual(fs.readdirSync(pdfUploadsDirectory), []);
    fs.writeFileSync(path.join(pdfUploadsDirectory, `${"a".repeat(32)}.pdf`), citicPdf);
    const legacy = pdfStore.create({ file: creditSample.file, source: creditSample.source, txCount: 1,
      txs: [{ ...continued, pdfRegions: undefined }], errors: [], accountsDetected: [], ledgerProfile: savedPdfBatch.ledgerProfile });
    const restoredPreview = await request(pdfBase, previewOf(legacy.batchId, continued.id));
    assert.deepEqual(restoredPreview.screenshots, body.screenshots);
    const missing = pdfStore.create({ ...legacy, txs: [{ ...legacy.txs[0], sourceFileHash: "0".repeat(64) }] });
    const missingPreview = await request(pdfBase, previewOf(missing.batchId, continued.id), undefined, 404);
    assert.match(missingPreview.error, /重新上传原账单/);
    const otherLedger = await boot(config, path.join(temporary, "pdf-data"));
    await request(otherLedger, previewOf(creditSample.batchId, continued.id), undefined, 409);
    passed("source screenshots crop the selected transaction across pages, recover older batches and honor ledger boundaries");

    const beforeBroken = await request(pdfBase, "/api/batches");
    const beforeUploads = fs.readdirSync(pdfUploadsDirectory);
    const beforeArchives = fs.readdirSync(ledgerPdfDirectory);
    const broken = await postStatements(pdfBase, [["损坏.pdf", Buffer.from("%PDF-1.7\ntruncated PDF")]]);
    assert.equal(broken.status, 422);
    assert.deepEqual(await broken.json(), { error: "未导入任何账单。", details: ["损坏.pdf：这份 PDF 无法打开。请重新下载原账单后上传。"] });
    assert.deepEqual(await request(pdfBase, "/api/batches"), beforeBroken);
    assert.deepEqual(fs.readdirSync(pdfUploadsDirectory), beforeUploads);
    assert.deepEqual(fs.readdirSync(ledgerPdfDirectory), beforeArchives);
    const old = pdfStore.create({ file: "old.pdf", source: "bank-generic", txs: [], txCount: 0, accountsDetected: [],
      ledgerProfile: profileId(pdfRoot, "main.bean"), errors: [
        { row: 0, message: "old.pdf：PDF 解析失败：Promise.withResolvers is not a function" },
        { row: 5, message: "无法解析日期或金额" },
      ] });
    const resumed = await request(pdfBase, `/api/batch/${old.batchId}`);
    assert.match(resumed.errors[0].message, /^old\.pdf：暂时无法读取 PDF/);
    assert.doesNotMatch(resumed.errors[0].message, /Promise\.withResolvers|is not a function/);
    assert.deepEqual(resumed.errors[1], old.errors[1]);
    assert.deepEqual(await request(pdfBase, "/api/batches"), beforeBroken);

    const originalLog = console.error;
    const log: unknown[][] = [];
    console.error = (...args) => { log.push(args); };
    try {
      const failedRead = await parsePdfBank(path.join(temporary, "internal-only-missing.pdf"), "bank-generic");
      assert.match(failedRead.errors[0].message, /请重新上传/);
      assert.doesNotMatch(failedRead.errors[0].message, /ENOENT|internal-only-missing/);
      assert.match(String(log[0]?.[1]), /internal-only-missing/);
    } finally { console.error = originalLog; }
    passed("unreadable PDFs and older batches give re-upload guidance while runtime details stay in the server log");

    await request(pdfBase, "/api/config", { archiveUploadsInLedger: false });
    const internal = await upload(pdfBase, await generic.save(), "应用目录.pdf");
    assert.equal(typeof pdfStore.get(internal.batchId)!.pdfUploads?.[internal.txs[0].sourceFileHash!], "string");
    assert.equal((await request(pdfBase, previewOf(internal.batchId, internal.txs[0].id))).screenshots.length, 1);
    assert.deepEqual((await request(pdfBase, previewOf(creditSample.batchId, continued.id))).screenshots, body.screenshots);
    passed("PDF previews read their saved copy after the ledger archive setting changes");
  }
  {
    const statusData = path.join(temporary, "status-only-data");
    const statusBase = await boot(config, statusData);
    const sample = await upload(statusBase, csv("status-only"));
    const statusRoute = `/api/batch/${sample.batchId}`;
    const withoutPython = await boot({ ...config, pythonPath: path.join(temporary, "missing-python.exe") }, statusData);
    const id = sample.txs[0].id;
    const otherSession = "abcdef1234567890abcdef1234567890";
    assert.equal(sample.reviewUndo, undefined);
    const excluded = await request(withoutPython, statusRoute + "/decide", {
      revision: sample.revision, decisions: [{ id, status: "excluded" }], changesOnly: true, reviewSessionId,
    });
    assert.equal(excluded.batch, undefined);
    assert.deepEqual(excluded.changes.txs.map((tx: ParsedTx) => [tx.id, tx.status]), [[id, "excluded"]]);
    assert.equal(excluded.changes.parseStats.excluded, 2);
    assert.deepEqual(excluded.reviewUndo, { sessionId: reviewSessionId, depth: 1, action: "exclude", count: 1 });
    await request(withoutPython, statusRoute + "/decide", { revision: sample.revision, decisions: [{ id, status: "ready" }] }, 409);
    const ready = await request(withoutPython, statusRoute + "/decide", {
      revision: excluded.revision, decisions: [{ id, status: "ready" }], reviewSessionId,
    });
    assert.equal(ready.batch.txs[0].status, "ready");
    assert.equal(ready.ready, 1);
    assert.deepEqual(ready.batch.reviewUndo, { sessionId: reviewSessionId, depth: 2, action: "approve", count: 1 });
    assert.deepEqual(ready.batch, await request(withoutPython, statusRoute));
    assert.equal(ready.batch.reviewStatusHistory, undefined);
    assert.equal(fs.existsSync(path.join(statusData, "profiles")), false);
    const accountFailure = await request(withoutPython, statusRoute + "/decide", {
      revision: ready.revision, decisions: [{ id, account: "Expenses:Food:Meals:Dine" }],
    }, 500);
    assert.match(accountFailure.error, /账本设置.*Python 路径/);
    assert.doesNotMatch(JSON.stringify(accountFailure), /ENOENT|missing-python\.exe/);
    const generationFailure = await request(withoutPython, statusRoute + "/generate", { revision: ready.revision }, 500);
    assert.deepEqual(generationFailure, accountFailure);
    assert.equal((await request(withoutPython, statusRoute)).revision, ready.revision);
    const narrated = await request(withoutPython, statusRoute + "/decide", {
      revision: ready.revision, decisions: [{ id, narration: "自动保存的摘要" }], changesOnly: true, reviewSessionId,
    });
    assert.equal(narrated.batch, undefined);
    assert.deepEqual(narrated.changes.txs.map((tx: ParsedTx) => [tx.id, tx.status, tx.narration]), [[id, "ready", "自动保存的摘要"]]);
    passed("posting decisions can return only changed rows without invoking Python, while account checks and generation still require it");

    const updated = await request(statusBase, statusRoute + "/decide", {
      revision: narrated.revision, decisions: [{ id, account: "Equity:Coupons:Payment", reviewNote: "保留审批备注", tags: ["keep"] }],
      changesOnly: true, reviewSessionId,
    });
    assert.deepEqual(updated.reviewUndo, { sessionId: reviewSessionId, depth: 2, action: "approve", count: 1 });
    const reopened = await boot({ ...config, pythonPath: path.join(temporary, "missing-python.exe") }, statusData);
    const current = await request(reopened, statusRoute);
    const undoRoute = statusRoute + "/undo-review-status";
    await request(reopened, undoRoute, { revision: narrated.revision, reviewSessionId }, 409);
    await request(reopened, undoRoute, { revision: current.revision, reviewSessionId: otherSession }, 409);
    const undone = await request(reopened, undoRoute, { revision: current.revision, reviewSessionId });
    assert.deepEqual(undone.restoredIds, [id]);
    assert.equal(undone.batch.revision, current.revision + 1);
    assert.deepEqual(undone.batch.txs, [{ ...current.txs[0], status: "excluded" }, current.txs[1]]);
    assert.deepEqual(undone.batch.reviewUndo, excluded.reviewUndo);
    const initialStatus = await request(reopened, undoRoute, { revision: undone.batch.revision, reviewSessionId });
    assert.deepEqual(initialStatus.restoredIds, [id]);
    assert.deepEqual(initialStatus.batch.txs, [{ ...current.txs[0], status: sample.txs[0].status }, current.txs[1]]);
    assert.equal(initialStatus.batch.reviewUndo, undefined);
    assert.equal(new BatchStore(path.join(statusData, "batches")).get(sample.batchId)?.reviewStatusHistory, undefined);
    await request(reopened, undoRoute, { revision: initialStatus.batch.revision, reviewSessionId }, 409);
    const excludedAgain = await request(reopened, statusRoute + "/decide", {
      revision: initialStatus.batch.revision, decisions: [{ id, status: "excluded" }], reviewSessionId,
    });
    assert.deepEqual(excludedAgain.batch.reviewUndo, excluded.reviewUndo);
    const newVisit = await request(reopened, statusRoute + "/decide", {
      revision: excludedAgain.revision, decisions: [{ id, status: "ready" }], reviewSessionId: otherSession,
    });
    assert.deepEqual(newVisit.batch.reviewUndo, { sessionId: otherSession, depth: 1, action: "approve", count: 1 });
    await request(reopened, undoRoute, { revision: newVisit.revision, reviewSessionId }, 409);
    const restored = await request(reopened, undoRoute, { revision: newVisit.revision, reviewSessionId: otherSession });
    assert.deepEqual(restored.batch.txs, excludedAgain.batch.txs);
    assert.equal(restored.batch.reviewUndo, undefined);
    passed("review status undo is last-in-first-out within a visit and preserves later category, narration, and review metadata edits");
  }
  {
    const catalogRoot = path.join(temporary, "account-catalog");
    fs.mkdirSync(catalogRoot);
    const chart = path.join(catalogRoot, "accounts.bean");
    fs.writeFileSync(path.join(catalogRoot, "main.bean"), 'include "accounts.bean"\n');
    fs.writeFileSync(chart, definitions);
    const catalogBase = await boot({ ...config, ledgerRoot: catalogRoot }, path.join(temporary, "account-catalog-data"));
    const sample = await upload(catalogBase, csv("account-catalog"));
    await request(catalogBase, "/api/ledger");
    const route = `/api/batch/${sample.batchId}/decide`;
    const id = sample.txs[0].id;
    const oldAccount = "Expenses:Food:Meals:Dine";
    const newAccount = "Expenses:Food:Meals:Meal";
    const first = await request(catalogBase, route, {
      revision: sample.revision, decisions: [{ id, account: oldAccount, status: "ready" }], changesOnly: true,
    });
    assert.equal(first.batch, undefined);
    assert.deepEqual(first.changes.txs.map((tx: ParsedTx) => [tx.id, tx.finalAccount, tx.status]), [[id, oldAccount, "ready"]]);
    fs.writeFileSync(chart, definitions.replace(oldAccount, newAccount));
    await request(catalogBase, route, { revision: first.revision, decisions: [{ id, account: oldAccount }] }, 400);
    const updated = await request(catalogBase, route, {
      revision: first.revision, decisions: [{ id, account: newAccount }], changesOnly: true,
    });
    assert.deepEqual(updated.changes.txs.map((tx: ParsedTx) => [tx.id, tx.finalAccount]), [[id, newAccount]]);
    passed("compact approval remains current when an included account definition changes");
  }
  {
    const approvalData = path.join(temporary, "approval-accounts");
    const approvalBase = await boot(config, approvalData);
    const store = new BatchStore(path.join(approvalData, "batches"));
    const funding = "Assets:CN:BOC:1111", category = "Expenses:Food:Meals:Dine";
    const fixture: ParsedTx = { ...batch.txs[0], status: "pending", fundingAccount: "", finalAccount: "", suggestedAccount: "" };
    const txs: ParsedTx[] = [
      { ...fixture, id: "unfunded", finalAccount: category },
      { ...fixture, id: "unclassified", fundingAccount: funding },
      { ...fixture, id: "categorized-later" },
      { ...fixture, id: "explicit-postings", postings: [
        { account: funding, amount: -fixture.amount, currency: fixture.currency },
        { account: category, amount: fixture.amount, currency: fixture.currency },
      ] },
    ];
    const saved = store.create({ file: "approval-accounts.csv", source: "alipay", txs, txCount: txs.length, errors: [], accountsDetected: [],
      ledgerProfile: profileId(root, "main.bean") });
    const route = `/api/batch/${saved.batchId}/decide`;
    const unfunded = await request(approvalBase, route, { revision: saved.revision, decisions: [
      { id: "explicit-postings", status: "ready" }, { id: "unfunded", status: "ready" },
    ] }, 422);
    assert.equal(unfunded.error, "请先选择资金账户");
    assert.equal(store.get(saved.batchId)!.txs[3].status, "pending");
    const unclassified = await request(approvalBase, route, { revision: saved.revision, decisions: [{ id: "unclassified", status: "ready" }] }, 422);
    assert.equal(unclassified.error, "请先选择分类账户");
    const savedCategory = await request(approvalBase, route, { revision: saved.revision, decisions: [
      { id: "categorized-later", account: category }, { id: "unclassified", account: category }, { id: "explicit-postings", status: "ready" },
    ], changesOnly: true });
    assert.deepEqual(savedCategory.changes.txs.map((tx: ParsedTx) => [tx.id, tx.status, tx.finalAccount]), [
      ["unclassified", "ready", category], ["categorized-later", "pending", category], ["explicit-postings", "ready", ""],
    ]);
    const completed = await request(approvalBase, route, { revision: savedCategory.revision, decisions: [
      { id: "categorized-later", funding, status: "ready" },
    ], changesOnly: true });
    assert.equal(completed.changes.txs[0].status, "ready");
    passed("approval checks posting accounts before saving and keeps a category selected without funding");
  }
  {
    const giftRoot = path.join(temporary, "income-funding-ledger");
    const giftData = path.join(temporary, "income-funding-data");
    const income = "Income:Gifts", wallet = "Assets:CN:BOC:1111";
    const giftDefinitions = `${definitions}2025-01-01 open ${income} CNY\n`;
    fs.mkdirSync(giftRoot);
    fs.writeFileSync(path.join(giftRoot, "main.bean"), giftDefinitions);
    const giftBase = await boot({ ...config, ledgerRoot: giftRoot }, giftData);
    const header = "交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号";
    const row = (payment: string, id: string) => `2026-11-06 12:00:00,微信红包,发送人,红包,收入,12.34,${payment},已存入零钱,${id}`;
    const file = "微信支付红包.csv";
    const gift = await upload(giftBase, `${header}\n${row("/", "gift-source")}`, file);
    const tx = gift.txs[0], route = `/api/batch/${gift.batchId}`;
    assert.equal(tx.eventType, "income");
    assert.equal(tx.fundingAccount, "");
    const reviewed = await request(giftBase, `${route}/decide`, {
      revision: gift.revision, decisions: [{ id: tx.id, funding: income, account: wallet, status: "ready" }],
    });
    assert.equal(reviewed.batch.txs[0].fundingAccount, income);
    const preview = await request(giftBase, `${route}/generate`, { revision: reviewed.revision });
    const parsed = parseLedgerText(giftDefinitions + preview.entries, python);
    assert.deepEqual(parsed.errors, []);
    assert.deepEqual(parsed.transactions[0].postings, [
      { account: income, amount: -12.34, currency: "CNY" }, { account: wallet, amount: 12.34, currency: "CNY" },
    ]);
    const mapping = { keyword: "红包收入凭据", account: income, source: "wechat", kind: "debit" };
    await request(giftBase, "/api/config", { assetMapping: [...config.assetMapping, mapping] });
    const mapped = await upload(giftBase, `${header}\n${row("红包收入凭据", "gift-mapped")}`, file);
    assert.equal(mapped.txs[0].fundingAccount, income);

    const walletMapping = { keyword: "零钱", account: wallet, source: "wechat", kind: "debit", exact: true };
    await request(giftBase, "/api/config", { assetMapping: [...config.assetMapping, mapping, walletMapping] });
    const store = new BatchStore(path.join(giftData, "batches"));
    const legacyRow = { ...tx, id: "old-gift", sourceTxId: "old-gift", recognition: undefined, reviewNote: "已核对" };
    const old = store.create({ file, source: "merged", txs: [legacyRow], txCount: 1,
      errors: [], accountsDetected: [], ledgerProfile: profileId(giftRoot, "main.bean") });
    const oldRoute = `/api/batch/${old.batchId}`;
    const reloaded = await request(giftBase, `${oldRoute}/recheck-ledger`, { revision: old.revision });
    assert.equal(reloaded.batch.txs[0].fundingAccount, wallet);
    assert.equal(reloaded.batch.txs[0].reviewNote, "已核对");
    assert.equal(reloaded.batch.txs[0].status, "pending");

    const transfer = "2026-11-06 12:01:00,转账,另一位发送人,转账,收入,56.78,/,已存入零钱,transfer-source";
    const receipts = await upload(giftBase, [header, row("/", "new-gift"), transfer].join("\n"), file);
    assert.deepEqual(receipts.txs.map((receipt) => [receipt.eventType, receipt.fundingAccount]), [["income", wallet], ["transfer", wallet]]);
    const receiptRoute = `/api/batch/${receipts.batchId}`;
    const categorized = await request(giftBase, `${receiptRoute}/decide`, {
      revision: receipts.revision, decisions: receipts.txs.map(({ id }) => ({ id, account: income })),
    });
    assert.equal(categorized.ready, 2);
    const receiptPreview = await request(giftBase, `${receiptRoute}/generate`, { revision: categorized.revision });
    const parsedReceipts = parseLedgerText(giftDefinitions + receiptPreview.entries, python);
    assert.deepEqual(parsedReceipts.errors, []);
    assert.deepEqual(parsedReceipts.transactions.map(({ postings }) => postings), [12.34, 56.78].map((amount) => [
      { account: wallet, amount, currency: "CNY" }, { account: income, amount: -amount, currency: "CNY" },
    ]));

    const counterpart = "Equity:Coupons:Payment";
    const legacyTransfer: ParsedTx = { ...receipts.txs[1], id: "old-transfer", sourceTxId: "old-transfer", direction: "out",
      originalDirection: "支出", sourceStatus: "对方已收钱", fundingAccount2: "Assets:CN:BOC:2222" };
    const legBatch = store.create({ file, source: "wechat", txs: [legacyTransfer], txCount: 1,
      errors: [], accountsDetected: [], ledgerProfile: profileId(giftRoot, "main.bean") });
    const legRoute = `/api/batch/${legBatch.batchId}`;
    const updatedLeg = await request(giftBase, `${legRoute}/decide`, {
      revision: legBatch.revision, decisions: [{ id: legacyTransfer.id, account: counterpart }],
    });
    assert.equal(updatedLeg.batch.txs[0].fundingAccount2, counterpart);
    const legPreview = await request(giftBase, `${legRoute}/generate`, { revision: updatedLeg.revision });
    const leg = parseLedgerText(giftDefinitions + legPreview.entries, python);
    assert.deepEqual(leg.errors, []);
    assert.deepEqual(leg.transactions[0].postings, [
      { account: wallet, amount: -56.78, currency: "CNY" }, { account: counterpart, amount: 56.78, currency: "CNY" },
    ]);
    passed("WeChat red envelopes and incoming transfers accept income categories and resolve the receiving wallet on reload and import");
  }
  {
    const splitRoot = path.join(temporary, "category-allocations");
    fs.mkdirSync(splitRoot);
    const splitDefinitions = definitions + "2025-01-01 open Expenses:Food:Snacks CNY\n2025-01-01 open Expenses:Food:Other CNY\n";
    fs.writeFileSync(path.join(splitRoot, "main.bean"), splitDefinitions);
    const splitBase = await boot({ ...config, ledgerRoot: splitRoot }, path.join(temporary, "category-allocations-data"));
    const sample = await upload(splitBase, csv("category-allocations"));
    const route = `/api/batch/${sample.batchId}`;
    const id = sample.txs[0].id;
    const meal = { account: "Expenses:Food:Meals:Dine", amount: "15.34" };
    const snacks = { account: "Expenses:Food:Snacks", amount: "-3.00" };
    const other = { account: "Expenses:Food:Other", amount: "0" };
    await request(splitBase, route + "/decide", {
      revision: sample.revision, decisions: [{ id, status: "ready", categoryAllocations: [meal, { ...snacks, amount: "-2.50" }] }],
    }, 422);
    assert.equal((await request(splitBase, route)).revision, sample.revision);
    const split = await request(splitBase, route + "/decide", {
      revision: sample.revision, decisions: [{ id, status: "ready", categoryAllocations: [meal, snacks, other] }], changesOnly: true,
    });
    const postings = [
      { account: "Assets:CN:BOC:1111", amount: -12.34, currency: "CNY" },
      { account: meal.account, amount: 15.34, currency: "CNY" },
      { account: snacks.account, amount: -3, currency: "CNY" },
      { account: other.account, amount: 0, currency: "CNY" },
    ];
    assert.deepEqual(split.changes.txs[0].postings, postings);
    const preview = await request(splitBase, route + "/generate", { revision: split.revision });
    const parsed = parseLedgerText(splitDefinitions + preview.entries, python);
    assert.deepEqual(parsed.errors, []);
    assert.deepEqual(parsed.transactions[0].postings, postings);
    const single = await request(splitBase, route + "/decide", {
      revision: split.revision, decisions: [{ id, categoryAllocations: [{ ...meal, amount: "12.34" }] }],
    });
    assert.equal(single.batch.txs[0].postings, undefined);
    assert.equal(single.batch.txs[0].finalAccount, meal.account);
    passed("category allocation totals are checked before saving and can return to a single account");
  }
  {
    const mergeRoot = path.join(temporary, "merge-ledger");
    const mergeData = path.join(temporary, "merge-data");
    const cnyFund = "Assets:CN:BOC:1111", otherFund = "Assets:CN:BOC:2222", usdFund = "Assets:Wallet:USD";
    const meal = "Expenses:Food:Meals:Dine", usdExpense = "Expenses:Travel", income = "Income:Sales";
    const mergeDefinitions = definitions + [usdFund, usdExpense, income].map((account) => `2025-01-01 open ${account}\n`).join("");
    fs.mkdirSync(mergeRoot);
    fs.writeFileSync(path.join(mergeRoot, "main.bean"), mergeDefinitions);
    const mergeBase = await boot({ ...config, ledgerRoot: mergeRoot }, mergeData);
    const store = new BatchStore(path.join(mergeData, "batches"));
    const seed = (txs: ParsedTx[]) => store.create({ file: "merge.csv", source: "alipay", txs, txCount: txs.length,
      errors: [], accountsDetected: [], ledgerProfile: profileId(mergeRoot, "main.bean") });
    const mealA: ParsedTx = { ...batch.txs[0], id: "merge-meal-a", sourceTxId: "merge-meal-a",
      finalAccount: meal, status: "ready", flag: "!", tags: ["dining", "travel"], reviewNote: "原来的审批备注" };
    const mealB: ParsedTx = { ...mealA, id: "merge-meal-b", sourceTxId: "merge-meal-b", status: "pending", tags: ["travel", "work"] };
    const dollars: ParsedTx = { ...mealA, id: "merge-usd", sourceTxId: undefined, row: 42, date: "2026-02-01",
      amount: 7.25, currency: "USD", fundingAccount: "", finalAccount: "", status: "pending", tags: [] };
    const sample = seed([mealA, mealB, dollars]);
    const route = `/api/batch/${sample.batchId}`;
    const mergeBody = { ids: sample.txs.map(({ id }) => id), payee: "手填商户", narration: "跨月多币种合并" };
    const incomplete = await request(mergeBase, route + "/merge", { revision: sample.revision, ...mergeBody, date: dollars.date }, 422);
    assert.match(incomplete.details[0], /请先补齐资金账户和分类账户/);
    const corrected = await request(mergeBase, route + "/decide", { revision: sample.revision,
      decisions: [{ id: dollars.id, account: usdExpense, funding: usdFund, status: "pending" }] });
    await request(mergeBase, route + "/merge", { revision: corrected.revision, ...mergeBody }, 400);
    const merge = async (revision: number) => request(mergeBase, route + "/merge", { revision, ...mergeBody, date: dollars.date });
    const combined = await merge(corrected.revision);
    const group = combined.batch.txs.find((tx: ParsedTx) => tx.id === combined.mergedId) as ParsedTx;
    assert.equal(group.status, "pending");
    assert.equal(group.flag, "*");
    assert.deepEqual(group.tags, ["dining", "travel", "work"]);
    assert.deepEqual(group.merge?.totals, [{ currency: "CNY", amount: -24.68 }, { currency: "USD", amount: -7.25 }]);
    assert.deepEqual(combined.batch.parseStats, { total: 1, pending: 1, ready: 0, duplicate: 0, excluded: 0 });
    await request(mergeBase, route + "/generate", { revision: combined.batch.revision }, 422);
    await request(mergeBase, route + "/decide", { revision: combined.batch.revision, decisions: [{ id: mealA.id, status: "excluded" }] }, 400);
    const rechecked = await request(mergeBase, route + "/recheck-ledger", { revision: combined.batch.revision });
    const undone = await request(mergeBase, route + "/undo-merge", { revision: rechecked.batch.revision, id: group.id });
    assert.deepEqual(undone.batch.txs, corrected.batch.txs);
    const remerged = await merge(undone.batch.revision);
    const confirmed = await request(mergeBase, route + "/decide", { revision: remerged.batch.revision,
      decisions: [{ id: remerged.mergedId, status: "ready" }] });
    const preview = await request(mergeBase, route + "/generate", { revision: confirmed.revision });
    assert.deepEqual(preview.targetFiles, ["years/2026/imported/2026-02.bean"]);
    assert.equal(preview.generated, 1);
    const parse = parseLedgerText(mergeDefinitions + preview.entries, python);
    assert.deepEqual(parse.errors, []);
    assert.deepEqual(parse.transactions[0].postings, [
      { account: cnyFund, amount: -12.34, currency: "CNY" }, { account: meal, amount: 12.34, currency: "CNY" },
      { account: cnyFund, amount: -12.34, currency: "CNY" }, { account: meal, amount: 12.34, currency: "CNY" },
      { account: usdFund, amount: -7.25, currency: "USD" }, { account: usdExpense, amount: 7.25, currency: "USD" },
    ]);
    assert.equal(parse.transactions[0].narration, mergeBody.narration);
    await request(mergeBase, route + "/commit", { revision: confirmed.revision });
    await request(mergeBase, route + "/undo-merge", { revision: confirmed.revision, id: remerged.mergedId }, 409);
    const written = parseLedger(mergeRoot, "main.bean", python);
    assert.deepEqual(written.errors, []);
    assert.equal(written.transactions.length, 1);
    assert.deepEqual(markDuplicates([mealA, mealB, dollars].map((tx) => ({ ...tx })), written.transactions).txs.map((tx) => tx.status),
      ["duplicate", "duplicate", "duplicate"]);
    const importedAgain = await upload(mergeBase, csv(mealA.sourceTxId));
    assert.equal(importedAgain.txs[0].status, "duplicate");
    passed("merging preserves dated source identities and individual postings across currencies, supports undo and detects reimports after commit");

    const expense: ParsedTx = { ...mealA, id: "net-expense", sourceTxId: "net-expense" };
    const receipt: ParsedTx = { ...mealA, id: "net-receipt", sourceTxId: "net-receipt", direction: "in", eventType: "income", finalAccount: income };
    for (const fund of [cnyFund, otherFund]) {
      const net = seed([expense, { ...receipt, fundingAccount: fund }]);
      const netRoute = `/api/batch/${net.batchId}`;
      const selection = await request(mergeBase, netRoute + "/merge", { revision: net.revision, ids: [expense.id, receipt.id], payee: "零净额", narration: "" });
      const merged = selection.batch.txs.at(-1) as ParsedTx;
      assert.equal(merged.status, "pending");
      assert.equal(merged.date, expense.date);
      assert.deepEqual(merged.merge?.totals, [{ currency: "CNY", amount: 0 }]);
      const decide = (status: "ready" | "excluded", expected?: number) => request(mergeBase, netRoute + "/decide", {
        revision: selection.batch.revision, decisions: [{ id: merged.id, status }],
      }, expected);
      if (fund === cnyFund) {
        assert.ok(merged.excludedReason);
        await decide("ready", 422);
        const excluded = await decide("excluded");
        await request(mergeBase, netRoute + "/generate", { revision: excluded.revision }, 422);
      } else {
        assert.equal(merged.excludedReason, undefined);
        const ready = await decide("ready");
        const entry = await request(mergeBase, netRoute + "/generate", { revision: ready.revision });
        const parsed = parseLedgerText(mergeDefinitions + entry.entries, python);
        assert.deepEqual(parsed.errors, []);
        assert.deepEqual(parsed.transactions[0].postings, merged.postings);
      }
    }
    passed("same-account zero-net groups can be confirmed without posting, while different funding accounts keep their postings");
  }
  {
    const recheckRoot = path.join(temporary, "recheck-ledger");
    fs.mkdirSync(recheckRoot);
    const main = path.join(recheckRoot, "main.bean");
    fs.writeFileSync(main, definitions);
    const recheckBase = await boot({ ...config, ledgerRoot: recheckRoot }, path.join(temporary, "recheck-data"));
    const sample = await upload(recheckBase, csv("rounding-recheck").replace("12.34", "318.13"));
    const sampleRoute = `/api/batch/${sample.batchId}`;
    const approved = await request(recheckBase, sampleRoute + "/decide", { revision: sample.revision, decisions: [
      { id: sample.txs[0].id, account: "Expenses:Food:Meals:Dine", status: "ready", reviewNote: "已审批", tags: ["reviewed"] },
    ] });
    await request(recheckBase, sampleRoute + "/generate", { revision: approved.revision });
    fs.appendFileSync(main, [
      '2026-01-02 * "Property"', "  Expenses:Food:Meals:Dine  100.13 CNY", "  Assets:CN:BOC:2222  109.0 CNY",
      "  Assets:CN:BOC:2222  109.0 CNY", "  Assets:CN:BOC:1111", "",
    ].join("\n"));
    await request(recheckBase, sampleRoute + "/recheck-ledger", { revision: sample.revision }, 409);
    const [, edited] = await Promise.all([
      request(recheckBase, sampleRoute + "/recheck-ledger", { revision: approved.revision }, 409),
      new Promise<void>((resolve) => setImmediate(resolve)).then(() => request(recheckBase, sampleRoute + "/decide", {
        revision: approved.revision, decisions: [{ id: sample.txs[0].id, flag: "!" }],
      })),
    ]);
    const refreshed = await request(recheckBase, sampleRoute + "/recheck-ledger", { revision: edited.revision });
    assert.equal(refreshed.suspected, 1);
    assert.equal(refreshed.batch.revision, edited.revision + 1);
    const tx = refreshed.batch.txs[0];
    assert.equal(tx.status, "ready");
    assert.equal(tx.flag, "!");
    assert.deepEqual(tx.tags, ["reviewed"]);
    assert.equal(tx.reviewNote, "已审批");
    assert.ok(tx.issues.includes("疑似重复入账"));
    assert.match(tx.matches[0].reason, /明细合计 318\.13 CNY/);
    await request(recheckBase, sampleRoute + "/commit", { revision: refreshed.batch.revision }, 409);
    const repeated = await request(recheckBase, sampleRoute + "/recheck-ledger", { revision: refreshed.batch.revision });
    assert.equal(repeated.batch.revision, refreshed.batch.revision);
    fs.writeFileSync(main, definitions);
    const removed = await request(recheckBase, sampleRoute + "/recheck-ledger", { revision: repeated.batch.revision });
    assert.equal(removed.suspected, 0);
    assert.equal(removed.batch.txs[0].status, "ready");
    assert.ok(!removed.batch.txs[0].issues.includes("疑似重复入账"));
    passed("rechecking the current ledger refreshes duplicate hints without changing approval decisions");
  }
  {
    const exclusionData = path.join(temporary, "exclude-suspected-data");
    const exclusionBase = await boot({ ...config, pythonPath: path.join(temporary, "missing-python.exe") }, exclusionData);
    const store = new BatchStore(path.join(exclusionData, "batches"));
    const fixture = batch.txs[0];
    const suspects = Array.from({ length: 5001 }, (_, index): ParsedTx => ({
      ...fixture, id: `suspect-${index}`, status: index % 2 ? "pending" : "ready",
      issues: [index % 2 ? "不同来源的流水可能是同一笔" : "疑似重复入账"], reviewNote: "已核对备注",
    }));
    const other: ParsedTx[] = [
      { ...fixture, id: "regular", status: "ready", issues: [] },
      { ...fixture, id: "confirmed", status: "duplicate", issues: ["疑似重复入账"], duplicateOf: { id: "existing", where: "ledger", label: "已确认重复" } },
      { ...fixture, id: "already-excluded", status: "excluded", issues: ["疑似重复入账"] },
    ];
    const txs = [...suspects, ...other];
    const saved = store.create({ file: "batch.csv", source: "alipay", txs, txCount: txs.length, errors: [], accountsDetected: [], ledgerProfile: profileId(root, "main.bean") });
    store.save({ ...saved, preview: { revision: saved.revision, result: { entries: "", monthFiles: {}, generated: [], opens: [] }, opens: [] } });
    const action = `/api/batch/${saved.batchId}/exclude-suspected`;
    await request(exclusionBase, action, { revision: saved.revision + 1 }, 409);
    const excluded = await request(exclusionBase, action, { revision: saved.revision, reviewSessionId });
    assert.equal(excluded.excluded, suspects.length);
    assert.deepEqual(excluded.batch.reviewUndo, { sessionId: reviewSessionId, depth: 1, action: "deduplicate", count: suspects.length });
    assert.equal(excluded.batch.revision, saved.revision + 1);
    assert.ok(excluded.batch.txs.slice(0, suspects.length).every((tx: ParsedTx) => tx.status === "excluded" && tx.reviewNote === "已核对备注"));
    assert.deepEqual(excluded.batch.txs.slice(suspects.length), other);
    const updated = store.get(saved.batchId)!;
    assert.equal(updated.preview, undefined);
    const repeated = await request(exclusionBase, action, { revision: updated.revision, reviewSessionId });
    assert.equal(repeated.excluded, 0);
    assert.equal(repeated.batch.revision, updated.revision);
    assert.deepEqual(repeated.batch.reviewUndo, excluded.batch.reviewUndo);
    const undo = `/api/batch/${saved.batchId}/undo-review-status`;
    const restored = await request(exclusionBase, undo, { revision: repeated.batch.revision, reviewSessionId });
    assert.deepEqual(restored.restoredIds, suspects.map(({ id }) => id));
    assert.equal(restored.batch.revision, saved.revision + 2);
    assert.equal(restored.batch.reviewUndo, undefined);
    assert.deepEqual(restored.batch.txs, JSON.parse(JSON.stringify(txs)));
    const excludedAgain = await request(exclusionBase, action, { revision: restored.batch.revision, reviewSessionId });
    store.save({ ...store.get(saved.batchId)!, committed: true });
    assert.equal((await request(exclusionBase, `/api/batch/${saved.batchId}`)).reviewUndo, undefined);
    await request(exclusionBase, action, { revision: excludedAgain.batch.revision }, 409);
    await request(exclusionBase, undo, { revision: excludedAgain.batch.revision, reviewSessionId }, 409);
    passed("batch exclusion saves and undoes all eligible suspects atomically while preserving other rows");
  }
  {
    const mappingRoot = path.join(temporary, "mapping-ledger");
    const mappingData = path.join(temporary, "mapping-data");
    const mappingActive = path.join(temporary, "mapping-active.json");
    fs.mkdirSync(mappingRoot);
    fs.writeFileSync(path.join(mappingRoot, "main.bean"), `${definitions}2027-01-01 open Assets:Future CNY\n`);
    const mappingBase = await boot({ ...config, ledgerRoot: mappingRoot }, mappingData, mappingActive);
    const header = csv().split("\n")[0];
    const input = [header,
      "2026-01-02 10:00:00,账户存取,银行,存入,不计收支,20,测试卡（9999）,交易成功,map-1",
      "2026-01-02 10:05:00,账户存取,银行,转出,不计收支,20,中国银行储蓄卡(2222),交易成功,map-2",
      "2026-01-02 10:10:00,餐饮美食,测试餐厅,午餐,支出,10,测试卡(9999),交易成功,map-3",
      "2026-01-02 10:20:00,餐饮美食,测试餐厅,午餐,支出,12,自定义钱包,交易成功,map-4",
      "2026-01-02 11:00:00,日用百货,测试商店,取消,支出,5,另一个钱包,交易关闭,map-5",
      "2026-01-02 11:10:00,餐饮美食,测试餐厅,午餐,支出,5,零钱&红包,交易成功,map-6",
      "2026-01-02 11:20:00,亲友代付,测试餐厅,亲情卡,支出,5,对方账户,交易成功,map-7",
      "2026-01-02 11:30:00,餐饮美食,测试餐厅,午餐,支出,5,/,交易成功,map-8",
    ].join("\n");
    const unmapped = await upload(mappingBase, input);
    const earlier = await upload(mappingBase, input.replaceAll("map-", "earlier-"));
    const route = `/api/batch/${unmapped.batchId}`, revision = unmapped.revision;
    const fundingLock = path.join(mappingData, "locks", "batches", `${unmapped.batchId}.json`);
    fs.mkdirSync(path.dirname(fundingLock), { recursive: true });
    fs.writeFileSync(fundingLock, JSON.stringify({ pid: process.pid }));
    const { groups } = await request(mappingBase, `${route}/funding`, { revision });
    assert.deepEqual(groups.map(({ label, count }: { label: string; count: number }) => [label, count]), [["测试卡（9999）", 2], ["自定义钱包", 1], ["零钱", 1]]);
    assert.deepEqual(groups[0].accounts, ["Assets:CN:BOC:1111", "Assets:CN:BOC:2222"]);
    const mappings = [
      { id: groups[0].id, account: "Assets:CN:BOC:1111" },
      { id: groups[1].id, account: "Assets:CN:BOC:2222" },
      { id: groups[2].id, account: "Assets:CN:BOC:2222" },
    ];
    await request(mappingBase, `${route}/funding`, { revision, mappings }, 409);
    fs.unlinkSync(fundingLock);
    await request(mappingBase, `${route}/funding`, { revision: revision - 1, mappings }, 409);
    await request(mappingBase, `${route}/funding`, { revision, mappings: [{ ...mappings[0], account: "Assets:Future" }] }, 400);
    const incomplete = await request(mappingBase, `${route}/funding`, { revision, mappings: mappings.slice(0, 1) });
    assert.equal(incomplete.groups.length, 3);
    assert.equal((await request(mappingBase, route)).revision, revision);
    assert.equal(fs.existsSync(path.join(mappingRoot, ".beancount-importer.json")), false);
    const mapped = await request(mappingBase, `${route}/funding`, { revision, mappings });
    assert.deepEqual(mapped.groups, []);
    assert.equal(mapped.batch.revision, revision + 1);
    assert.equal(mapped.batch.txs[0].fundingAccount, mappings[0].account);
    assert.equal(mapped.batch.txs[2].fundingAccount, mappings[0].account);
    assert.equal(mapped.batch.txs[3].fundingAccount, mappings[1].account);
    assert.ok(mapped.batch.txs[0].matches.some((match: { reason: string }) => match.reason === "转账配对建议"));
    assert.deepEqual(mapped.batch.txs.slice(4).map((tx: { fundingAccount: string }) => tx.fundingAccount), ["", mappings[2].account, "", ""]);

    const restarted = await boot(undefined, mappingData, mappingActive);
    const resumed = await request(restarted, `/api/batch/${earlier.batchId}/funding`, { revision: earlier.revision });
    assert.deepEqual(resumed.groups, []);
    assert.equal(resumed.batch.txs[0].fundingAccount, mappings[0].account);
    const next = await upload(restarted, input.replaceAll("map-", "next-").replaceAll("测试卡（9999）", "测试卡(9999)"));
    assert.equal(next.txs[0].fundingAccount, mappings[0].account);
    assert.deepEqual((await request(restarted, `/api/batch/${next.batchId}/funding`, { revision: next.revision })).groups, []);
    const similar = await upload(restarted, [header, "2026-01-03 10:10:00,餐饮美食,测试餐厅,午餐,支出,10,副测试卡(9999),交易成功,map-similar"].join("\n"));
    assert.equal(similar.txs[0].fundingAccount, "");
    assert.equal((await request(restarted, `/api/batch/${similar.batchId}/funding`, { revision: similar.revision })).groups[0].label, "副测试卡(9999)");
    const bank = await upload(restarted, "交易日期,交易金额,交易对方,摘要\n2026-01-04,-10,银行商户,测试", "boc.csv");
    const bankRoute = `/api/batch/${bank.batchId}/funding`;
    const bankGroup = (await request(restarted, bankRoute, { revision: bank.revision })).groups[0];
    assert.equal(bankGroup.label, "boc.csv");
    assert.equal(bankGroup.statementOnly, true);
    const bankMapped = await request(restarted, bankRoute, { revision: bank.revision, mappings: [{ id: bankGroup.id, account: mappings[0].account }] });
    assert.equal(bankMapped.batch.txs[0].fundingAccount, mappings[0].account);
    assert.deepEqual(bankMapped.config.assetMapping, mapped.config.assetMapping);
    passed("funding preflight groups unresolved methods, applies choices and reuses persisted exact mappings");
  }
  {
    const splitRoot = path.join(temporary, "split-funding-ledger"), splitData = path.join(temporary, "split-funding-data");
    const card = "Liabilities:CreditCard:Fixture", method = "联名信用卡(9999)";
    fs.mkdirSync(splitRoot);
    fs.writeFileSync(path.join(splitRoot, "main.bean"), `${definitions}2025-01-01 open ${card} CNY\n`);
    const splitConfig: AppConfig = { ...config, ledgerRoot: splitRoot, assetMapping: [
      ...config.assetMapping, { keyword: method, source: "alipay", exact: true, account: card, kind: "credit" },
    ] };
    const splitBase = await boot(splitConfig, splitData);
    const imported = await upload(splitBase, [csv().split("\n")[0],
      `2026-01-02 10:10:00,餐饮美食,测试餐厅,午餐,支出,10,${method}&红包,交易成功,split-1`,
      `2026-01-03 10:10:00,餐饮美食,测试餐厅,午餐,支出,10,积分＋${method},交易成功,split-2`,
    ].join("\n"));
    assert.ok(imported.txs.every((tx) => tx.status === "pending" && tx.fundingAccount === card && tx.fundingConfidence! < 1
      && tx.fundingParts?.length === 2 && tx.issues?.includes("组合支付，分摊待确认")));

    const store = new BatchStore(path.join(splitData, "batches"));
    const older: ParsedTx = { ...imported.txs[1], id: "older-split", sourceTxId: "older-split", fundingAccount: "", fundingConfidence: 0,
      fundingParts: undefined, issues: ["组合支付"], status: "ready", reviewNote: "之前的审批备注" };
    const manual: ParsedTx = { ...imported.txs[0], id: "manual-split", sourceTxId: "manual-split", fundingAccount: "Assets:CN:BOC:2222", fundingConfidence: 1 };
    const saved = store.create({ file: "older-splits.csv", source: "alipay", txs: [older, manual], txCount: 2, errors: [],
      accountsDetected: [], ledgerProfile: profileId(splitRoot, "main.bean") });
    store.save({ ...saved, revision: 3 });
    const route = `/api/batch/${saved.batchId}`;
    const resumed = await request(splitBase, `${route}/funding`, { revision: 3 });
    assert.deepEqual(resumed.groups, []);
    assert.equal(resumed.batch.revision, 4);
    assert.equal(resumed.batch.txs[0].fundingAccount, card);
    assert.equal(resumed.batch.txs[0].reviewNote, older.reviewNote);
    assert.equal(resumed.batch.txs[0].status, "ready");
    assert.deepEqual(resumed.batch.txs[0].issues, ["组合支付，分摊待确认"]);
    assert.deepEqual(resumed.batch.txs[1], manual);
    assert.deepEqual(resumed.config.assetMapping, splitConfig.assetMapping);
    assert.deepEqual(await request(splitBase, `${route}/funding`, { revision: 4 }), { groups: [] });
    const preview = await request(splitBase, `${route}/generate`, { revision: 4 }, 422);
    assert.equal(preview.code, "review_incomplete");
    assert.equal(preview.error, "请将待确认内容处理完毕后，再点击「生成预览」。");
    assert.ok(preview.errors.some((error: string) => error.includes("请拆分组合支付")));
    assert.ok(preview.reviewProblems.some((problem: { id: string; field: string; message: string }) =>
      problem.id === older.id && problem.field === "postings" && problem.message === "请拆分组合支付"));
    passed("combined payment defaults work on import and resume while preserving review and split validation");

    const newMethod = "联名信用卡(9290)";
    const splitInput = [csv().split("\n")[0],
      "2026-01-05 10:10:00,餐饮美食,测试餐厅,午餐,支出,10," + newMethod + "&银行立减,交易成功,new-split-1",
      "2026-01-05 10:20:00,餐饮美食,测试餐厅,午餐,支出,12,集分宝＋" + newMethod + ",交易成功,new-split-2",
      "2026-01-05 10:30:00,餐饮美食,测试餐厅,午餐,支出,8," + newMethod + ",交易成功,new-split-3",
      "2026-01-05 10:40:00,餐饮美食,测试餐厅,午餐,支出,5,红包＋积分,交易成功,new-split-4",
    ].join("\n");
    const needsMapping = await upload(splitBase, splitInput);
    const splitRoute = "/api/batch/" + needsMapping.batchId + "/funding";
    const { groups } = await request(splitBase, splitRoute, { revision: needsMapping.revision });
    assert.deepEqual(groups.map(({ label, count }: { label: string; count: number }) => [label, count]), [[newMethod, 3]]);
    const mapped = await request(splitBase, splitRoute, { revision: needsMapping.revision, mappings: [{ id: groups[0].id, account: card }] });
    assert.deepEqual(mapped.groups, []);
    assert.equal(mapped.batch.txs.length, needsMapping.txs.length);
    assert.ok(mapped.batch.txs.slice(0, 2).every((tx: ParsedTx, index: number) => tx.fundingAccount === card && tx.status === "pending"
      && tx.sourceTxId === needsMapping.txs[index].sourceTxId && tx.amount === needsMapping.txs[index].amount && !tx.postings));
    assert.deepEqual(mapped.batch.txs[0].fundingParts, needsMapping.txs[0].fundingParts);
    assert.equal(mapped.batch.txs[2].fundingAccount, card);
    assert.equal(mapped.batch.txs[3].fundingAccount, "");
    assert.deepEqual(mapped.config.assetMapping.at(-1), { keyword: newMethod, source: "alipay", exact: true, account: card, kind: "credit" });
    const again = await upload(splitBase, splitInput.replaceAll("new-split-", "repeat-split-"));
    assert.equal(again.txs[0].fundingAccount, card);
    assert.deepEqual(await request(splitBase, "/api/batch/" + again.batchId + "/funding", { revision: again.revision }), { groups: [] });
    passed("import mapping asks once per unknown payment method across ordinary and combined orders and ignores discounts");
  }
  {
    const quickRoot = path.join(temporary, "quick-funding-mapping");
    const quickData = path.join(temporary, "quick-funding-data");
    fs.mkdirSync(quickRoot);
    fs.writeFileSync(path.join(quickRoot, "main.bean"), definitions + "2025-01-01 open Assets:Wallet:USD USD\n");
    const quickConfig = { ...config, ledgerRoot: quickRoot };
    const quickBase = await boot(quickConfig, quickData);
    const store = new BatchStore(path.join(quickData, "batches"));
    const source = batch.txs[0];
    const raw = "中国银行储蓄卡(1111)";
    const beforeAccount = "Assets:CN:BOC:1111", mappedAccount = "Assets:CN:BOC:2222";
    const category = "Expenses:Food:Meals:Dine";
    const first: ParsedTx = { ...source, id: "quick-primary", sourceTxId: "quick-primary", rawAccount: raw,
      finalAccount: category, status: "pending", fundingAccount: beforeAccount, fundingConfidence: 0.98,
      reviewNote: "已核对账号", postings: [
        { account: beforeAccount, amount: -12.34, currency: "CNY" }, { account: category, amount: 12.34, currency: "CNY" },
      ] };
    const others: ParsedTx[] = [
      { ...first, id: "quick-matching", sourceTxId: "quick-matching", rawAccount: " 中国银行储蓄卡（1111） ", postings: undefined, status: "ready", fundingConfidence: 0.9 },
      { ...first, id: "quick-reviewed", sourceTxId: "quick-reviewed", postings: undefined, fundingConfidence: 1 },
      { ...first, id: "quick-other-source", sourceTxId: "quick-other-source", postings: undefined, source: "wechat" },
      { ...first, id: "quick-other-label", sourceTxId: "quick-other-label", postings: undefined, rawAccount: "中国银行储蓄卡(2222)" },
      { ...first, id: "quick-other-currency", sourceTxId: "quick-other-currency", postings: undefined, currency: "USD" },
      { ...first, id: "quick-no-label", sourceTxId: "quick-no-label", postings: undefined, rawAccount: "", fundingConfidence: 0 },
    ];
    const txs = [first, ...others];
    const seeded = store.create({ file: "quick-mapping.csv", source: "alipay", txCount: txs.length, txs, errors: [],
      accountsDetected: [], ledgerProfile: profileId(quickRoot, "main.bean") });
    const original = store.get(seeded.batchId)!;
    const route = `/api/batch/${seeded.batchId}/funding-mapping`;
    const payload = { revision: seeded.revision, id: first.id, account: mappedAccount };
    await request(quickBase, route, { ...payload, revision: seeded.revision + 1 }, 409);
    await request(quickBase, route, { ...payload, id: "quick-no-label" }, 422);
    await request(quickBase, route, { ...payload, account: "Assets:Wallet:USD" }, 422);
    assert.equal(store.get(seeded.batchId)?.revision, seeded.revision);
    const mapped = await request(quickBase, route, payload);
    const next = mapped.batch.txs as ParsedTx[];
    assert.equal(mapped.updated, 2);
    assert.deepEqual(next.map(({ fundingAccount }) => fundingAccount), [mappedAccount, mappedAccount, ...others.slice(1).map(() => beforeAccount)]);
    assert.deepEqual(next.map(({ status }) => status), txs.map(({ status }) => status));
    assert.deepEqual(next[0].postings, [{ ...first.postings![0], account: mappedAccount }, first.postings![1]]);
    assert.equal(next[0].reviewNote, first.reviewNote);
    assert.ok(next.slice(0, 2).every(({ fundingConfidence, fundingReason }) => fundingConfidence === 1 && fundingReason === undefined));
    assert.deepEqual(next.slice(2), original.txs.slice(2));
    const settings = JSON.parse(fs.readFileSync(path.join(quickRoot, ".beancount-importer.json"), "utf8"));
    const rule = { keyword: raw, source: "alipay", account: mappedAccount, exact: true, kind: "debit" };
    assert.deepEqual(settings.assetMapping.find((item: typeof rule) => item.exact && item.source === "alipay"), rule);
    const restarted = await boot({ ...quickConfig, ...settings }, quickData);
    const imported = await upload(restarted, csv("quick-mapping-later"));
    assert.equal(imported.txs[0].fundingAccount, mappedAccount);
    assert.equal(imported.txs[0].fundingConfidence, 1);
    passed("saving a row's exact funding mapping updates compatible unconfirmed rows, preserves reviewed accounts and applies after restart");
  }
  {
    const rewardRoot = path.join(temporary, "reward-ledger");
    const rewardData = path.join(temporary, "reward-data");
    const wallet = "Assets:Wallet:Reward";
    fs.mkdirSync(rewardRoot);
    fs.writeFileSync(path.join(rewardRoot, "main.bean"), `${definitions}2025-01-01 open ${wallet} CNY\n`);
    const rewardConfig: AppConfig = { ...config, ledgerRoot: rewardRoot, assetMapping: [
      ...config.assetMapping,
      { keyword: "零钱", source: "wechat", exact: true, account: wallet, kind: "debit" },
    ] };
    const rewardBase = await boot(rewardConfig, rewardData);
    const input = ["交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号",
      "2026-08-29 23:45:16,其他,活动奖励_01_测试,/,收入,0.38,/,已到账,activity-reward",
      "2026-08-29 23:46:16,其他,普通收款,/,收入,0.38,/,已到账,ordinary-income",
      "2026-08-29 23:47:16,其他,活动奖励_01_测试,/,收入,0.38,中国银行储蓄卡(1111),已到账,explicit-payment",
    ].join("\n");
    const imported = await upload(rewardBase, input, "wechat.csv");
    const [reward, other, explicit] = imported.txs;
    assert.deepEqual(reward.recognition, { label: "活动奖励", fundingMethod: "零钱" });
    assert.equal(reward.rawAccount, "/");
    assert.equal(reward.fundingAccount, wallet);
    assert.equal(reward.status, "pending");
    assert.ok(!reward.issues?.includes("支付方式缺失"));
    assert.equal(other.fundingAccount, "");
    assert.ok(other.issues?.includes("支付方式缺失"));
    assert.equal(explicit.fundingAccount, "Assets:CN:BOC:1111");
    assert.equal(explicit.recognition, undefined);
    assert.deepEqual(imported.accountsDetected.find(({ raw }) => raw === "零钱"), { raw: "零钱", guess: wallet, txCount: 1 });

    const store = new BatchStore(path.join(rewardData, "batches"));
    const oldReward: ParsedTx = { ...reward, recognition: undefined, fundingAccount: "", fundingConfidence: 0,
      issues: ["支付方式缺失"], tags: ["checked"], reviewNote: "原有审批备注" };
    delete oldReward.fundingReason;
    const reviewed = { ...oldReward, id: "manual-reward", fundingAccount: explicit.fundingAccount, status: "ready" as const };
    const txs = [oldReward, other, reviewed];
    const legacy = store.create({ file: "old-wechat.xlsx", source: "wechat", txs, txCount: txs.length, errors: [],
      accountsDetected: [], ledgerProfile: profileId(rewardRoot, "main.bean") });
    legacy.revision = 4;
    store.save(legacy);
    const legacyRoute = `/api/batch/${legacy.batchId}`;
    const resumed = await request(rewardBase, `${legacyRoute}/funding`, { revision: legacy.revision });
    assert.deepEqual(resumed.groups, []);
    assert.equal(resumed.batch.revision, legacy.revision + 1);
    assert.deepEqual(resumed.batch.txs[0], { ...oldReward, fundingAccount: wallet, fundingConfidence: 1, recognition: reward.recognition, issues: [] });
    assert.deepEqual(resumed.batch.txs.slice(1), JSON.parse(JSON.stringify([other, reviewed])));
    assert.equal((await request(rewardBase, legacyRoute)).txs[0].fundingAccount, wallet);
    assert.deepEqual(await request(rewardBase, `${legacyRoute}/funding`, { revision: resumed.batch.revision }), { groups: [] });

    const unmappedBase = await boot({ ...rewardConfig, assetMapping: config.assetMapping }, path.join(temporary, "unmapped-reward-data"));
    const unmapped = await upload(unmappedBase, input, "wechat.csv");
    assert.equal(unmapped.txs[0].fundingAccount, "");
    const funding = `/api/batch/${unmapped.batchId}/funding`;
    const preflight = await request(unmappedBase, funding, { revision: unmapped.revision });
    assert.deepEqual(preflight.groups.map(({ label, count }: { label: string; count: number }) => [label, count]), [["零钱", 1]]);
    const mapped = await request(unmappedBase, funding, { revision: unmapped.revision, mappings: [{ id: preflight.groups[0].id, account: wallet }] });
    assert.equal(mapped.batch.txs[0].fundingAccount, wallet);
    assert.deepEqual(mapped.batch.txs[0].recognition, reward.recognition);
    assert.equal(mapped.batch.txs[0].rawAccount, "/");
    assert.equal(mapped.batch.txs[1].fundingAccount, "");
    passed("WeChat reward recognition reuses wallet mappings for new and saved batches or asks for the missing mapping");
  }
  {
    const receiptRoot = path.join(temporary, "wechat-receipt-ledger");
    const receiptData = path.join(temporary, "wechat-receipt-data");
    const wallet = "Assets:Wallet:WeChat";
    fs.mkdirSync(receiptRoot);
    fs.writeFileSync(path.join(receiptRoot, "main.bean"), `${definitions}${[
      `2025-01-01 open ${wallet} CNY`,
      "2025-01-01 open Income:Tuition CNY",
      '2026-09-06 * "补课费" "六节课"',
      `  ${wallet} 3600 CNY`,
      "  Income:Tuition -3600 CNY",
    ].join("\n")}\n`);
    const receiptBase = await boot({ ...config, ledgerRoot: receiptRoot, assetMapping: [
      ...config.assetMapping,
      { keyword: "零钱", source: "wechat", exact: true, account: wallet, kind: "debit" },
    ] }, receiptData);
    const input = ["交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号",
      "2026-09-06 16:06:43,转账,测试收款方,微信转账,收入,3600,/,已存入零钱,wallet-receipt",
      "2026-09-06 16:07:00,转账,另一交易方,微信转账,收入,3600,/,已收钱,unknown-destination",
      "2026-09-06 16:08:00,转账,另一交易方,微信转账,支出,3600,/,已存入零钱,outgoing",
      "2026-09-06 16:09:00,转账,另一交易方,微信转账,收入,3600,中国银行储蓄卡(1111),已存入零钱,explicit-account",
    ].join("\n");
    const imported = await upload(receiptBase, input, "wechat.csv");
    const [receipt, unknown, outgoing, explicit] = imported.txs;
    const assertSuspected = (row: ParsedTx) => {
      assert.equal(row.rawAccount, "/");
      assert.equal(row.fundingAccount, wallet);
      assert.equal(row.status, "pending");
      assert.ok(row.issues?.includes("疑似重复入账"));
      assert.ok(!row.issues?.includes("支付方式缺失"));
      assert.equal(row.matches?.[0]?.payee, "补课费");
      assert.equal(row.matches?.[0]?.reason, "日期、金额相同，商户不同");
    };
    assertSuspected(receipt);
    assert.deepEqual([unknown, outgoing, explicit].map((tx) => tx.fundingAccount), ["", "", "Assets:CN:BOC:1111"]);
    assert.ok([unknown, outgoing, explicit].every((tx) => tx.recognition === undefined && !tx.issues?.includes("疑似重复入账")));

    const store = new BatchStore(path.join(receiptData, "batches"));
    const old: ParsedTx = { ...receipt, recognition: undefined, fundingAccount: "", fundingConfidence: 0,
      issues: ["转账", "支付方式缺失"], matches: undefined, reviewNote: "已保存的备注" };
    const legacy = store.create({ file: "old-wechat.xlsx", source: "wechat", txs: [old], txCount: 1, errors: [],
      accountsDetected: [], ledgerProfile: profileId(receiptRoot, "main.bean") });
    legacy.revision = 4;
    store.save(legacy);
    const resumed = await request(receiptBase, `/api/batch/${legacy.batchId}/funding`, { revision: legacy.revision });
    assert.deepEqual(resumed.groups, []);
    assertSuspected(resumed.batch.txs[0]);
    assert.equal(resumed.batch.txs[0].reviewNote, old.reviewNote);
    passed("WeChat wallet receipts expose existing ledger matches on import and resume");
  }
  {
    const alipayRoot = path.join(temporary, "alipay-refund-ledger"), alipayData = path.join(temporary, "alipay-refund-data");
    const purchaseOrder = "2026091223000000000001", refundOrder = purchaseOrder + "_987654321";
    const unmatchedOrder = "2026091223000000000002", partialOrder = "2026091223000000000003";
    const fundingAccount = "Assets:CN:BOC:1111", category = "Expenses:Food:Meals:Dine";
    fs.mkdirSync(alipayRoot);
    fs.writeFileSync(path.join(alipayRoot, "main.bean"), definitions);
    const alipayBase = await boot({ ...config, ledgerRoot: alipayRoot }, alipayData);
    const imported = await upload(alipayBase, [csv().split("\n")[0],
      "2026-09-12 21:50:17,日用百货,测试商家,早餐券,支出,20,中国银行储蓄卡(1111),交易关闭," + purchaseOrder,
      "2026-09-13 11:53:41,退款,测试商家,退款-早餐券,不计收支,20,中国银行储蓄卡(1111),退款成功," + refundOrder,
      "2026-09-12 21:50:18,日用百货,测试商家,取消订单,支出,20,中国银行储蓄卡(1111),交易关闭," + unmatchedOrder,
      "2026-09-12 21:50:19,日用百货,测试商家,部分退款,支出,20,中国银行储蓄卡(1111),交易关闭," + partialOrder,
      "2026-09-13 11:53:42,退款,测试商家,部分退款,不计收支,10,中国银行储蓄卡(1111),退款成功," + partialOrder + "_987654322",
    ].join("\n"));
    const [purchase, refund, unmatched, partial] = imported.txs;
    assert.equal(purchase.status, "pending");
    assert.equal(purchase.excludedReason, undefined);
    assert.equal(purchase.refundCounterpartId, refund.id);
    assert.equal(refund.refundCounterpartId, purchase.id);
    assert.equal(unmatched.status, "excluded");
    assert.equal(partial.status, "excluded");

    const store = new BatchStore(path.join(alipayData, "batches"));
    const older = store.create({
      file: imported.file, source: "alipay", txCount: 2, errors: [], accountsDetected: [], ledgerProfile: profileId(alipayRoot, "main.bean"),
      txs: [
        { ...purchase, status: "excluded", excludedReason: "交易未完成：交易关闭", fundingAccount: "", fundingConfidence: 0,
          issues: ["账户未映射"], refundCounterpartId: undefined, reviewNote: "已有备注" },
        { ...refund, refundCounterpartId: undefined },
      ],
    });
    const route = "/api/batch/" + older.batchId;
    assert.equal((await request(alipayBase, route)).txs[0].refundCounterpartId, refund.id);
    const reopened = await request(alipayBase, route + "/recheck-ledger", { revision: older.revision });
    assert.equal(reopened.batch.txs[0].status, "pending");
    assert.equal(reopened.batch.txs[0].reviewNote, "已有备注");
    assert.equal(reopened.batch.txs[0].fundingAccount, fundingAccount);
    const categorized = await request(alipayBase, route + "/decide", { revision: reopened.batch.revision,
      decisions: [{ id: purchase.id, account: category, status: "ready" }] });
    assert.equal(categorized.ready, 2);
    assert.equal(categorized.batch.txs[1].finalAccount, category);
    const preview = await request(alipayBase, route + "/generate", { revision: categorized.revision });
    const parsed = parseLedgerText(definitions + preview.entries, python);
    assert.deepEqual(parsed.errors, []);
    assert.deepEqual(parsed.transactions.map((tx) => [tx.date, tx.sourceTxId, tx.postings.find((row) => row.account === category)?.amount]),
      [["2026-09-12", purchaseOrder, 20], ["2026-09-13", refundOrder, -20]]);
    passed("a closed Alipay purchase and its exact full refund are restored on import and reload and post on their own dates");
  }
  {
    const refundRoot = path.join(temporary, "wechat-refund-ledger");
    const refundData = path.join(temporary, "wechat-refund-data");
    const card = "Liabilities:CreditCard:Citic-中信信用卡";
    const charging = "Expenses:Transport:Charge-充电";
    const parking = "Expenses:Transport:Parking-停车";
    const refundDefinitions = definitions + [card, charging, parking].map((account) => `2025-01-01 open ${account} CNY\n`).join("");
    fs.mkdirSync(refundRoot);
    fs.writeFileSync(path.join(refundRoot, "main.bean"), refundDefinitions);
    const refundBase = await boot({ ...config, ledgerRoot: refundRoot, assetMapping: [
      ...config.assetMapping,
      { keyword: "中信银行信用卡(1778)", account: card, source: "wechat", kind: "credit", exact: true },
    ] }, refundData);
    const imported = await upload(refundBase, ["交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号",
      "2026-10-02 17:06:42,充电商户-退款,充电商户,退预付,收入,79.35,中信银行信用卡(1778),已退款¥79.35,refund",
      "2026-09-13 14:36:31,商户消费,充电商户,充电预付,支出,100,中信银行信用卡(1778),已退款(¥79.35),purchase",
    ].join("\n"), "wechat.csv");
    const [refund, purchase] = imported.txs;
    assert.equal(refund.refundCounterpartId, purchase.id);
    assert.equal(purchase.refundCounterpartId, refund.id);
    assert.ok(imported.txs.every((tx) => tx.status === "pending"));
    const store = new BatchStore(path.join(refundData, "batches"));
    assert.ok(store.get(imported.batchId)!.txs.every((tx) => tx.refundCounterpartId === undefined));
    const route = `/api/batch/${imported.batchId}`;
    const resumed = await request(refundBase, route) as ImportPreview;
    assert.deepEqual(resumed.txs.map((tx) => tx.refundCounterpartId), [purchase.id, refund.id]);
    const saved = await request(refundBase, `${route}/decide`, { revision: imported.revision, decisions: [{ id: refund.id, reviewNote: "已核对" }] });
    assert.equal(saved.batch.txs[0].refundCounterpartId, purchase.id);
    assert.equal(saved.batch.txs[0].status, "pending");

    const refundFunding = "Assets:CN:BOC:2222";
    const categorized = await request(refundBase, `${route}/decide`, { revision: saved.revision,
      decisions: [{ id: refund.id, funding: refundFunding }, { id: purchase.id, account: charging, status: "ready" }] });
    assert.equal(categorized.ready, 2);
    assert.equal(categorized.batch.txs[0].finalAccount, charging);
    assert.equal(categorized.batch.txs[0].refundReviewMode, "follow-purchase");
    assert.equal(categorized.batch.txs[0].reviewNote, "已核对");
    const pairedMerge = await request(refundBase, route + "/merge", { revision: categorized.revision,
      ids: [purchase.id, refund.id], payee: "充电商户", narration: "" }, 422);
    assert.ok(pairedMerge.details.some((line: string) => line.includes("已配对的消费和退款")));
    const preview = await request(refundBase, `${route}/generate`, { revision: categorized.revision });
    assert.equal(preview.generated, 2);
    const parsed = parseLedgerText(refundDefinitions + preview.entries, python);
    assert.deepEqual(parsed.errors, []);
    assert.deepEqual(parsed.transactions.map(({ date, sourceTxId }) => [date, sourceTxId]), [["2026-09-13", "purchase"], ["2026-10-02", "refund"]]);
    assert.deepEqual(parsed.transactions.map((tx) => tx.postings.find((posting) => posting.account !== charging)), [
      { account: card, amount: -100, currency: "CNY" },
      { account: refundFunding, amount: 79.35, currency: "CNY" },
    ]);
    const charges = parsed.transactions.flatMap((tx) => tx.postings.filter((posting) => posting.account === charging).map((posting) => posting.amount));
    assert.deepEqual(charges, [100, -79.35]);
    assert.equal(Math.round(charges.reduce((sum, amount) => sum + amount, 0) * 100), 2065);

    const moved = await request(refundBase, `${route}/decide`, { revision: categorized.revision, decisions: [{ id: purchase.id, account: parking }] });
    assert.equal(moved.batch.txs[0].finalAccount, parking);
    assert.equal(store.get(imported.batchId)!.preview, undefined);
    const excluded = await request(refundBase, `${route}/decide`, { revision: moved.revision, decisions: [{ id: purchase.id, status: "excluded" }], changesOnly: true });
    assert.equal(excluded.ready, 0);
    assert.deepEqual(excluded.changes.txs.map((tx: ParsedTx) => [tx.id, tx.status]), [[refund.id, "pending"], [purchase.id, "excluded"]]);
    const manual = await request(refundBase, `${route}/decide`, { revision: excluded.revision,
      decisions: [{ id: purchase.id, account: parking }, { id: refund.id, account: charging }] });
    assert.equal(manual.batch.txs[0].finalAccount, charging);
    assert.equal(manual.batch.txs[0].status, "ready");
    assert.equal(manual.batch.txs[0].refundReviewMode, "manual");

    const legacyRows = [refund, { ...purchase, finalAccount: charging, status: "ready" as const }];
    const legacy = store.create({ file: imported.file, source: "wechat", txs: legacyRows, txCount: legacyRows.length,
      errors: [], accountsDetected: [], ledgerProfile: profileId(refundRoot, "main.bean") });
    const funded = await request(refundBase, `/api/batch/${legacy.batchId}/funding`, { revision: legacy.revision });
    assert.equal(funded.batch.txs[0].finalAccount, charging);
    assert.equal(funded.batch.txs[0].status, "ready");
    assert.deepEqual(await request(refundBase, `/api/batch/${legacy.batchId}/funding`, { revision: funded.batch.revision }), { groups: [] });
    passed("WeChat partial refunds net against the purchase category across funding accounts and respect manual review");
  }
  {
    const refundRoot = path.join(temporary, "pdf-refund-ledger");
    const refundData = path.join(temporary, "pdf-refund-data");
    const cmb = "Liabilities:CreditCard:CMB", citic = "Liabilities:CreditCard:CITIC";
    const category = "Expenses:Food:Meals:Dine", income = "Income:Adjustments";
    const refundDefinitions = definitions + [cmb, citic, income].map((account) => `2025-01-01 open ${account} CNY\n`).join("");
    fs.mkdirSync(refundRoot);
    fs.writeFileSync(path.join(refundRoot, "main.bean"), refundDefinitions);
    const refundBase = await boot({ ...config, ledgerRoot: refundRoot, assetMapping: [
      ...config.assetMapping,
      { keyword: "招商银行", cardSuffix: "4141", account: cmb, kind: "credit" },
      { keyword: "中信银行", cardSuffix: "6363", account: citic, kind: "credit" },
    ] }, refundData);
    const columns = [43, 94, 140, 380, 479, 545];
    const cmbRows = [
      ["招商银行信用卡对账单（2026年5月）"], ["账单日", "", "2026年5月7日"],
      ["交易日", "记账日", "交易摘要", "人民币金额", "卡号末四位", "原始金额"],
      ["退款"], ["04/15", "04/17", "招行测试商户", "-17.00", "4141", "-17.00"],
      ["消费"], ["04/15", "04/16", "招行测试商户", "17.00", "4141", "17.00"],
    ];
    const cmbPdf = await fixturePdf([cmbRows.map((row, index) => [760 - index * 14, row.map((value, col) => [columns[col], value])])]);
    const cmbBatch = await upload(refundBase, cmbPdf, "招行退款测试.pdf");
    assert.equal(cmbBatch.source, "bank-cmb");
    assert.deepEqual(cmbBatch.errors, []);
    const cmbOriginal = cmbBatch.txs.find((tx) => tx.eventType === "expense")!;
    const cmbReturn = cmbBatch.txs.find((tx) => tx.eventType === "refund")!;
    assert.equal(cmbOriginal.refundCounterpartId, cmbReturn.id);
    assert.equal(cmbReturn.refundCounterpartId, cmbOriginal.id);
    assert.equal(cmbOriginal.fundingAccount, cmb);

    const store = new BatchStore(path.join(refundData, "batches"));
    const older = store.get(cmbBatch.batchId)!;
    older.txs = older.txs.map(({ refundEvidence, refundCounterpartId, ...tx }) => tx.id === cmbOriginal.id
      ? { ...tx, status: "ready", finalAccount: category } : { ...tx, reviewNote: "保留旧备注" });
    store.save(older);
    const cmbRoute = `/api/batch/${older.batchId}`;
    const resumed = await request(refundBase, cmbRoute) as ImportPreview;
    assert.equal(resumed.txs.find((tx) => tx.id === cmbReturn.id)?.refundCounterpartId, cmbOriginal.id);
    const reloaded = await request(refundBase, cmbRoute + "/recheck-ledger", { revision: older.revision });
    assert.equal(reloaded.batch.parseStats.ready, 2);
    assert.equal(reloaded.batch.txs.find((tx: ParsedTx) => tx.id === cmbReturn.id)?.reviewNote, "保留旧备注");
    const cmbPreview = await request(refundBase, cmbRoute + "/generate", { revision: reloaded.batch.revision });
    assert.equal(cmbPreview.generated, 2);
    const cmbEntries = parseLedgerText(refundDefinitions + cmbPreview.entries, python);
    assert.deepEqual(cmbEntries.errors, []);
    assert.deepEqual(cmbEntries.transactions.map((entry) => entry.date), ["2026-04-15", "2026-04-15"]);
    assert.deepEqual(cmbEntries.transactions.map((entry) => entry.postings.find((posting) => posting.account === category)?.amount).sort((a, b) => a! - b!), [-17, 17]);
    assert.deepEqual(cmbEntries.transactions.map((entry) => Number(entry.metadata?.["source-row"])).sort((a, b) => a - b), [cmbReturn.row, cmbOriginal.row].sort((a, b) => a - b));

    const merchant = "测试餐厅";
    const citicLine = (y: number, booked: string, amount: string): PdfRow =>
      [y, [[8, "20260513"], [74, booked], [159, "6363"], [214, "支付宝－" + merchant], [370, amount], [482, amount]]];
    const citicPdf = await fixturePdf([[
      [780, [[43, "中信银行信用卡对账单"]]],
      [735, [[7, "交易日"], [78, "银行记账日"], [148, "卡号后四位"], [259, "交易描述"], [370, "交易货币/金额"], [482, "记账货币/金额"]]],
      citicLine(700, "20260514", "CNY 38.50"), citicLine(670, "20260515", "CNY -38.50"),
    ]]);
    const alipayRefund = [csv().split("\n")[0], `2026-05-13 12:20:00,退款,${merchant},餐券退款,收入,38.50,中信银行信用卡(6363),退款成功,202605130000123456_7890`].join("\n");
    const otherBatch = await upload(refundBase, alipayRefund, "支付宝独立退款.csv");
    const otherRoute = `/api/batch/${otherBatch.batchId}`;
    const otherApproved = await request(refundBase, otherRoute + "/decide", { revision: otherBatch.revision,
      decisions: [{ id: otherBatch.txs[0].id, account: category, status: "ready" }] });
    const otherPreview = await request(refundBase, otherRoute + "/generate", { revision: otherApproved.revision });
    assert.equal(otherPreview.generated, 1);

    const uploadResult = await postStatements(refundBase, [["中信退款测试.pdf", citicPdf], ["支付宝同一退款.csv", alipayRefund]]);
    const uploaded = await uploadResult.json();
    assert.equal(uploadResult.status, 200, JSON.stringify(uploaded));
    const route = `/api/batch/${uploaded.batchId}`;
    const mixed = await request(refundBase, route) as ImportPreview;
    assert.deepEqual(mixed.errors, []);
    const purchase = mixed.txs.find((tx) => tx.source === "bank-citic" && tx.eventType === "expense")!;
    const refund = mixed.txs.find((tx) => tx.source === "bank-citic" && tx.eventType === "refund")!;
    const copy = mixed.txs.find((tx) => tx.source === "alipay")!;
    assert.equal(purchase.fundingAccount, citic);
    assert.equal(purchase.refundCounterpartId, refund.id);
    assert.equal(refund.refundCounterpartId, purchase.id);
    assert.equal(copy.status, "duplicate");
    assert.equal(copy.duplicateOf?.id, refund.id);
    assert.equal(copy.duplicateOf?.refundCopy, "statement");
    await request(refundBase, route + "/decide", { revision: mixed.revision, decisions: [{ id: copy.id, account: category, status: "ready" }] }, 422);
    const approved = await request(refundBase, route + "/decide", { revision: mixed.revision, decisions: [{ id: purchase.id, account: income, status: "ready" }] });
    assert.equal(approved.ready, 2);
    assert.equal(approved.batch.txs.find((tx: ParsedTx) => tx.id === refund.id).finalAccount, income);
    const preview = await request(refundBase, route + "/generate", { revision: approved.revision });
    assert.equal(preview.generated, 2);
    await request(refundBase, route + "/commit", { revision: preview.revision });
    const stale = await request(refundBase, otherRoute + "/commit", { revision: otherPreview.revision }, 409);
    assert.match(stale.error, /重复退款/);
    const refreshed = await request(refundBase, otherRoute + "/recheck-ledger", { revision: otherApproved.revision });
    assert.equal(refreshed.batch.txs[0].duplicateOf?.refundCopy, "ledger");
    assert.equal(refreshed.batch.parseStats.ready, 0);
    const ledger = parseLedger(refundRoot, "main.bean", python);
    assert.deepEqual(ledger.errors, []);
    assert.equal(ledger.transactions.length, 2);
    assert.equal(ledger.transactions.filter((entry) => entry.metadata?.["import-event"] === "refund").length, 1);
    assert.deepEqual(ledger.transactions.map((entry) => entry.postings.find((posting) => posting.account === income)!.amount).sort((a, b) => a - b), [-38.5, 38.5]);
    passed("bank PDF refunds survive reload, follow the shared category, and post once across statements and batches");
  }
  {
    const walletData = path.join(temporary, "wallet-transfer-data");
    const walletBase = await boot(config, walletData);
    const input = ["交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号",
      "2026-08-29 12:00:00,转入零钱通-来自零钱,/,/,/,10,零钱,支付成功,to-investment",
      "2026-08-29 13:00:00,零钱通转出-到零钱,/,/,/,10,/,已到账,to-wallet",
      "2026-08-29 14:00:00,商户消费,测试商户,午餐,支出,5,中国银行储蓄卡(1111),支付成功,ordinary-purchase",
    ].join("\n");
    const imported = await upload(walletBase, input, "wechat.csv");
    const [forward, reverse, purchase] = imported.txs;
    assert.deepEqual(imported.txs.slice(0, 2).map((tx) => [tx.status, tx.excludedReason]), [
      ["excluded", "零钱与零钱通互转"], ["excluded", "零钱与零钱通互转"],
    ]);
    const importRoute = `/api/batch/${imported.batchId}`;
    assert.deepEqual(await request(walletBase, `${importRoute}/funding`, { revision: imported.revision }), { groups: [] });
    await request(walletBase, `${importRoute}/decide`, { revision: imported.revision, decisions: [{ id: forward.id, status: "ready" }] }, 422);

    const store = new BatchStore(path.join(walletData, "batches"));
    const oldSettings = { excludedReason: undefined, fundingAccount: "Assets:CN:BOC:1111", finalAccount: "Assets:CN:BOC:2222", reviewNote: "原有审批备注" };
    const legacyRows: ParsedTx[] = [
      { ...forward, ...oldSettings, status: "ready" },
      { ...reverse, ...oldSettings, status: "pending" },
      { ...purchase, status: "ready", finalAccount: "Expenses:Food:Meals:Dine" },
    ];
    const legacy = store.create({ file: "legacy-wechat.xlsx", source: "wechat", txs: legacyRows, txCount: legacyRows.length,
      errors: [], accountsDetected: [], ledgerProfile: profileId(root, "main.bean") });
    const legacyRoute = `/api/batch/${legacy.batchId}`;
    const stale = await request(walletBase, `${legacyRoute}/generate`, { revision: legacy.revision }, 422);
    assert.ok(stale.errors.some((message: string) => message.includes("零钱与零钱通互转")));
    const resumed = await request(walletBase, `${legacyRoute}/funding`, { revision: legacy.revision });
    assert.deepEqual(resumed.groups, []);
    assert.equal(resumed.batch.revision, legacy.revision + 1);
    assert.deepEqual(resumed.batch.txs.slice(0, 2).map((tx: ParsedTx) => [tx.status, tx.excludedReason, tx.reviewNote]), [
      ["excluded", "零钱与零钱通互转", "原有审批备注"], ["excluded", "零钱与零钱通互转", "原有审批备注"],
    ]);
    assert.deepEqual(resumed.batch.txs[2], legacyRows[2]);
    const preview = await request(walletBase, `${legacyRoute}/generate`, { revision: resumed.batch.revision });
    assert.equal(preview.generated, 1);
    assert.match(preview.entries, /ordinary-purchase/);
    assert.doesNotMatch(preview.entries, /to-investment|to-wallet/);

    store.save({ ...legacy, revision: resumed.batch.revision + 1, preview: {
      revision: resumed.batch.revision + 1, result: { entries: "", monthFiles: {}, generated: [forward.id], opens: [] }, opens: [],
    } });
    const staleCommit = await request(walletBase, `${legacyRoute}/commit`, { revision: resumed.batch.revision + 1 }, 422);
    assert.ok(staleCommit.details.some((message: string) => message.includes("零钱与零钱通互转")));
    const reloaded = await request(walletBase, `${legacyRoute}/recheck-ledger`, { revision: resumed.batch.revision + 1 });
    assert.deepEqual(reloaded.batch.txs.map((tx: ParsedTx) => tx.status), ["excluded", "excluded", "ready"]);
    assert.equal(store.get(legacy.batchId)!.preview, undefined);
    passed("WeChat internal wallet transfers are excluded during import and reload and blocked from stale previews");
  }
  const pendingReplay = await upload(base, csv());
  assert.equal(pendingReplay.txs[0].status, "pending");
  assert.ok(pendingReplay.txs[0].matches?.some((match) => match.reason.includes("未提交批次")));
  passed("repeat uploads also reference existing uncommitted import batches");
  const discarded = await upload(base, csv("discarded-source"));
  const secondCopy = await upload(base, csv("discarded-source"));
  const thirdCopy = await upload(base, csv("discarded-source"));
  const discardedRoute = `/api/batch/${discarded.batchId}`;
  const beforeDelete = fs.readFileSync(path.join(root, "main.bean"));
  const savedDiscard = await request(base, discardedRoute + "/decide", {
    revision: discarded.revision, decisions: [{ id: discarded.txs[0].id, reviewNote: "待删除的审阅" }],
  });
  await deleteBatch(base, discarded.batchId, discarded.revision, 409);
  const journalPath = path.join(dataDir, "commits", `${discarded.batchId}.json`);
  fs.mkdirSync(path.dirname(journalPath), { recursive: true });
  fs.writeFileSync(journalPath, JSON.stringify({ status: "writing" }));
  await deleteBatch(base, discarded.batchId, savedDiscard.revision, 409);
  fs.unlinkSync(journalPath);

  await deleteBatch(base, discarded.batchId, savedDiscard.revision);
  assert.deepEqual(fs.readFileSync(path.join(root, "main.bean")), beforeDelete);
  assert.equal(fs.existsSync(path.join(dataDir, "batches", `${discarded.batchId}.json`)), false);
  await request(base, discardedRoute, undefined, 404);
  await request(base, discardedRoute + "/generate", { revision: savedDiscard.revision }, 404);
  const remaining = await request(base, `/api/batch/${secondCopy.batchId}`) as ImportPreview;
  assert.ok(!remaining.txs[0].issues?.some((issue) => issue.includes("另一个未提交批次")));
  assert.ok(!remaining.txs[0].matches?.some((match) => match.id.startsWith("batch:")));
  const stillReferenced = await request(base, `/api/batch/${thirdCopy.batchId}`) as ImportPreview;
  assert.ok(stillReferenced.txs[0].issues?.some((issue) => issue.includes("另一个未提交批次")));
  assert.deepEqual(stillReferenced.txs[0].matches?.filter((match) => match.id.startsWith("batch:")).map((match) => match.id.split(":")[1]), [secondCopy.batchId]);
  assert.ok(!(await request(base, "/api/batches")).some((item: { batchId: string }) => item.batchId === discarded.batchId));
  passed("deleting a reviewed draft removes only that batch and clears its references, while revisions and journals guard deletion");
  {
    const directory = path.join(temporary, "batch-review-merge");
    const combinedBase = await boot(config, directory);
    const store = new BatchStore(path.join(directory, "batches"));
    const funding = "Assets:CN:BOC:1111", category = "Expenses:Food:Meals:Dine";
    const row = (id: string, file: string, changes: Partial<ParsedTx> = {}): ParsedTx => ({
      id, sourceTxId: id, source: "alipay", sourceFile: file, sourceFileHash: createHash("sha256").update(file).digest("hex"), row: 5,
      date: "2026-08-15", direction: "out", eventType: "expense", currency: "CNY", amount: 32,
      payee: id, note: "示例消费", rawAccount: "中国银行储蓄卡(1111)", rawCategory: "餐饮美食",
      fundingAccount: funding, fundingConfidence: 1, finalAccount: category, suggestedAccount: category, confidence: 0.9,
      status: "ready", ...changes,
    });
    const save = (file: string, txs: ParsedTx[]) => store.create({
      file, source: "alipay", txCount: txs.length, txs, errors: [], accountsDetected: [], ledgerProfile: profileId(root, config.mainFile),
    });
    const first = save("原始账单一.csv", [
      row("retain", "原始账单一.csv", { narration: "保留摘要", tags: ["keep"] }),
      row("conflict", "原始账单一.csv", { reviewNote: "沿用餐饮" }),
      row("group-one", "原始账单一.csv"), row("group-two", "原始账单一.csv"),
    ]);
    const firstRoute = "/api/batch/" + first.batchId;
    const grouped = await request(combinedBase, firstRoute + "/merge", {
      revision: first.revision, ids: ["group-one", "group-two"], payee: "保留的手动合并", narration: "两笔账目",
    });
    const second = save("原始账单二.csv, 另一份账单.xlsx", [
      row("conflict", "原始账单二.csv", { status: "excluded", reviewNote: "排除此笔" }),
      row("extra-file", "另一份账单.xlsx"),
    ]);
    const third = save("原始账单三.csv", [
      row("retain", "原始账单三.csv", { status: "excluded", narration: "旧摘要" }),
      row("conflict", "原始账单三.csv", { reviewNote: "不保留" }),
      row("reset", "原始账单三.csv", { fundingAccount: "Assets:CN:BOC:2222", narration: "清除摘要", reviewNote: "清除备注", tags: ["old"], flag: "!" }),
      row("closed", "原始账单三.csv", { status: "excluded", excludedReason: "交易关闭" }),
    ]);
    const selection = [
      { batchId: first.batchId, revision: grouped.batch.revision },
      { batchId: second.batchId, revision: second.revision },
      { batchId: third.batchId, revision: third.revision },
    ];
    const options = await request(combinedBase, "/api/batches/merge-options", { batches: selection });
    assert.deepEqual(options.sources.map(({ file, name }: { file: string; name: string }) => [file, name]), [
      ["原始账单一.csv", "原始账单一"], ["原始账单二.csv", "原始账单二"], ["另一份账单.xlsx", "另一份账单"], ["原始账单三.csv", "原始账单三"],
    ]);
    const mergeRequest = { batches: selection, keepProgress: [first.batchId, second.batchId], names: [{ id: options.sources[0].id, name: "中信" }] };
    await request(combinedBase, "/api/batches/merge", { ...mergeRequest, batches: [{ ...selection[0], revision: 1 }, ...selection.slice(1)] }, 409);
    assert.equal(store.get(first.batchId)?.mergedInto, undefined);
    const merged = await request(combinedBase, "/api/batches/merge", mergeRequest, 201);
    const result = merged.batch as ImportPreview & { batchId: string; revision: number };
    const find = (id: string) => result.txs.find(({ sourceTxId }) => sourceTxId === id)!;
    assert.equal(result.txs.filter(({ sourceTxId }) => sourceTxId === "retain").length, 1);
    assert.equal(find("retain").status, "ready");
    assert.equal(find("retain").narration, "保留摘要");
    assert.deepEqual(find("retain").tags, ["keep"]);
    assert.equal(find("retain").statementSourceIds?.length, 2);
    assert.equal(find("conflict").status, "pending");
    assert.equal(find("conflict").statementSourceIds?.length, 3);
    assert.equal(find("reset").status, "pending");
    assert.equal(find("reset").fundingAccount, funding);
    assert.equal(find("reset").flag, "*");
    assert.deepEqual(find("reset").tags, []);
    assert.equal(find("reset").narration, undefined);
    assert.equal(find("reset").reviewNote, undefined);
    assert.equal(find("closed").status, "excluded");
    const manual = result.txs.find(({ merge }) => merge)!;
    assert.equal(manual.payee, "保留的手动合并");
    assert.equal(manual.merge!.originals.length, 2);
    assert.ok(manual.merge!.originals.every(({ id }) => result.txs.some((tx) => tx.id === id)));
    assert.equal(result.statementSources![0].name, "中信");
    assert.equal(result.statementSources![0].file, "原始账单一.csv");
    assert.ok(merged.batches.filter((item: { mergedInto?: string }) => item.mergedInto === result.batchId).length === 3);
    assert.equal((await request(combinedBase, firstRoute)).mergedInto, result.batchId);
    await request(combinedBase, firstRoute + "/decide", { revision: grouped.batch.revision, decisions: [] }, 409);
    await request(combinedBase, firstRoute + "/generate", { revision: grouped.batch.revision }, 409);
    await deleteBatch(combinedBase, first.batchId, grouped.batch.revision, 409);
    const resultRoute = "/api/batch/" + result.batchId;
    const conflict = result.reviewConflicts![0];
    assert.deepEqual(conflict.choices.map(({ txs }) => txs[0].reviewNote), ["沿用餐饮", "排除此笔"]);
    await request(combinedBase, resultRoute + "/decide", {
      revision: result.revision, decisions: [{ id: find("conflict").id, account: category, status: "ready" }],
    }, 422);
    const resolved = await request(combinedBase, resultRoute + "/review-conflicts", {
      revision: result.revision, conflictId: conflict.id, sourceBatchId: second.batchId,
    });
    const chosen = (resolved.batch.txs as ParsedTx[]).find(({ sourceTxId }) => sourceTxId === "conflict")!;
    assert.equal(chosen.status, "excluded");
    assert.equal(chosen.reviewNote, "排除此笔");
    assert.equal(chosen.statementSourceIds?.length, 3);
    assert.equal(chosen.reviewConflictId, undefined);
    const renamed = await request(combinedBase, resultRoute + "/statement-names", {
      revision: resolved.batch.revision, names: [{ id: options.sources[0].id, name: "中信信用卡" }],
    });
    const restarted = await boot(config, directory);
    const restored = await request(restarted, resultRoute);
    assert.equal(restored.statementSources[0].name, "中信信用卡");
    assert.equal(restored.statementSources[0].file, "原始账单一.csv");
    assert.equal(restored.txs.find((tx: ParsedTx) => tx.sourceTxId === "conflict").sourceFile, "原始账单二.csv");
    await deleteBatch(restarted, result.batchId, renamed.batch.revision);
    await request(restarted, resultRoute, undefined, 404);
    assert.equal((await request(restarted, firstRoute)).mergedInto, result.batchId);
    await request(restarted, "/api/batches/merge-options", { batches: selection }, 409);
    passed("batch review merging keeps selected progress, resets others, preserves distinct statement sources and archives original batches permanently");

    const groupSource = save("原有合并组.csv", [row("overlap-one", "原有合并组.csv"), row("overlap-two", "原有合并组.csv")]);
    const singleSource = save("组内流水副本.csv", [row("overlap-one", "组内流水副本.csv", { status: "excluded" })]);
    const manualReview = await request(restarted, "/api/batch/" + groupSource.batchId + "/merge", {
      revision: groupSource.revision, ids: ["overlap-one", "overlap-two"], payee: "原合并组", narration: "预览检查",
    });
    const overlapping = await request(restarted, "/api/batches/merge", {
      batches: [{ batchId: groupSource.batchId, revision: manualReview.batch.revision }, singleSource],
      keepProgress: [groupSource.batchId, singleSource.batchId], names: [],
    }, 201);
    assert.equal(overlapping.batch.reviewConflicts[0].transactionIds.length, 2);
    assert.ok(overlapping.batch.txs.every((tx: ParsedTx) => !tx.merge && tx.reviewConflictId));
    const extra = save("附加账单.csv", [row("extra", "附加账单.csv", { status: "pending" })]);
    const combinedAgain = await request(restarted, "/api/batches/merge", {
      batches: [overlapping.batch, extra], keepProgress: [overlapping.batch.batchId], names: [],
    }, 201);
    const againRoute = "/api/batch/" + combinedAgain.batch.batchId;
    const carried = combinedAgain.batch.reviewConflicts[0];
    assert.equal(carried.transactionIds.length, 2);
    assert.ok(carried.choices.some((choice: { batchId: string }) => choice.batchId === groupSource.batchId));
    const chosenGroup = await request(restarted, againRoute + "/review-conflicts", {
      revision: combinedAgain.batch.revision, conflictId: carried.id, sourceBatchId: groupSource.batchId,
    });
    const activeGroup = chosenGroup.batch.txs.find((tx: ParsedTx) => tx.merge);
    assert.equal(activeGroup.merge.originals.length, 2);
    assert.ok(chosenGroup.batch.txs.every((tx: ParsedTx) => !tx.reviewConflictId));
    const reviewedGroup = await request(restarted, againRoute + "/decide", {
      revision: chosenGroup.batch.revision, decisions: [{ id: activeGroup.id, status: "ready" }],
    });
    const combinedPreview = await request(restarted, againRoute + "/generate", { revision: reviewedGroup.revision });
    assert.equal(combinedPreview.generated, 1);
    assert.match(combinedPreview.entries, /原合并组/);
    passed("overlapping transaction groups stay pending across another batch merge and can be restored without double posting");
  }
  const route = `/api/batch/${batch.batchId}`;
  await request(base, route + "/decide", { revision: 0, decisions: [] }, 409);
  const original = batch.txs[0];
  const narration = '昆明住宿两晚 "酒店"';
  const withNarration = await request(base, route + "/decide", { revision: batch.revision, decisions: [{ id: original.id, narration }] });
  assert.equal(withNarration.batch.txs[0].narration, narration);
  assert.equal(withNarration.batch.txs[0].note, original.note);
  assert.equal(withNarration.batch.txs[0].status, original.status);
  const resetNarration = await request(base, route + "/decide", { revision: withNarration.revision, decisions: [{ id: original.id, narration: null }] });
  assert.equal(resetNarration.batch.txs[0].narration, undefined);
  const saved = await request(base, route + "/decide", { revision: resetNarration.revision, decisions: [{ id: original.id, account: "Expenses:Food:Meals:Dine", funding: "Assets:CN:BOC:2222", status: "ready", tags: ["trip2026"], flag: "!", narration, reviewNote: '核实 "引号" \\\n下一行' }] });
  batch = await request(base, route); assert.equal(batch.revision, saved.revision); assert.equal(batch.txs[0].fundingAccount, "Assets:CN:BOC:2222"); assert.deepEqual(batch.txs[0].tags, ["trip2026"]);
  const preview = await request(base, route + "/generate", { revision: batch.revision });
  assert.match(preview.entries, /Assets:CN:BOC:2222\s+-12\.34 CNY/); assert.match(preview.entries, / ! .*#trip2026/);
  assert.ok(preview.entries.includes(JSON.stringify(narration)));
  assert.match(preview.entries, /review-note: /);
  assert.deepEqual(preview.targetFiles, ["years/2026/imported/2026-01.bean"]);
  passed("reviewed funding, tags, flag, narration and note reach server-generated entries");
  const edited = await request(base, route + "/decide", { revision: batch.revision, decisions: [{ id: batch.txs[0].id, tags: ["trip2026", "checked"] }] });
  await request(base, route + "/commit", { revision: batch.revision }, 409);
  await request(base, route + "/commit", { revision: edited.revision }, 409);
  assert.equal(fs.existsSync(path.join(root, "years")), false);
  await request(base, route + "/generate", { revision: edited.revision });
  const committed = await request(base, route + "/commit", { revision: edited.revision });
  assert.equal(committed.ok, true); assert.equal(committed.validation.newErrors.length, 0);
  await deleteBatch(base, batch.batchId, edited.revision, 409);
  const monthly = path.join(root, "years/2026/imported/2026-01.bean"), beforeRetry = fs.readFileSync(monthly, "utf8");
  const written = parseLedger(root, "main.bean", python).transactions;
  assert.equal(written.length, 1);
  assert.equal(written[0].narration, narration);
  const repeated = await request(base, route + "/commit", { revision: 0 }); assert.equal(repeated.alreadyCommitted, true); assert.equal(fs.readFileSync(monthly, "utf8"), beforeRetry);
  passed("stale previews cannot write; annual include, native validation and retry idempotency work");
  const importedAgain = await upload(base, csv()); assert.equal(importedAgain.txs[0].status, "duplicate"); assert.match(importedAgain.txs[0].duplicateOf?.label ?? "", /交易号/);
  passed("a new upload recognizes durable IDs already in the ledger");
  base = await boot(config, dataDir);
  const restored = await request(base, route); assert.equal(restored.committed, true); assert.deepEqual(restored.txs[0].tags, ["trip2026", "checked"]);
  assert.equal(restored.txs[0].narration, narration);
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
  const template = "years/{year}/{month}/{source}/{account}";
  assert.equal((await request(base, "/api/config", { monthlyDir: template })).monthlyDir, template);
  const routedPreview = await request(base, `/api/batch/${next.batchId}/generate`, { revision: corrected.revision });
  assert.deepEqual(routedPreview.targetFiles, ["years/2026/01/alipay/Assets_CN_BOC_2222/2026-01.bean"]);
  const routedCommit = await request(base, `/api/batch/${next.batchId}/commit`, { revision: corrected.revision });
  assert.deepEqual(routedCommit.written, routedPreview.targetFiles);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, ".beancount-importer.json"), "utf8")).monthlyDir, template);
  assert.equal(fs.existsSync(path.join(dataDir, "config.json")), false);
  assert.deepEqual(parseLedger(root, "main.bean", python).errors, []);
  passed("balanced coupon splits commit to the templated paths shown in preview; invalid splits do not");
  const otherRoot = path.join(temporary, "other-ledger"); fs.mkdirSync(otherRoot); fs.writeFileSync(path.join(otherRoot, "entry.bean"), definitions);
  const otherSettings = path.join(otherRoot, ".beancount-importer.json");
  fs.writeFileSync(otherSettings, JSON.stringify({
    mainFile: "entry.bean", monthlyDir: "other/{source}", annualLayout: false, pythonPath: python, assetMapping: [],
    llm: { provider: "off", apiKey: "fixture-secret", apiBase: "", model: "fixture-model" }, futurePreference: { enabled: true },
  }));
  const switched = await request(base, "/api/config", { ledgerRoot: otherRoot });
  assert.equal(switched.mainFile, "entry.bean");
  assert.equal(switched.monthlyDir, "other/{source}");
  assert.equal(switched.annualLayout, false);
  assert.deepEqual(switched.assetMapping, []);
  assert.equal(switched.llm.apiKey, "");
  const disk = JSON.parse(fs.readFileSync(otherSettings, "utf8"));
  assert.equal(disk.llm.apiKey, "fixture-secret");
  assert.deepEqual(disk.futurePreference, { enabled: true });
  await request(base, route, undefined, 409); assert.deepEqual(await request(base, "/api/batches"), []);
  await deleteBatch(base, pendingReplay.batchId, pendingReplay.revision, 409);
  await request(base, route + "/commit", { revision: edited.revision }, 409);
  assert.equal(fs.existsSync(path.join(otherRoot, "years")), false);
  await request(base, "/api/config", { ledgerRoot: root, monthlyDir: config.monthlyDir }); assert.ok((await request(base, "/api/batches")).length >= 3);
  passed("switching ledgers loads their own complete settings, preserves additional fields and cannot redirect a batch");
  const activeLedgerFile = path.join(temporary, "user-data", "active-ledger.json");
  const firstStart = await boot({ ...config, ledgerRoot: "" }, dataDir, activeLedgerFile);
  assert.deepEqual(await request(firstStart, "/api/batches"), []);
  assert.deepEqual(await request(firstStart, "/api/ledger"), { accountCount: 0, txCount: 0, accounts: [] });
  const missingLedger = await request(firstStart, "/api/validate", undefined, 400);
  assert.match(missingLedger.error, /先在账本设置/);
  const selected = await request(firstStart, "/api/config", { ledgerRoot: otherRoot });
  assert.equal(selected.mainFile, "entry.bean");
  assert.deepEqual(JSON.parse(fs.readFileSync(activeLedgerFile, "utf8")), { ledgerRoot: otherRoot });
  assert.equal(fs.existsSync(path.join(dataDir, "config.json")), false);
  const originalOverride = process.env.ACCOUNT_IMPORT_LEDGER_ROOT;
  try {
    delete process.env.ACCOUNT_IMPORT_LEDGER_ROOT;
    const restarted = await boot(undefined, dataDir, activeLedgerFile);
    const reloaded = await request(restarted, "/api/config");
    assert.equal(reloaded.ledgerRoot, otherRoot);
    assert.equal(reloaded.mainFile, "entry.bean");
    assert.equal(reloaded.monthlyDir, "other/{source}");
    assert.equal((await request(restarted, "/api/ledger")).accountCount, 4);
    process.env.ACCOUNT_IMPORT_LEDGER_ROOT = root;
    const withOverride = await boot(undefined, dataDir, activeLedgerFile);
    assert.equal((await request(withOverride, "/api/config")).ledgerRoot, root);
    assert.deepEqual(JSON.parse(fs.readFileSync(activeLedgerFile, "utf8")), { ledgerRoot: otherRoot });
  } finally {
    if (originalOverride === undefined) delete process.env.ACCOUNT_IMPORT_LEDGER_ROOT;
    else process.env.ACCOUNT_IMPORT_LEDGER_ROOT = originalOverride;
  }
  passed("choosing a ledger persists its location across a restart and the explicit startup override wins");
  await request(base, "/api/config", { monthlyDir: "imports/{unknown}" }, 400);
  await request(base, "/api/config", { monthlyDir: "../{month}" }, 400);
  await request(base, "/api/config", { monthlyDir: "E:\\{month}" }, 400);
  await request(base, "/api/config/pick-path", { kind: "ledgerRoot", current: root, ledgerDirectory: root }, 403);
  assert.equal((await request(base, "/api/config")).monthlyDir, config.monthlyDir);
  passed("invalid directory templates and non-local native dialog requests are rejected");
  const localAddress = Object.values(os.networkInterfaces()).flatMap((entries) => entries ?? [])
    .find((entry) => entry.family === "IPv4" && !entry.internal)?.address;
  const pickerRequest = (host: string, extra: Record<string, string> = {}, peer = "127.0.0.1") =>
    transport(base, "/api/config/pick-path", {
      method: "POST", body: "{}",
      headers: { host, origin: `http://${host}`, "content-type": "application/json", ...extra },
    }, peer);
  // An invalid body proves the request reached picker validation without opening a window.
  const reachedPicker = process.platform === "win32" ? 400 : 501;
  for (const host of ["localhost:5173", "[::1]:5173", `${os.hostname().toLowerCase()}:5173`]) {
    assert.equal((await pickerRequest(host)).status, reachedPicker);
  }
  if (localAddress) {
    assert.equal((await pickerRequest(`${localAddress}:5173`, { "x-forwarded-for": `::ffff:${localAddress}` })).status, reachedPicker);
  }
  assert.equal((await pickerRequest("localhost:5173", { "x-forwarded-for": "127.0.0.1, 192.0.2.1" })).status, 403);
  assert.equal((await pickerRequest("localhost:5173", {}, "192.0.2.1")).status, 403);
  assert.equal((await pickerRequest("localhost:5173", { origin: "http://localhost:9999" })).status, 403);
  assert.equal((await pickerRequest("localhost:5173", { "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await pickerRequest("unrelated.example:5173")).status, 403);
  passed("native picker accepts this computer's hostname and IP while blocking forwarded remote and cross-origin requests");

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
    const walletMoves = realBatch.txs.filter((tx) => tx.source === "wechat" && ["转入零钱通-来自零钱", "零钱通转出-到零钱"].includes(tx.rawCategory));
    assert.ok(walletMoves.every((tx) => tx.status === "excluded"));
    assert.equal(realBatch.txs.length, 1508); assert.equal(realBatch.parseStats?.excluded, 38 + walletMoves.length); assert.equal(realBatch.errors.length, 0);
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
