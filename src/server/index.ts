import express from "express";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import multer from "multer";
import type { AppConfig, FundingMappingChoice, FundingMappingGroup, ImportPreview, ParsedTx, TxDecision, LedgerInfo } from "../shared/types.js";
import { canExcludeSuspectedDuplicate, duplicateReviewIssue, MAX_NARRATION_LENGTH } from "../shared/types.js";
import { MAX_CATEGORY_ALLOCATIONS, planCategoryAllocations, savedCategoryAllocations } from "../shared/categoryAllocations.js";
import { activeTransactions, mergeSource, planTransactionMerge } from "../shared/transactionMerge.js";
import { validDate } from "../shared/postings.js";
import { hasFundingPosting, isFundingAccount, isStatementOnlyPayment, reusablePaymentMethod } from "../shared/funding.js";
import { configWithDefaults, defaultActiveLedgerFile, loadConfig, readLedgerSettings, saveConfig } from "./config.js";
import { discoverPython, LedgerAccessError, parseLedger, parseLedgerAsync, validateLedgerFile } from "./lib/ledger.js";
import { markDuplicates, refreshLedgerDuplicateHints, sourceKey } from "./lib/dedup.js";
import { matchWechatRefunds, syncWechatRefunds } from "./lib/refunds.js";
import { classifyLocal, classifyWithLlm, loadMemory, saveMemory, suggestRefundsFromBatch } from "./lib/classify.js";
import { accountIsActive, confirmFundingAccount, detectAccounts, fundingMappingIssue, inferFundingAccount, isMissingPaymentMethod, normalizePaymentMethod, setExactFundingMapping, singlePaymentMethod } from "./lib/accounts.js";
import { generateEntries, suggestOpens, transactionPostings } from "./lib/generate.js";
import { isAlipay, parseAlipay } from "./parsers/alipay.js";
import { isWechat, parseWechat } from "./parsers/wechat.js";
import { loadWechatRules, recognizeWechatTransaction, wechatExclusionReason } from "./parsers/wechat-rules.js";
import { parseYunshanfu, isYunshanfu } from "./parsers/yunshanfu.js";
import { detectBank, parseBank } from "./parsers/banks.js";
import { parsePdfBank, PDF_RETRY_HINT } from "./parsers/pdf.js";
import { pairTransfers, transferPairIssue } from "./lib/transfers.js";
import { isParsedStatementRow, readSheet } from "./parsers/common.js";
import { BatchStore, isBatchId, profileId, type StoredBatch } from "./lib/batches.js";
import { acquireWriteLock, assertBatchDeletable, commitBatch, ImportError } from "./lib/commit.js";
import { importDirectoryError } from "./lib/import-paths.js";
import { isLocalRequest } from "./lib/local-request.js";
import { createPdfPreviewLoader } from "./lib/pdf-preview.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TAG_RE = /^[A-Za-z0-9][A-Za-z0-9_./-]*$/;
const STATUSES = new Set(["pending", "ready", "duplicate", "excluded"]);
const OTHER_BATCH_ISSUE = "另一个未提交批次已有此交易";
const STATEMENT_RETRY_HINT = "暂时无法读取这份账单。请重新上传，或重新导出账单后再试。";
const MAX_STATEMENT_MB = 30, MAX_STATEMENT_FILES = 20;
const otherBatchIssue = (issue: string) => issue === OTHER_BATCH_ISSUE || issue.startsWith("这笔交易已在另一个未提交批次中");
const runFile = promisify(execFile);

function filename(name: string): string {
  const decoded = Buffer.from(name, "latin1").toString("utf8");
  if (!/[\u3400-\u9fff]/.test(name) && /[\u3400-\u9fff]/.test(decoded) && !decoded.includes("�")) name = decoded;
  return path.basename(name).replace(/[\u0000-\u001f]/g, "_");
}

function publicParseErrors(errors: ImportPreview["errors"]): ImportPreview["errors"] {
  // Older batches stored the parser exception after the display filename.
  return errors.map((issue) => {
    const legacy = issue.row === 0 && issue.message.match(/^(?:(.*?)：)?(PDF )?解析失败[：:]/);
    if (!legacy) return issue;
    const [, file, pdf] = legacy;
    return { ...issue, message: (file ? `${file}：` : "") + (pdf ? PDF_RETRY_HINT : STATEMENT_RETRY_HINT) };
  });
}

function batchFileLabel(batch: StoredBatch): string {
  if (!batch.errors.length) return batch.file;
  // Older batches included failed filenames in the label.
  const files = new Set(batch.txs.filter((tx) => !tx.merge && isParsedStatementRow(tx)).map((tx) => tx.sourceFile).filter(Boolean));
  return files.size ? [...files].join(", ") : batch.file;
}

function stats(batch: ImportPreview) {
  const txs = activeTransactions(batch.txs);
  return { total: txs.length,
    excluded: txs.filter((tx) => tx.status === "excluded").length,
    pending: txs.filter((tx) => tx.status === "pending").length,
    duplicate: txs.filter((tx) => tx.status === "duplicate").length,
    ready: txs.filter((tx) => tx.status === "ready").length };
}

function draftErrors(txs: ParsedTx[], ledger: LedgerInfo, opening?: Set<string>): string[] {
  const accounts = new Map(ledger.accounts.map((account) => [account.account, account]));
  const errors: string[] = [];
  for (const tx of txs.filter((tx) => tx.status === "ready")) {
    const names = tx.postings?.length ? tx.postings.map((posting) => ({ account: posting.account, currency: posting.currency }))
      : [tx.fundingAccount, tx.fundingAccount2 ?? tx.finalAccount].map((account) => ({ account, currency: tx.currency }));
    for (const item of names) {
      const defined = accounts.get(item.account), label = `${tx.sourceFile}:${tx.row}`;
      if (!defined) {
        if (opening?.has(item.account)) continue; // the commit will write this `open`
        errors.push(`${label}：账户 ${item.account || "未选择"} 未在账本开户`);
      }
      else if ((defined.openedAt && tx.date < defined.openedAt) || (defined.closedAt && tx.date > defined.closedAt)) errors.push(`${label}：账户 ${item.account} 在交易日未生效`);
      else if (defined.currencies?.length && !defined.currencies.includes(item.currency)) errors.push(`${label}：账户 ${item.account} 不支持币种 ${item.currency}`);
    }
    if (tx.tags?.some((tag) => !TAG_RE.test(tag))) errors.push(`${tx.sourceFile}:${tx.row}：标签格式无效`);
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
    tx.issues = [...new Set([...(tx.issues ?? []), OTHER_BATCH_ISSUE])];
    tx.matches ??= [];
    for (const reference of references) tx.matches.push({
      id: `batch:${reference.batch.batchId}:${reference.tx.id}`, date: reference.tx.date,
      payee: reference.tx.payee, narration: reference.tx.note,
      file: `未提交批次 ${reference.batch.batchId} · ${reference.tx.sourceFile}`, line: reference.tx.row,
      reason: "未提交批次已有此交易",
      postings: reference.tx.postings ?? (reference.tx.fundingAccount && reference.tx.finalAccount ? transactionPostings(reference.tx) : []),
    });
  }
}

const wechatRulesFor = (txs: ParsedTx[]) => txs.some((tx) => tx.source === "wechat") ? loadWechatRules() : [];

function applyWechatExclusions(txs: ParsedTx[], rules: ReturnType<typeof loadWechatRules>): boolean {
  if (!rules.length) return false;
  const excluded = new Set<string>();
  for (const tx of txs) {
    const reason = wechatExclusionReason(tx, rules);
    if (!reason) continue;
    tx.excludedReason = reason;
    tx.status = "excluded";
    delete tx.duplicateOf;
    delete tx.matches;
    tx.issues = tx.issues?.filter((issue) => !duplicateReviewIssue(issue) && !transferPairIssue(issue) && !otherBatchIssue(issue));
    excluded.add(tx.id);
  }
  if (!excluded.size) return false;
  for (const tx of txs) {
    if (!tx.matches?.some((match) => excluded.has(match.id))) continue;
    tx.matches = tx.matches.filter((match) => !excluded.has(match.id) || !match.reason.startsWith("转账配对建议"));
    if (!tx.matches.some((match) => match.reason.startsWith("转账配对建议"))) {
      tx.issues = tx.issues?.filter((issue) => !transferPairIssue(issue));
    }
  }
  return true;
}

function unmappedPayments(txs: ParsedTx[], wechatRules: ReturnType<typeof loadWechatRules>) {
  const groups = new Map<string, { raw: string; fromFile: boolean; txs: ParsedTx[] }>();
  for (const tx of txs) {
    if (tx.fundingAccount || tx.fundingAccount2 || tx.postings?.length || tx.excludedReason || tx.status === "excluded" || tx.status === "duplicate") continue;
    if (tx.source === "wechat" && isMissingPaymentMethod(tx.rawAccount)) {
      const recognition = recognizeWechatTransaction(tx, wechatRules);
      if (recognition) tx.recognition = recognition;
    }
    const raw = singlePaymentMethod(tx);
    if (!raw) continue;
    const fromFile = isStatementOnlyPayment(tx, raw);
    const id = crypto.createHash("sha256").update(JSON.stringify([tx.source, fromFile ? raw : normalizePaymentMethod(raw)])).digest("hex");
    const group = groups.get(id) ?? { raw, fromFile, txs: [] };
    group.txs.push(tx);
    groups.set(id, group);
  }
  return groups;
}

export function createApp(options: { dataDir?: string; config?: AppConfig; activeLedgerFile?: string } = {}) {
  const dataDir = path.resolve(options.dataDir ?? process.env.BEAN_IMPORT_DATA_DIR ?? path.join(ROOT, "server-data"));
  fs.mkdirSync(dataDir, { recursive: true });
  let config = options.config ?? loadConfig(dataDir, options.activeLedgerFile);
  const batches = new BatchStore(path.join(dataDir, "batches"));
  const ledgerRoot = () => {
    if (!config.ledgerRoot.trim()) throw new ImportError(400, "请先在账本设置中选择并保存账本目录");
    return path.resolve(ROOT, config.ledgerRoot);
  };
  const profile = () => profileId(ledgerRoot(), config.mainFile);
  const ledger = () => parseLedger(ledgerRoot(), config.mainFile, config.pythonPath);
  let accountCatalog: { key: string; names: Set<string>; sources: NonNullable<LedgerInfo["accountSources"]> } | undefined;
  const catalogKey = (root: string, main: string, python: string | undefined) =>
    JSON.stringify([profileId(root, main), python || discoverPython(root)]);
  const rememberAccountNames = (key: string, current: LedgerInfo) => {
    const names = new Set(current.accounts.map(({ account }) => account));
    accountCatalog = current.accountSources?.length ? { key, names, sources: current.accountSources } : undefined;
    return names;
  };
  const currentAccountNames = () => {
    const root = ledgerRoot();
    const { mainFile, pythonPath } = config;
    const key = catalogKey(root, mainFile, pythonPath);
    if (accountCatalog?.key === key) {
      try {
        const unchanged = accountCatalog.sources.every(({ file, sha256 }) =>
          crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") === sha256);
        if (unchanged) return accountCatalog.names;
      } catch { /* Re-read the ledger when an input file can no longer be read. */ }
    }
    return rememberAccountNames(key, parseLedger(root, mainFile, pythonPath, true));
  };
  const memoryFile = () => path.join(dataDir, "profiles", profile(), "memory.json");
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  const uploads = path.join(dataDir, "uploads");
  fs.mkdirSync(uploads, { recursive: true });
  const loadPdfPreview = createPdfPreviewLoader(uploads, MAX_STATEMENT_MB * 1024 * 1024);
  const upload = multer({ storage: multer.diskStorage({ destination: uploads, filename: (_req, file, callback) => {
    callback(null, `${crypto.randomBytes(16).toString("hex")}${path.extname(filename(file.originalname)).toLowerCase()}`);
  } }), limits: { fileSize: MAX_STATEMENT_MB * 1024 * 1024, files: MAX_STATEMENT_FILES } });
  const asyncRoute = (handler: (req: express.Request, res: express.Response) => Promise<unknown>) =>
    (req: express.Request, res: express.Response, next: express.NextFunction) => { Promise.resolve(handler(req, res)).catch(next); };
  const getBatch = (id: string) => {
    const batch = isBatchId(id) ? batches.get(id) : undefined;
    if (!batch) throw new ImportError(404, "批次不存在");
    if (batch.ledgerProfile !== profile()) throw new ImportError(409, "此批次属于另一个账本，请先切换回去");
    return batch;
  };
  const requireRevision = (batch: StoredBatch, value: unknown) => {
    if (!Number.isInteger(value) || value !== batch.revision) throw new ImportError(409, "批次已被更新，请重新加载");
  };
  const saveBatchRevision = (batch: StoredBatch) => {
    batch.revision++;
    delete batch.preview;
    batches.save(batch);
  };
  const publicBatch = (batch: StoredBatch) => {
    const counterparts = matchWechatRefunds(batch.txs);
    const txs = counterparts.size ? batch.txs.map((tx) => {
      const refundCounterpartId = counterparts.get(tx.id);
      return refundCounterpartId ? { ...tx, refundCounterpartId } : tx;
    }) : batch.txs;
    return { ...batch, file: batchFileLabel(batch), txs, errors: publicParseErrors(batch.errors), preview: undefined, pdfUploads: undefined, ledgerProfile: undefined, parseStats: stats(batch) };
  };
  const publicReviewBatch = (batch: StoredBatch) => {
    const existence = new Map<string, boolean>();
    const txs = batch.txs.map((tx) => {
      if (!tx.matches?.some((match) => match.id.startsWith("batch:"))) return tx;
      const matches = tx.matches.filter((match) => {
        if (!match.id.startsWith("batch:")) return true;
        const id = match.id.split(":")[1];
        if (!existence.has(id)) existence.set(id, batches.has(id));
        return existence.get(id);
      });
      if (matches.length === tx.matches.length) return tx;
      const issues = matches.some((match) => match.id.startsWith("batch:")) ? tx.issues : tx.issues?.filter((issue) => !otherBatchIssue(issue));
      return { ...tx, matches, issues };
    });
    return publicBatch({ ...batch, txs });
  };
  const publicConfig = () => ({ ...config, nativePathPicker: process.platform === "win32", llm: { ...config.llm, apiKey: "" } });
  const lockBatch = (id: string) => {
    if (!isBatchId(id)) throw new ImportError(404, "批次不存在");
    return acquireWriteLock(path.join(dataDir, "locks", "batches", `${id}.json`), "批次正在处理，请稍后重试");
  };
  const withBatchWrite = (handler: (req: express.Request, res: express.Response, batch: StoredBatch) => void) =>
    (req: express.Request, res: express.Response) => {
      const id = req.params.id;
      const release = lockBatch(id);
      try { handler(req, res, getBatch(id)); }
      finally { release(); }
    };

  app.get("/api/health", (_req, res) => res.json({ ok: true }));
  app.get("/api/batches", (_req, res) => {
    if (!config.ledgerRoot) { res.json([]); return; }
    const currentProfile = profile();
    res.json(batches.list().filter((batch) => batch.ledgerProfile === currentProfile && batch.txs.some(isParsedStatementRow)).map((batch) => ({
      batchId: batch.batchId, file: batchFileLabel(batch), createdAt: batch.createdAt, revision: batch.revision, committed: batch.committed,
      txCount: batch.txCount ?? batch.txs.filter((tx) => !tx.merge).length,
    })));
  });
  app.post("/api/upload", upload.array("files"), asyncRoute(async (req, res) => {
    const files = (req.files as Express.Multer.File[]) ?? [];
    if (!files.length) throw new ImportError(400, "请选择账单文件");
    const importedFiles = new Map<string, string>();
    let batchSaved = false;
    try {
      const uploadConfig = structuredClone(config), uploadRoot = ledgerRoot();
      const uploadProfile = profileId(uploadRoot, uploadConfig.mainFile);
      const currentLedger = parseLedger(uploadRoot, uploadConfig.mainFile, uploadConfig.pythonPath);
      const memory = loadMemory(path.join(dataDir, "profiles", uploadProfile, "memory.json"));
      const txs: ParsedTx[] = [], errors: ImportPreview["errors"] = [];
      const pdfUploads: Record<string, string> = {};
      const instances = new Map<string, number>(), sources = new Set<ImportPreview["source"]>();
      let wechatRules: ReturnType<typeof loadWechatRules> | undefined;
      for (const file of files) {
        const name = filename(file.originalname);
        try {
          const bytes = fs.readFileSync(file.path);
          const sourceFileHash = crypto.createHash("sha256").update(bytes).digest("hex");
          const pdf = name.toLowerCase().endsWith(".pdf");
          let result;
          if (pdf) result = await parsePdfBank(file.path, detectBank(name, [])?.source ?? "bank-generic", undefined, bytes);
          else if (isAlipay(file.path, name)) result = parseAlipay(file.path);
          else if (isWechat(name)) result = parseWechat(file.path, wechatRules ??= loadWechatRules());
          else if (isYunshanfu(name)) result = parseYunshanfu(file.path);
          else { const { rows } = readSheet(file.path); const bank = detectBank(name, rows); if (bank) result = parseBank(file.path, bank); }
          if (!result) {
            errors.push({ row: 0, message: `${name}：无法识别文件类型，请使用已解压的 CSV/XLSX/PDF` });
            continue;
          }
          const failure = result.errors.find(({ row }) => row === 0);
          if (failure || !result.txs.some(isParsedStatementRow)) {
            const reason = failure?.message ?? (result.errors.length
              ? "未读取到有效交易。请核对账单内容后重新上传。" : "未找到交易明细。请选择包含交易记录的原始账单。");
            errors.push({ row: 0, message: `${name}：${reason}` });
            continue;
          }
          const imported = result.txs.map((raw): ParsedTx => {
            const tx: ParsedTx = { ...raw, sourceFile: name, sourceFileHash,
              status: raw.excludedReason ? "excluded" : "pending", fundingAccount: "", suggestedAccount: "", confidence: 0, finalAccount: "", tags: [], flag: "*" };
            const funding = inferFundingAccount(tx, uploadConfig, currentLedger);
            tx.fundingAccount = funding.account; tx.fundingConfidence = funding.confidence; tx.fundingReason = funding.reason;
            // Unmapped rows are matched against the current rules during funding preflight.
            if (!funding.account) delete tx.recognition;
            tx.issues = [...new Set([...(raw.issues ?? []), ...(funding.issues ?? [])])];
            const local = classifyLocal(tx, memory, currentLedger);
            if (local) { tx.suggestedAccount = local.account; tx.confidence = local.confidence; tx.reason = local.reason; }
            return tx;
          });
          for (const tx of imported) {
            const occurrence = (instances.get(tx.id) ?? 0) + 1;
            instances.set(tx.id, occurrence);
            if (occurrence > 1) tx.id = `${tx.id}:${occurrence}`;
            txs.push(tx);
          }
          for (const error of result.errors) errors.push({ ...error, message: `${name}：${error.message}` });
          if (pdf) pdfUploads[sourceFileHash] = file.filename;
          importedFiles.set(file.path, name);
          sources.add(result.source);
        } catch (error) {
          console.error(`Could not import statement ${name}`, error);
          errors.push({ row: 0, message: `${name}：${STATEMENT_RETRY_HINT}` });
        }
      }
      if (!importedFiles.size) throw new ImportError(422, "未导入任何账单。", errors.map(({ message }) => message));

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
      const batch = batches.create({ file: [...importedFiles.values()].join(", "), source: sources.size === 1 ? [...sources][0] : "unknown",
        txCount: txs.length, txs: deduped.txs, errors,
        accountsDetected: detectAccounts(deduped.txs),
        ...(Object.keys(pdfUploads).length ? { pdfUploads } : {}),
        ledgerProfile: uploadProfile, ledgerErrors: currentLedger.errors ?? [], dedup: { ...deduped.stats, transferPairs: paired.pairs.length, familyCardPairs: paired.familyCardPairs } });
      batchSaved = true;
      res.json({ batchId: batch.batchId, revision: batch.revision, preview: { ...publicBatch(batch), txs: undefined, lowConfidence: batch.txs.filter((tx) => tx.status === "pending").length } });
    } finally {
      for (const file of files) {
        if (batchSaved && importedFiles.has(file.path)) continue;
        try { fs.rmSync(file.path, { force: true }); }
        catch (error) { console.error("Could not remove unused statement upload", error); }
      }
    }
  }));
  app.get("/api/batch/:id", (req, res) => {
    res.json(publicReviewBatch(getBatch(req.params.id)));
  });
  app.get("/api/batch/:id/pdf-preview/:txId", asyncRoute(async (req, res) => {
    const batch = getBatch(req.params.id);
    const tx = batch.txs.find(({ id }) => id === req.params.txId);
    if (!tx) throw new ImportError(404, "找不到这笔交易。");
    const preview = await loadPdfPreview(batch, tx);
    res.set("Cache-Control", "no-store").json(preview);
  }));
  app.post("/api/batch/:id/recheck-ledger", asyncRoute(async (req, res) => {
    const requested = getBatch(req.params.id);
    if (requested.committed) throw new ImportError(409, "已写入的批次不能再修改");
    requireRevision(requested, req.body?.revision);
    const currentLedger = await parseLedgerAsync(ledgerRoot(), config.mainFile, config.pythonPath);
    const release = lockBatch(requested.batchId);
    try {
      const batch = getBatch(requested.batchId);
      if (batch.committed) throw new ImportError(409, "已写入的批次不能再修改");
      requireRevision(batch, requested.revision);
      const txs = activeTransactions(batch.txs).filter((tx) => !tx.merge);
      const exclusionsChanged = applyWechatExclusions(txs, wechatRulesFor(txs));
      const result = refreshLedgerDuplicateHints(txs, currentLedger.transactions);
      const refundsChanged = syncWechatRefunds(txs);
      if (exclusionsChanged || result.changed || refundsChanged) saveBatchRevision(batch);
      res.json({ batch: publicReviewBatch(batch), suspected: result.suspected });
    } finally {
      release();
    }
  }));
  app.post("/api/batch/:id/exclude-suspected", withBatchWrite((req, res, batch) => {
    if (batch.committed) throw new ImportError(409, "已写入的批次不能再修改");
    requireRevision(batch, req.body?.revision);
    const txs = activeTransactions(batch.txs);
    const targets = txs.filter(canExcludeSuspectedDuplicate);
    for (const tx of targets) {
      tx.status = "excluded";
      delete tx.duplicateOf;
    }
    if (targets.length) {
      syncWechatRefunds(txs);
      saveBatchRevision(batch);
    }
    res.json({ batch: publicReviewBatch(batch), excluded: targets.length });
  }));
  app.delete("/api/batch/:id", withBatchWrite((req, res, batch) => {
    requireRevision(batch, req.body?.revision);
    assertBatchDeletable(batch, dataDir);
    batches.remove(batch.batchId);
    res.json({ ok: true });
  }));
  app.post("/api/batch/:id/merge", withBatchWrite((req, res, batch) => {
    if (batch.committed) throw new ImportError(409, "已写入的批次不能再修改");
    requireRevision(batch, req.body?.revision);
    const { ids, date, payee, narration } = req.body;
    if (!Array.isArray(ids) || ids.length < 2 || ids.some((id) => typeof id !== "string") || new Set(ids).size !== ids.length) {
      throw new ImportError(400, "请选择至少两笔原交易");
    }
    if (typeof payee !== "string" || !payee.trim() || payee.length > MAX_NARRATION_LENGTH
      || typeof narration !== "string" || narration.length > MAX_NARRATION_LENGTH) throw new ImportError(400, "请填写有效的合并商户和摘要");
    const selected = new Set<string>(ids);
    const txs = activeTransactions(batch.txs).filter((tx) => selected.has(tx.id));
    if (txs.length !== selected.size) throw new ImportError(409, "所选交易已变更，请重新选择");
    const counterparts = matchWechatRefunds(batch.txs);
    const rules = wechatRulesFor(txs);
    const members = txs.map((tx) => ({ ...tx, refundCounterpartId: counterparts.get(tx.id), excludedReason: tx.excludedReason || wechatExclusionReason(tx, rules) }));
    const plan = planTransactionMerge(members, currentAccountNames());
    if (plan.errors.length) throw new ImportError(422, "请先核对所选交易", plan.errors);
    const bookDate = members.every((tx) => tx.date === members[0].date) ? members[0].date : date;
    if (typeof bookDate !== "string" || !validDate(bookDate)) throw new ImportError(400, "请选择合并后的记账日期");
    const primary = plan.totals.find(({ amount }) => amount !== 0) ?? plan.totals[0];
    const merged: ParsedTx = {
      id: `merge-${crypto.randomUUID()}`, status: "pending", date: bookDate, payee: payee.trim(), narration,
      source: "merged", sourceFile: "合并交易", row: 0, note: "", rawCategory: "", rawAccount: "",
      amount: Math.abs(primary.amount), currency: primary.currency, direction: primary.amount > 0 ? "in" : "out",
      finalAccount: "", suggestedAccount: "", confidence: 0, fundingAccount: plan.funds.length === 1 ? plan.funds[0] : "",
      flag: "*", tags: [...new Set(members.flatMap((tx) => tx.tags ?? []))], postings: plan.postings,
      merge: { originals: members.map(mergeSource), totals: plan.totals },
      ...(plan.skipsPosting ? { excludedReason: "同一资金账户收支抵消" } : {}),
    };
    batch.txs.push(merged);
    saveBatchRevision(batch);
    res.json({ batch: publicReviewBatch(batch), mergedId: merged.id });
  }));
  app.post("/api/batch/:id/undo-merge", withBatchWrite((req, res, batch) => {
    if (batch.committed) throw new ImportError(409, "已写入的批次不能再修改");
    requireRevision(batch, req.body?.revision);
    const id = req.body.id;
    if (!batch.txs.some((tx) => tx.id === id && tx.merge)) throw new ImportError(404, "合并组不存在");
    batch.txs = batch.txs.filter((tx) => tx.id !== id);
    saveBatchRevision(batch);
    res.json({ batch: publicReviewBatch(batch) });
  }));
  app.post("/api/batch/:id/funding", (req, res) => {
    const batch = getBatch(req.params.id);
    requireRevision(batch, req.body?.revision);
    const txs = batch.committed ? [] : activeTransactions(batch.txs).filter((tx) => !tx.merge);
    const rules = wechatRulesFor(txs);
    const exclusionsChanged = applyWechatExclusions(txs, rules);
    const payments = unmappedPayments(txs, rules);
    const mappings = req.body?.mappings as FundingMappingChoice[] | undefined;
    if (mappings !== undefined && (!Array.isArray(mappings) || mappings.length > payments.size
      || mappings.some((item) => !item || !payments.has(item.id) || typeof item.account !== "string")
      || new Set(mappings.map((item) => item.id)).size !== mappings.length)) throw new ImportError(400, "资金映射无效");
    const refundsChanged = !payments.size && syncWechatRefunds(txs);
    if (!payments.size && !exclusionsChanged && !refundsChanged) { res.json({ groups: [] }); return; }

    const currentLedger = payments.size ? ledger() : undefined;
    const available = currentLedger?.accounts.filter(({ account }) => isFundingAccount(account)) ?? [];
    const choices = new Map(mappings?.map(({ id, account }) => [id, account]));
    const groups: FundingMappingGroup[] = [];
    const resolved = new Map<ParsedTx, string>();
    let assetMapping = config.assetMapping;
    for (const [id, payment] of payments) {
      const { raw, fromFile, txs } = payment;
      const { source, sourceFile } = txs[0];
      const accounts = available.filter((account) => txs.every((tx) => accountIsActive(account, tx.date, tx.currency))).map((account) => account.account);
      const guesses = new Set(txs.map((tx) => inferFundingAccount(tx, config, currentLedger).account));
      const [guess] = guesses;
      const existing = guesses.size === 1 && accounts.includes(guess) ? guess : "";
      const choice = choices.get(id);
      if (choice !== undefined && !accounts.includes(choice)) throw new ImportError(400, `账户不可用：${fromFile ? sourceFile : raw}`);
      if (choice && existing && choice !== existing) throw new ImportError(409, "账户映射已更新");
      if (!existing) groups.push({ id, label: fromFile ? sourceFile : raw, source, count: txs.length, accounts, statementOnly: fromFile || undefined });
      const account = existing || choice;
      if (!account) continue;
      for (const tx of txs) resolved.set(tx, account);
      if (!existing && !fromFile) {
        assetMapping = setExactFundingMapping(assetMapping, source, raw, account);
      }
    }
    if (groups.some(({ id }) => !choices.has(id))) { res.json({ groups }); return; }

    for (const [tx, account] of resolved) {
      confirmFundingAccount(tx, account);
      tx.issues = tx.issues?.filter((issue) => !fundingMappingIssue(issue));
    }
    // Matching can use the new funding accounts before review starts. Resumed batches keep prior review decisions.
    if (batch.revision === 1 && currentLedger) {
      for (const tx of batch.txs) {
        delete tx.matches;
        delete tx.duplicateOf;
        tx.issues = tx.issues?.filter((issue) => !duplicateReviewIssue(issue) && !transferPairIssue(issue) && !otherBatchIssue(issue));
        tx.status = tx.excludedReason ? "excluded" : tx.status === "ready" ? "ready" : "pending";
      }
      suggestRefundsFromBatch(batch.txs, currentLedger);
      const deduped = markDuplicates(batch.txs, currentLedger.transactions), paired = pairTransfers(batch.txs);
      referenceUncommittedBatches(batch.txs, batches.list().filter((item) => item.batchId !== batch.batchId && item.ledgerProfile === batch.ledgerProfile));
      batch.dedup = { ...deduped.stats, transferPairs: paired.pairs.length, familyCardPairs: paired.familyCardPairs };
    } else if (currentLedger) {
      refreshLedgerDuplicateHints(txs, currentLedger.transactions);
    }
    const release = lockBatch(batch.batchId);
    try {
      const latest = getBatch(batch.batchId);
      requireRevision(latest, batch.revision);
      if (latest.committed) throw new ImportError(409, "已写入的批次不能再修改");
      if (assetMapping !== config.assetMapping) {
        const candidate = { ...config, assetMapping };
        saveConfig(candidate, { activeLedgerFile: options.activeLedgerFile });
        config = candidate;
      }
      if (payments.size) syncWechatRefunds(txs);
      batch.accountsDetected = detectAccounts(batch.txs.filter((tx) => !tx.merge));
      saveBatchRevision(batch);
    } finally {
      release();
    }
    res.json({ batch: publicBatch(batch), groups: [], config: publicConfig() });
  });
  app.post("/api/batch/:id/funding-mapping", withBatchWrite((req, res, batch) => {
    if (batch.committed) throw new ImportError(409, "已写入的批次不能再修改");
    requireRevision(batch, req.body?.revision);
    const txs = activeTransactions(batch.txs);
    const tx = txs.find(({ id }) => id === req.body?.id);
    if (!tx) throw new ImportError(404, "交易不存在");
    const payment = reusablePaymentMethod(tx);
    if (!payment) throw new ImportError(422, "账单缺少可保存的单一付款方式");
    if (!hasFundingPosting(tx)) throw new ImportError(422, "请先在拆分分录中核对资金账户");
    const accountName: unknown = req.body?.account;
    if (typeof accountName !== "string" || !isFundingAccount(accountName) || accountName === tx.fundingAccount2) {
      throw new ImportError(422, "请选择可用的资金账户");
    }
    const currentLedger = ledger();
    const account = currentLedger.accounts.find((entry) => entry.account === accountName);
    if (!account || !accountIsActive(account, tx.date, tx.currency)) throw new ImportError(422, "资金账户在该交易日期或币种下不可用");

    const key = normalizePaymentMethod(payment);
    const affected = txs.filter((other) => other === tx || (other.source === tx.source
      && (other.fundingConfidence ?? 1) < 1 && !other.postings && !other.fundingAccount2 && !other.excludedReason
      && (other.status === "pending" || other.status === "ready") && accountIsActive(account, other.date, other.currency)
      && normalizePaymentMethod(reusablePaymentMethod(other)) === key));
    for (const other of affected) {
      confirmFundingAccount(other, accountName);
      other.issues = other.issues?.filter((issue) => !fundingMappingIssue(issue));
    }
    refreshLedgerDuplicateHints(affected, currentLedger.transactions);
    syncWechatRefunds(txs);
    batch.accountsDetected = detectAccounts(batch.txs.filter((entry) => !entry.merge));
    const candidate = { ...config, assetMapping: setExactFundingMapping(config.assetMapping, tx.source, payment, accountName) };
    saveConfig(candidate, { activeLedgerFile: options.activeLedgerFile });
    config = candidate;
    saveBatchRevision(batch);
    res.json({ batch: publicReviewBatch(batch), config: publicConfig(), updated: affected.length });
  }));
  app.post("/api/batch/:id/decide", withBatchWrite((req, res, batch) => {
    if (batch.committed) throw new ImportError(409, "已写入的批次不能再修改");
    requireRevision(batch, req.body.revision);
    const requested = req.body.decisions as TxDecision[];
    if (!Array.isArray(requested) || requested.length > 5000) throw new ImportError(400, "审阅决策格式无效");
    const decisions: TxDecision[] = [];
    const active = activeTransactions(batch.txs);
    const txById = new Map(active.map((tx) => [tx.id, tx]));
    let names: Set<string> | undefined;
    const hasAccount = (name: string) => (names ??= currentAccountNames()).has(name);
    for (const input of requested) {
      const tx = input && typeof input.id === "string" ? txById.get(input.id) : undefined;
      if (!tx) throw new ImportError(400, "交易不存在");
      const { categoryAllocations, ...changes } = input;
      if (tx.merge && (categoryAllocations !== undefined || changes.account !== undefined || changes.funding !== undefined || changes.postings !== undefined)) {
        throw new ImportError(422, "要调整分录，请先撤销合并并编辑原交易");
      }
      let decision = changes;
      if (categoryAllocations !== undefined) {
        if (!Array.isArray(categoryAllocations) || categoryAllocations.length > MAX_CATEGORY_ALLOCATIONS
          || categoryAllocations.some((part) => !part || typeof part.account !== "string" || typeof part.amount !== "string")
          || changes.account !== undefined || changes.funding !== undefined || changes.postings !== undefined) {
          throw new ImportError(400, "分类拆分格式无效");
        }
        if (tx.postings && !savedCategoryAllocations(tx)) throw new ImportError(422, "请在详情中核对这笔交易的分录");
        const plan = planCategoryAllocations(tx, categoryAllocations);
        if (!plan.postings) throw new ImportError(422, plan.error || "分类拆分无效");
        if (!hasAccount(tx.fundingAccount)) throw new ImportError(400, "资金账户必须来自当前账本");
        decision = categoryAllocations.length === 1
          ? { ...changes, account: categoryAllocations[0].account, postings: null }
          : { ...changes, postings: plan.postings };
      }
      if (decision.status !== undefined && !STATUSES.has(decision.status)) throw new ImportError(400, "无效的审阅状态");
      const nextStatus = decision.status ?? (decision.account === undefined ? undefined : "ready");
      if (tx.excludedReason && nextStatus && nextStatus !== "excluded") throw new ImportError(422, `这笔交易已排除（${tx.excludedReason}）`);
      if (decision.account !== undefined && (typeof decision.account !== "string" || !hasAccount(decision.account))) throw new ImportError(400, "分类账户必须来自当前账本");
      if (decision.funding !== undefined && (typeof decision.funding !== "string" || !/^(Assets|Liabilities):/.test(decision.funding) || !hasAccount(decision.funding))) throw new ImportError(400, "资金账户必须来自当前账本的资产或负债账户");
      if (decision.tags !== undefined && (!Array.isArray(decision.tags) || decision.tags.length > 40 || decision.tags.some((tag) => typeof tag !== "string" || tag.length > 64 || !TAG_RE.test(tag)))) throw new ImportError(400, "标签格式无效");
      if (decision.flag !== undefined && decision.flag !== "*" && decision.flag !== "!") throw new ImportError(400, "标记应为 * 或 !");
      if (decision.reviewNote !== undefined && (typeof decision.reviewNote !== "string" || decision.reviewNote.length > 2000)) throw new ImportError(400, "备注最多 2000 字符");
      if (decision.narration != null && (typeof decision.narration !== "string" || decision.narration.length > MAX_NARRATION_LENGTH)) {
        throw new ImportError(400, `账本摘要最多 ${MAX_NARRATION_LENGTH} 字符`);
      }
      if (decision.postings !== undefined && decision.postings !== null && (!Array.isArray(decision.postings) || decision.postings.length < 2 || decision.postings.length > 40 || decision.postings.some((posting) => !posting || !hasAccount(posting.account) || !Number.isFinite(posting.amount) || typeof posting.currency !== "string" || !/^[A-Z][A-Z0-9._'-]{0,23}$/.test(posting.currency)))) throw new ImportError(400, "拆分分录必须包含有效账本账户、金额和币种");
      decisions.push(decision);
    }
    const changesOnly = req.body.changesOnly === true;
    const before = changesOnly ? publicBatch(batch).txs.map((tx) => ({ ...tx })) : undefined;
    let memory: ReturnType<typeof loadMemory> | undefined;
    for (const decision of decisions) {
      const tx = txById.get(decision.id)!;
      if (tx.source === "wechat" && tx.eventType === "refund"
        && (decision.account !== undefined || decision.status !== undefined || decision.postings !== undefined)) tx.refundReviewMode = "manual";
      if (decision.account !== undefined) {
        const account = decision.account;
        if (tx.postings) tx.postings = tx.postings.map((posting) => posting.account === tx.finalAccount ? { ...posting, account } : posting);
        tx.finalAccount = account;
        if (/^(Expenses|Income):/.test(account)) {
          memory ??= loadMemory(memoryFile());
          memory.mapping[`${tx.payee.replace(/\s+/g, "").slice(0, 32)}|${tx.rawCategory.slice(0, 24)}`] = account;
        }
      }
      if (decision.funding !== undefined) confirmFundingAccount(tx, decision.funding);
      if (decision.tags !== undefined) tx.tags = [...new Set(decision.tags)];
      if (decision.flag !== undefined) tx.flag = decision.flag;
      if (decision.reviewNote !== undefined) tx.reviewNote = decision.reviewNote;
      if (decision.narration === null) delete tx.narration;
      else if (decision.narration !== undefined) tx.narration = decision.narration;
      if (decision.postings === null) { delete tx.postings; delete tx.fundingAccount2; }
      else if (decision.postings !== undefined) { tx.postings = decision.postings; delete tx.fundingAccount2; }
      if (decision.status !== undefined) tx.status = decision.status;
      else if (decision.account !== undefined) tx.status = "ready";
      if (tx.status !== "duplicate") delete tx.duplicateOf;
    }
    syncWechatRefunds(active);
    saveBatchRevision(batch);
    if (memory) saveMemory(memoryFile(), memory);
    const reviewed = publicReviewBatch(batch);
    const result = { ok: true, revision: reviewed.revision, ready: reviewed.parseStats.ready };
    if (before) {
      const txs = reviewed.txs.filter((tx, index) => {
        const previous = before[index];
        const fields = Object.keys(previous) as Array<keyof ParsedTx>;
        return fields.length !== Object.keys(tx).length || fields.some((field) => previous[field] !== tx[field]);
      });
      res.json({ ...result, changes: { txs, parseStats: reviewed.parseStats } });
    } else res.json({ ...result, batch: reviewed });
  }));
  app.post("/api/batch/:id/generate", withBatchWrite((req, res, batch) => {
    requireRevision(batch, req.body.revision);
    if (batch.committed) throw new ImportError(409, "该批次已经写入");
    const directoryError = importDirectoryError(config.monthlyDir);
    if (directoryError) throw new ImportError(400, directoryError);
    const currentLedger = ledger(), result = generateEntries(batch.txs, batch.batchId, config);
    const defined = new Set(currentLedger.accounts.map((account) => account.account));
    const opens = suggestOpens(batch.txs, defined);
    // draftErrors rejects undefined accounts; those the opens list will create
    // (e.g. the family-card payer's card) are fine — commit writes the opens.
    const opening = new Set(opens.map((line) => line.split(" open ")[1]));
    const errors = [...draftErrors(activeTransactions(batch.txs), currentLedger, opening), ...(result.errors ?? [])];
    if (!result.generated.length && !errors.length) errors.push("没有标记入账的交易，请先审批");
    if (errors.length) { delete batch.preview; batches.save(batch); res.status(422).json({ error: "请先修正以下问题", errors, details: errors, revision: batch.revision }); return; }
    batch.preview = { revision: batch.revision, result, opens }; batches.save(batch);
    const { files, ...preview } = result;
    res.json({ ...preview, targetFiles: Object.keys(files), generated: result.generated.length, opens, revision: batch.revision, baselineErrors: currentLedger.errors ?? [] });
  }));
  app.post("/api/batch/:id/commit", withBatchWrite((req, res, batch) => {
    if (!batch.committed) requireRevision(batch, req.body.revision);
    const result = commitBatch(batch, config, ledgerRoot(), dataDir);
    batch.committed = true; batch.committedAt ??= new Date().toISOString(); batch.written = result.written; batches.save(batch);
    res.json(result);
  }));
  app.get("/api/ledger", asyncRoute(async (_req, res) => {
    if (!config.ledgerRoot) { res.json({ accountCount: 0, txCount: 0, accounts: [] }); return; }
    const root = ledgerRoot();
    const { mainFile, pythonPath } = config;
    const key = catalogKey(root, mainFile, pythonPath);
    const current = await parseLedgerAsync(root, mainFile, pythonPath, true);
    rememberAccountNames(key, current);
    res.json({ accountCount: current.accounts.length, txCount: current.transactions.length, accounts: current.accounts,
      errors: current.errors ?? [], loader: current.loader, ledgerRoot: root, mainFile });
  }));
  app.get("/api/validate", (_req, res) => {
    const result = validateLedgerFile(path.resolve(ledgerRoot(), config.mainFile), config.pythonPath);
    res.json({ ...result, available: true, output: result.errors.length ? result.errors.map((error) => `${error.file ?? ""}:${error.line ?? ""} ${error.message}`).join("\n") : "原生 Beancount 校验通过" });
  });
  app.get("/api/config", (_req, res) => res.json(publicConfig()));
  let pickingPath = false;
  app.post("/api/config/pick-path", asyncRoute(async (req, res) => {
    if (!req.is("application/json") || !isLocalRequest(req)) {
      throw new ImportError(403, "只能从本机页面打开路径选择窗口");
    }
    if (process.platform !== "win32") throw new ImportError(501, "路径选择需要在 Windows 桌面上运行");
    const { kind, current, ledgerDirectory } = req.body ?? {};
    if ((kind !== "ledgerRoot" && kind !== "pythonPath") || typeof current !== "string" || typeof ledgerDirectory !== "string" ||
      [current, ledgerDirectory].some((value) => value.length > 32767 || value.includes("\0"))) {
      throw new ImportError(400, "无效的路径选择请求");
    }
    if (pickingPath) throw new ImportError(409, "请先关闭已打开的路径选择窗口");
    const initial = kind === "ledgerRoot" ? path.resolve(ROOT, current.trim()) : current.trim();
    const fallback = kind === "ledgerRoot" ? ROOT : path.resolve(ROOT, ledgerDirectory.trim());
    const controller = new AbortController();
    res.once("close", () => controller.abort());
    pickingPath = true;
    try {
      const { stdout } = await runFile("pwsh.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-File", path.join(ROOT, "scripts", "pick-path.ps1")], {
        windowsHide: true, timeout: 300_000, signal: controller.signal, encoding: "utf8",
        env: { ...process.env, BEAN_IMPORT_PICKER_KIND: kind, BEAN_IMPORT_PICKER_INITIAL: initial, BEAN_IMPORT_PICKER_FALLBACK: fallback },
      });
      res.json({ path: stdout || null });
    } catch (error) {
      if (!controller.signal.aborted) {
        const failure = error as NodeJS.ErrnoException & { killed?: boolean };
        const message = failure.killed ? "路径选择已超时" : failure.code === "ENOENT"
          ? "找不到 PowerShell 7（pwsh.exe），可手动输入路径" : "无法打开 Windows 路径选择窗口，可手动输入路径";
        throw new ImportError(500, message);
      }
    } finally {
      pickingPath = false;
    }
  }));
  app.post("/api/config", (req, res) => {
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) throw new ImportError(400, "设置格式无效");
    const patch = req.body as Partial<AppConfig>;
    const ledgerDirectory = patch.ledgerRoot === undefined ? config.ledgerRoot : patch.ledgerRoot;
    if (typeof ledgerDirectory !== "string" || !ledgerDirectory.trim()) throw new ImportError(400, "账本目录无效");
    const root = path.resolve(ROOT, ledgerDirectory);
    const switchingDirectory = !config.ledgerRoot || path.relative(ledgerRoot(), root) !== "";
    const existing = switchingDirectory ? readLedgerSettings(root) : undefined;
    const base = existing ? configWithDefaults(ledgerDirectory, existing) : config;
    const candidate = { ...base, ...patch, ledgerRoot: ledgerDirectory, llm: { ...base.llm, ...patch.llm } };
    if (typeof candidate.mainFile !== "string" || typeof candidate.monthlyDir !== "string" || (candidate.pythonPath !== undefined && typeof candidate.pythonPath !== "string")) throw new ImportError(400, "账本路径配置无效");
    const directoryError = importDirectoryError(candidate.monthlyDir);
    if (directoryError) throw new ImportError(400, directoryError);
    const main = path.resolve(root, candidate.mainFile);
    const relativeMain = path.relative(root, main);
    if (!relativeMain || relativeMain === ".." || relativeMain.startsWith(`..${path.sep}`) || path.isAbsolute(relativeMain) || !fs.existsSync(main)) throw new ImportError(400, "账本主文件不存在或位于账本目录外");
    if (!Array.isArray(candidate.assetMapping) || candidate.assetMapping.some((mapping) => !mapping || typeof mapping.keyword !== "string" || !mapping.keyword.trim() || typeof mapping.account !== "string" || !["credit", "debit"].includes(mapping.kind) || (mapping.cardSuffix !== undefined && (typeof mapping.cardSuffix !== "string" || !/^\d{0,6}$/.test(mapping.cardSuffix))))) throw new ImportError(400, "资金映射需要有效关键词、账户、借贷类型及可选卡片尾号");
    if (typeof candidate.annualLayout !== "boolean" && candidate.annualLayout !== undefined) throw new ImportError(400, "年度布局配置无效");
    const current = parseLedger(root, candidate.mainFile, candidate.pythonPath), defined = new Set(current.accounts.filter((account) => /^(Assets|Liabilities):/.test(account.account)).map((account) => account.account));
    const switched = !config.ledgerRoot || profileId(root, candidate.mainFile) !== profile();
    if (!switched && patch.assetMapping !== undefined && candidate.assetMapping.some((mapping) => !defined.has(mapping.account))) throw new ImportError(400, "资金映射账户必须在目标账本中定义");
    candidate.assetMapping = candidate.assetMapping.filter((mapping) => defined.has(mapping.account)).map((mapping) => ({ ...mapping, keyword: mapping.keyword.trim(), cardSuffix: mapping.cardSuffix || undefined }));
    candidate.accounts = current.accounts.map((account) => account.account).sort();
    saveConfig(candidate, {
      activeLedgerFile: options.activeLedgerFile,
      migratedFrom: !options.config && !config.ledgerRoot && !existing ? dataDir : undefined,
    });
    config = candidate;
    res.json(publicConfig());
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
    if (failure) {
      console.error("Could not start Fava", failure);
      res.json({ running: false, port: 5000, error: "无法启动 Fava。请确认账本使用的 Python 环境已安装 Fava，再重试。" });
      return;
    }
    fava = proc; proc.once("exit", () => { if (fava === proc) fava = undefined; }); res.json({ running: true, port: 5000 });
  }));
  const frontend = path.join(ROOT, "web-dist");
  if (fs.existsSync(path.join(frontend, "index.html"))) {
    app.use(express.static(frontend));
    app.get("*", (req, res) => req.path.startsWith("/api/") ? res.status(404).json({ error: "接口不存在" }) : res.sendFile(path.join(frontend, "index.html")));
  }
  app.use((error: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent) { next(error); return; }
    if (error instanceof ImportError) { res.status(error.status).json({ error: error.message, details: error.details }); return; }
    if (error instanceof multer.MulterError) {
      const message = error.code === "LIMIT_FILE_SIZE" ? `单个账单最多 ${MAX_STATEMENT_MB} MB。请拆分后上传。`
        : error.code === "LIMIT_FILE_COUNT" ? `每次最多上传 ${MAX_STATEMENT_FILES} 个账单。请分批上传。` : "上传中断。请重新选择账单文件后上传。";
      res.status(400).json({ error: message });
      return;
    }
    console.error(`Could not handle ${req.method} ${req.path}`, error);
    const message = error instanceof LedgerAccessError ? error.hint
      : req.path === "/api/upload" ? "暂时无法导入账单。请重新上传。" : "暂时无法完成操作。请重试。";
    res.status(500).json({ error: message });
  });
  return app;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 8787);
  createApp({ activeLedgerFile: defaultActiveLedgerFile() }).listen(port, "127.0.0.1", () => { console.log(`bean-import → http://localhost:${port}`); });
}
