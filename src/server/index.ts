import express from "express";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import multer from "multer";
import type { AppConfig, ImportPreview, ParsedTx, TxDecision, LedgerInfo } from "../shared/types.js";
import { loadConfig, saveConfig } from "./config.js";
import { parseLedger, validateLedgerFile } from "./lib/ledger.js";
import { markDuplicates, sourceKey } from "./lib/dedup.js";
import { classifyLocal, classifyWithLlm, loadMemory, saveMemory, suggestRefundsFromBatch } from "./lib/classify.js";
import { inferFundingAccount, detectAccounts } from "./lib/accounts.js";
import { generateEntries, transactionPostings } from "./lib/generate.js";
import { isAlipay, parseAlipay } from "./parsers/alipay.js";
import { isWechat, parseWechat } from "./parsers/wechat.js";
import { parseYunshanfu, isYunshanfu } from "./parsers/yunshanfu.js";
import { detectBank, parseBank } from "./parsers/banks.js";
import { parsePdfBank } from "./parsers/pdf.js";
import { pairTransfers } from "./lib/transfers.js";
import { readSheet } from "./parsers/common.js";
import { BatchStore, profileId, type StoredBatch } from "./lib/batches.js";
import { commitBatch, ImportError } from "./lib/commit.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TAG_RE = /^[A-Za-z0-9][A-Za-z0-9_./-]*$/;
const STATUSES = new Set(["pending", "ready", "duplicate", "excluded"]);

function filename(name: string): string {
  const decoded = Buffer.from(name, "latin1").toString("utf8");
  if (!/[\u3400-\u9fff]/.test(name) && /[\u3400-\u9fff]/.test(decoded) && !decoded.includes("�")) name = decoded;
  return path.basename(name).replace(/[\u0000-\u001f]/g, "_");
}

function stats(batch: ImportPreview) {
  return { total: batch.txs.length,
    excluded: batch.txs.filter((tx) => tx.status === "excluded").length,
    pending: batch.txs.filter((tx) => tx.status === "pending").length,
    duplicate: batch.txs.filter((tx) => tx.status === "duplicate").length,
    ready: batch.txs.filter((tx) => tx.status === "ready").length };
}

function draftErrors(txs: ParsedTx[], ledger: LedgerInfo): string[] {
  const accounts = new Map(ledger.accounts.map((account) => [account.account, account]));
  const errors: string[] = [];
  for (const tx of txs.filter((tx) => tx.status === "ready")) {
    const names = tx.postings?.length ? tx.postings.map((posting) => ({ account: posting.account, currency: posting.currency }))
      : [tx.fundingAccount, tx.fundingAccount2 ?? tx.finalAccount].map((account) => ({ account, currency: tx.currency }));
    for (const item of names) {
      const defined = accounts.get(item.account), label = `${tx.sourceFile}:${tx.row}`;
      if (!defined) errors.push(`${label}：账户未在真实账本开户：${item.account || "未选择"}`);
      else if ((defined.openedAt && tx.date < defined.openedAt) || (defined.closedAt && tx.date > defined.closedAt)) errors.push(`${label}：账户在交易日未生效：${item.account}`);
      else if (defined.currencies?.length && !defined.currencies.includes(item.currency)) errors.push(`${label}：${item.account} 不支持币种 ${item.currency}`);
    }
    if (tx.tags?.some((tag) => !TAG_RE.test(tag))) errors.push(`${tx.sourceFile}:${tx.row}：标签含不支持的字符`);
  }
  return [...new Set(errors)];
}

function referenceUncommittedBatches(txs: ParsedTx[], previous: StoredBatch[]) {
  const identities = new Map<string, Array<{ batch: StoredBatch; tx: ParsedTx }>>();
  for (const batch of previous.filter((batch) => !batch.committed)) for (const tx of batch.txs) {
    if (tx.status === "excluded" || tx.excludedReason || tx.status === "duplicate") continue;
    const key = sourceKey(tx.source, tx.sourceTxId, tx.sourceFileHash, tx.row);
    if (!key) continue;
    const matches = identities.get(key) ?? [];
    if (matches.length < 3) matches.push({ batch, tx });
    identities.set(key, matches);
  }
  for (const tx of txs) {
    if (tx.status === "excluded" || tx.status === "duplicate") continue;
    const key = sourceKey(tx.source, tx.sourceTxId, tx.sourceFileHash, tx.row);
    const references = key ? identities.get(key) : undefined;
    if (!references?.length) continue;
    tx.status = "pending";
    tx.issues = [...new Set([...(tx.issues ?? []), "同一来源交易已在其他未提交批次，请先恢复原批次或核对保留项"] )];
    tx.matches ??= [];
    for (const reference of references) tx.matches.push({
      id: `batch:${reference.batch.batchId}:${reference.tx.id}`, date: reference.tx.date,
      payee: reference.tx.payee, narration: reference.tx.note,
      file: `未提交批次 ${reference.batch.batchId} · ${reference.tx.sourceFile}`, line: reference.tx.row,
      reason: "其他未提交批次已有相同来源交易；尚未过账，仅作重复导入提醒",
      postings: reference.tx.postings ?? (reference.tx.fundingAccount && reference.tx.finalAccount ? transactionPostings(reference.tx) : []),
    });
  }
}

export function createApp(options: { dataDir?: string; config?: AppConfig } = {}) {
  const dataDir = path.resolve(options.dataDir ?? process.env.BEAN_IMPORT_DATA_DIR ?? path.join(ROOT, "server-data"));
  fs.mkdirSync(dataDir, { recursive: true });
  let config = options.config ?? loadConfig(dataDir);
  const batches = new BatchStore(path.join(dataDir, "batches"));
  const ledgerRoot = () => path.resolve(ROOT, config.ledgerRoot);
  const profile = () => profileId(ledgerRoot(), config.mainFile);
  const ledger = () => parseLedger(ledgerRoot(), config.mainFile, config.pythonPath);
  const memoryFile = () => path.join(dataDir, "profiles", profile(), "memory.json");
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  const uploads = path.join(dataDir, "uploads");
  fs.mkdirSync(uploads, { recursive: true });
  const upload = multer({ storage: multer.diskStorage({ destination: uploads, filename: (_req, file, callback) => {
    callback(null, `${crypto.randomBytes(16).toString("hex")}${path.extname(filename(file.originalname)).toLowerCase()}`);
  } }), limits: { fileSize: 30 * 1024 * 1024, files: 20 } });
  const asyncRoute = (handler: (req: express.Request, res: express.Response) => Promise<unknown>) =>
    (req: express.Request, res: express.Response, next: express.NextFunction) => { Promise.resolve(handler(req, res)).catch(next); };
  const getBatch = (id: string) => {
    const batch = batches.get(id);
    if (!batch) throw new ImportError(404, "批次不存在");
    if (batch.ledgerProfile !== profile()) throw new ImportError(409, "此批次属于另一账本，请先切回原账本");
    return batch;
  };
  const requireRevision = (batch: StoredBatch, value: unknown) => {
    if (!Number.isInteger(value) || value !== batch.revision) throw new ImportError(409, "批次已更新，请重新加载后操作");
  };
  const publicBatch = (batch: StoredBatch) => ({ ...batch, preview: undefined, ledgerProfile: undefined, parseStats: stats(batch) });

  app.get("/api/health", (_req, res) => res.json({ ok: true }));
  app.get("/api/batches", (_req, res) => res.json(batches.list().filter((batch) => batch.ledgerProfile === profile()).map((batch) => ({
    batchId: batch.batchId, file: batch.file, createdAt: batch.createdAt, revision: batch.revision, committed: batch.committed, txCount: batch.txs.length,
  }))));
  app.post("/api/upload", upload.array("files"), asyncRoute(async (req, res) => {
    const files = (req.files as Express.Multer.File[]) ?? [];
    if (!files.length) throw new ImportError(400, "请选择账单文件");
    const uploadConfig = structuredClone(config), uploadRoot = ledgerRoot();
    const uploadProfile = profileId(uploadRoot, uploadConfig.mainFile);
    const currentLedger = parseLedger(uploadRoot, uploadConfig.mainFile, uploadConfig.pythonPath);
    const memory = loadMemory(path.join(dataDir, "profiles", uploadProfile, "memory.json"));
    const txs: ParsedTx[] = [], errors: ImportPreview["errors"] = [];
    const instances = new Map<string, number>(), sources = new Set<ImportPreview["source"]>();
    for (const file of files) {
      const name = filename(file.originalname);
      const sourceFileHash = crypto.createHash("sha256").update(fs.readFileSync(file.path)).digest("hex");
      try {
        let result;
        if (isAlipay(file.path, name)) result = parseAlipay(file.path);
        else if (isWechat(name)) result = parseWechat(file.path);
        else if (isYunshanfu(name)) result = parseYunshanfu(file.path);
        else if (name.toLowerCase().endsWith(".pdf")) result = await parsePdfBank(file.path, detectBank(name, [])?.source ?? "bank-generic");
        else { const { rows } = readSheet(file.path); const bank = detectBank(name, rows); if (bank) result = parseBank(file.path, bank); }
        if (!result) { errors.push({ row: 0, message: `${name}：无法识别类型，请使用已解压的 CSV/XLSX/PDF` }); continue; }
        sources.add(result.source);
        for (const raw of result.txs) {
          const occurrence = (instances.get(raw.id) ?? 0) + 1; instances.set(raw.id, occurrence);
          const tx: ParsedTx = { ...raw, id: occurrence === 1 ? raw.id : `${raw.id}:${occurrence}`, sourceFile: name, sourceFileHash,
            status: raw.excludedReason ? "excluded" : "pending", fundingAccount: "", suggestedAccount: "", confidence: 0, finalAccount: "", tags: [], flag: "*" };
          const funding = inferFundingAccount(tx, uploadConfig, currentLedger);
          tx.fundingAccount = funding.account; tx.fundingConfidence = funding.confidence;
          tx.issues = [...new Set([...(raw.issues ?? []), ...(funding.issues ?? [])])];
          const local = classifyLocal(tx, memory, currentLedger);
          if (local) { tx.suggestedAccount = local.account; tx.confidence = local.confidence; tx.reason = local.reason; }
          txs.push(tx);
        }
        errors.push(...result.errors.map((error) => ({ ...error, message: `${name}：${error.message}` })));
      } catch (error) { errors.push({ row: 0, message: `${name}：解析失败：${(error as Error).message}` }); }
    }
    const llm = await classifyWithLlm(txs.filter((tx) => tx.status !== "excluded" && tx.confidence < 0.7), uploadConfig, currentLedger);
    for (const tx of txs) {
      const hit = llm.get(tx.id);
      if (hit && hit.confidence > tx.confidence) { tx.suggestedAccount = hit.account; tx.confidence = hit.confidence; tx.reason = hit.reason; }
      tx.finalAccount = tx.suggestedAccount;
      if (tx.status === "pending" && tx.confidence >= 0.9 && (tx.fundingConfidence ?? 0) >= 0.9 && !tx.issues?.length) tx.status = "ready";
    }
    suggestRefundsFromBatch(txs, currentLedger);
    const deduped = markDuplicates(txs, currentLedger.transactions), paired = pairTransfers(deduped.txs);
    if (profile() !== uploadProfile) throw new ImportError(409, "上传期间账本配置已切换，请在目标账本重新上传");
    referenceUncommittedBatches(deduped.txs, batches.list().filter((previous) => previous.ledgerProfile === uploadProfile));
    const batch = batches.create({ file: files.map((file) => filename(file.originalname)).join(", "), source: sources.size === 1 ? [...sources][0] : "unknown",
      txCount: txs.length, txs: deduped.txs, errors,
      accountsDetected: detectAccounts(deduped.txs).map((entry) => ({ ...entry, guess: deduped.txs.find((tx) => tx.rawAccount === entry.raw)?.fundingAccount ?? "" })),
      ledgerProfile: uploadProfile, ledgerErrors: currentLedger.errors ?? [], dedup: { ...deduped.stats, transferPairs: paired.pairs.length } });
    res.json({ batchId: batch.batchId, revision: batch.revision, preview: { ...publicBatch(batch), txs: undefined, lowConfidence: batch.txs.filter((tx) => tx.status === "pending").length } });
  }));
  app.get("/api/batch/:id", (req, res) => res.json(publicBatch(getBatch(req.params.id))));
  app.post("/api/batch/:id/decide", (req, res) => {
    const batch = getBatch(req.params.id);
    if (batch.committed) throw new ImportError(409, "已写入的批次不能再修改");
    requireRevision(batch, req.body.revision);
    const decisions = req.body.decisions as TxDecision[];
    if (!Array.isArray(decisions) || decisions.length > 5000) throw new ImportError(400, "审阅决策格式无效");
    const currentLedger = ledger(), memory = loadMemory(memoryFile()), names = new Set(currentLedger.accounts.map((account) => account.account));
    for (const decision of decisions) {
      if (!decision || typeof decision.id !== "string" || !batch.txs.some((tx) => tx.id === decision.id)) throw new ImportError(400, "交易不存在");
      if (decision.status !== undefined && !STATUSES.has(decision.status)) throw new ImportError(400, "无效的审阅状态");
      if (decision.account !== undefined && (typeof decision.account !== "string" || !names.has(decision.account))) throw new ImportError(400, "分类账户必须来自当前账本");
      if (decision.funding !== undefined && (typeof decision.funding !== "string" || !names.has(decision.funding) || !/^(Assets|Liabilities):/.test(decision.funding))) throw new ImportError(400, "资金账户必须来自当前账本的资产或负债账户");
      if (decision.tags !== undefined && (!Array.isArray(decision.tags) || decision.tags.length > 40 || decision.tags.some((tag) => typeof tag !== "string" || tag.length > 64 || !TAG_RE.test(tag)))) throw new ImportError(400, "标签限英文字母、数字及 _ - / .，每个最多 64 字符");
      if (decision.flag !== undefined && decision.flag !== "*" && decision.flag !== "!") throw new ImportError(400, "标记应为 * 或 !");
      if (decision.reviewNote !== undefined && (typeof decision.reviewNote !== "string" || decision.reviewNote.length > 2000)) throw new ImportError(400, "备注最多 2000 字符");
      if (decision.postings !== undefined && decision.postings !== null && (!Array.isArray(decision.postings) || decision.postings.length < 2 || decision.postings.length > 40 || decision.postings.some((posting) => !posting || !names.has(posting.account) || !Number.isFinite(posting.amount) || typeof posting.currency !== "string" || !/^[A-Z][A-Z0-9._'-]{0,23}$/.test(posting.currency)))) throw new ImportError(400, "拆分分录必须包含有效账本账户、金额和币种");
    }
    for (const decision of decisions) {
      const tx = batch.txs.find((item) => item.id === decision.id)!;
      if (decision.account !== undefined) {
        for (const posting of tx.postings ?? []) if (posting.account === tx.finalAccount) posting.account = decision.account;
        tx.finalAccount = decision.account;
        if (/^(Expenses|Income):/.test(decision.account)) memory.mapping[`${tx.payee.replace(/\s+/g, "").slice(0, 32)}|${tx.rawCategory.slice(0, 24)}`] = decision.account;
      }
      if (decision.funding !== undefined) {
        for (const posting of tx.postings ?? []) if (posting.account === tx.fundingAccount) posting.account = decision.funding;
        tx.fundingAccount = decision.funding; tx.fundingConfidence = 1;
      }
      if (decision.tags !== undefined) tx.tags = [...new Set(decision.tags)];
      if (decision.flag !== undefined) tx.flag = decision.flag;
      if (decision.reviewNote !== undefined) tx.reviewNote = decision.reviewNote;
      if (decision.postings === null) { delete tx.postings; delete tx.fundingAccount2; }
      else if (decision.postings !== undefined) { tx.postings = decision.postings; delete tx.fundingAccount2; }
      if (decision.status !== undefined) tx.status = decision.status;
      else if (decision.account !== undefined) tx.status = "ready";
      if (tx.status !== "duplicate") delete tx.duplicateOf;
    }
    batch.revision++; delete batch.preview;
    batches.save(batch); saveMemory(memoryFile(), memory);
    res.json({ ok: true, revision: batch.revision, ready: stats(batch).ready });
  });
  app.post("/api/batch/:id/generate", (req, res) => {
    const batch = getBatch(req.params.id); requireRevision(batch, req.body.revision);
    if (batch.committed) throw new ImportError(409, "该批次已经写入");
    const currentLedger = ledger(), result = generateEntries(batch.txs, batch.batchId);
    const errors = [...draftErrors(batch.txs, currentLedger), ...(result.errors ?? [])];
    if (!result.generated.length && !errors.length) errors.push("没有已确认的交易，请先审阅");
    if (errors.length) { delete batch.preview; batches.save(batch); res.status(422).json({ error: "请先处理分录问题", errors, details: errors, revision: batch.revision }); return; }
    batch.preview = { revision: batch.revision, result, opens: [] }; batches.save(batch);
    res.json({ ...result, generated: result.generated.length, opens: [], revision: batch.revision, baselineErrors: currentLedger.errors ?? [] });
  });
  app.post("/api/batch/:id/commit", (req, res) => {
    const batch = getBatch(req.params.id);
    if (!batch.committed) requireRevision(batch, req.body.revision);
    const result = commitBatch(batch, config, ledgerRoot(), dataDir);
    batch.committed = true; batch.committedAt ??= new Date().toISOString(); batch.written = result.written; batches.save(batch);
    res.json(result);
  });
  app.get("/api/ledger", (_req, res) => {
    const current = ledger(); res.json({ accountCount: current.accounts.length, txCount: current.transactions.length, accounts: current.accounts,
      errors: current.errors ?? [], loader: current.loader, ledgerRoot: ledgerRoot(), mainFile: config.mainFile });
  });
  app.get("/api/validate", (_req, res) => {
    const result = validateLedgerFile(path.resolve(ledgerRoot(), config.mainFile), config.pythonPath);
    res.json({ ...result, available: true, output: result.errors.length ? result.errors.map((error) => `${error.file ?? ""}:${error.line ?? ""} ${error.message}`).join("\n") : "原生 Beancount 校验通过" });
  });
  const publicConfig = () => ({ ...config, llm: { ...config.llm, apiKey: "" } });
  app.get("/api/config", (_req, res) => res.json(publicConfig()));
  app.post("/api/config", (req, res) => {
    const patch = req.body as Partial<AppConfig>, candidate = { ...config, ...patch, llm: { ...config.llm, ...patch.llm } };
    if (typeof candidate.ledgerRoot !== "string" || typeof candidate.mainFile !== "string" || typeof candidate.monthlyDir !== "string") throw new ImportError(400, "账本路径配置无效");
    const root = path.resolve(ROOT, candidate.ledgerRoot), main = path.resolve(root, candidate.mainFile);
    if (!main.startsWith(`${root}${path.sep}`) || !fs.existsSync(main)) throw new ImportError(400, "账本主文件不存在或位于账本目录外");
    if (!Array.isArray(candidate.assetMapping) || candidate.assetMapping.some((mapping) => !mapping || typeof mapping.keyword !== "string" || !mapping.keyword.trim() || typeof mapping.account !== "string" || !["credit", "debit"].includes(mapping.kind) || (mapping.cardSuffix !== undefined && (typeof mapping.cardSuffix !== "string" || !/^\d{0,6}$/.test(mapping.cardSuffix))))) throw new ImportError(400, "资金映射需要有效关键词、账户、借贷类型及可选卡片尾号");
    if (typeof candidate.annualLayout !== "boolean" && candidate.annualLayout !== undefined) throw new ImportError(400, "年度布局配置无效");
    const current = parseLedger(root, candidate.mainFile, candidate.pythonPath), defined = new Set(current.accounts.filter((account) => /^(Assets|Liabilities):/.test(account.account)).map((account) => account.account));
    const switched = profileId(root, candidate.mainFile) !== profile();
    if (!switched && candidate.assetMapping.some((mapping) => !defined.has(mapping.account))) throw new ImportError(400, "资金映射账户必须在目标账本中定义");
    candidate.assetMapping = candidate.assetMapping.filter((mapping) => defined.has(mapping.account)).map((mapping) => ({ ...mapping, keyword: mapping.keyword.trim(), cardSuffix: mapping.cardSuffix || undefined }));
    candidate.accounts = current.accounts.map((account) => account.account).sort();
    config = candidate; saveConfig(dataDir, config); res.json(publicConfig());
  });
  let fava: ReturnType<typeof import("node:child_process").spawn> | undefined;
  app.post("/api/fava", asyncRoute(async (_req, res) => {
    if (fava && fava.exitCode === null && !fava.killed) { res.json({ running: true, port: 5000, alreadyRunning: true }); return; }
    const { spawn } = await import("node:child_process");
    const local = config.pythonPath ? path.join(path.dirname(config.pythonPath), "fava") : "";
    const proc = spawn(local && fs.existsSync(local) ? local : "fava", ["-p", "5000", "-H", "127.0.0.1", path.resolve(ledgerRoot(), config.mainFile)], { stdio: ["ignore", "ignore", "pipe"] });
    let output = ""; proc.stderr?.on("data", (data: Buffer) => { output = (output + data.toString()).slice(-2000); });
    const failure = await new Promise<string | undefined>((resolve) => {
      const timer = setTimeout(() => resolve(undefined), 1000);
      proc.once("error", (error) => { clearTimeout(timer); resolve(error.message); });
      proc.once("exit", (code) => { clearTimeout(timer); resolve(output || `Fava 已退出 (${code})`); });
    });
    if (failure) { res.json({ running: false, port: 5000, error: failure }); return; }
    fava = proc; proc.once("exit", () => { if (fava === proc) fava = undefined; }); res.json({ running: true, port: 5000 });
  }));
  const frontend = path.join(ROOT, "web-dist");
  if (fs.existsSync(path.join(frontend, "index.html"))) {
    app.use(express.static(frontend));
    app.get("*", (req, res) => req.path.startsWith("/api/") ? res.status(404).json({ error: "接口不存在" }) : res.sendFile(path.join(frontend, "index.html")));
  }
  app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof ImportError) res.status(error.status).json({ error: error.message, details: error.details });
    else if (error instanceof multer.MulterError) res.status(400).json({ error: `上传失败：${error.message}` });
    else res.status(500).json({ error: error.message });
  });
  return app;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 8787);
  createApp().listen(port, "127.0.0.1", () => { console.log(`bean-import → http://localhost:${port}`); });
}
