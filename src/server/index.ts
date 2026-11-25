import express from "express";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import multer from "multer";
import type { AppConfig, AutomaticExclusionRule, BatchRevision, FundingMappingChoice, FundingMappingGroup, ImportPreview, ParsedTx, ReviewProblem, TxDecision, LedgerInfo } from "../shared/types.js";
import { duplicateReviewIssue, isFamilyCard, MAX_NARRATION_LENGTH } from "../shared/types.js";
import { planSuspectedDuplicateExclusions } from "../shared/duplicateExclusions.js";
import { reviewStatusPatch } from "../shared/exclusions.js";
import { CNY_SETTLEMENT_REQUIRED, needsCnySettlement, originalForeignAmount, readCnySettlementAmount } from "../shared/settlement.js";
import { MAX_CATEGORY_ALLOCATIONS, planCategoryAllocations, savedCategoryAllocations } from "../shared/categoryAllocations.js";
import { activeTransactions, mergeSource, planTransactionMerge } from "../shared/transactionMerge.js";
import { FUNDING_SPLIT_REQUIRED, missingPostingAccount, missingPostingAccountMessage, requiresFundingSplit, statusAfterCategorization, validDate } from "../shared/postings.js";
import { hasFundingPosting, isFundingAccount, isStatementOnlyPayment, reusablePaymentMethod } from "../shared/funding.js";
import { configWithDefaults, defaultActiveLedgerFile, loadConfig, readLedgerSettings, saveConfig } from "./config.js";
import { discoverPython, LedgerAccessError, parseLedger, parseLedgerAsync, validateLedgerFile } from "./lib/ledger.js";
import { markDuplicates, refreshLedgerDuplicateHints, sourceKey } from "./lib/dedup.js";
import { matchStatementRefunds, restoreFullRefundPurchases, syncStatementRefunds } from "./lib/refunds.js";
import { availableReviewUndo, rememberReviewStatusChange, reviewStatuses } from "./lib/review-undo.js";
import { classificationMemoryKey, classificationMemoryLocation, classifyLocal, classifyWithLlm, loadMemory, saveMemory, suggestRefundsFromBatch } from "./lib/classify.js";
import {
  accountIsActive, confirmFundingAccount, detectAccounts, fundingMappingIssue, inferFundingAccount, isMissingPaymentMethod,
  isPaymentAccountPart, matchFundingAccount, normalizePaymentMethod, setExactFundingMapping, singlePaymentMethod, unallocatedFundingParts,
} from "./lib/accounts.js";
import { generateEntries, suggestOpens, transactionPostings } from "./lib/generate.js";
import { alipayWalletExclusion, isAlipay, parseAlipay } from "./parsers/alipay.js";
import { isWechat, parseWechat } from "./parsers/wechat.js";
import { loadWechatRules, recognizeWechatTransaction, wechatExclusionReason } from "./parsers/wechat-rules.js";
import { parseYunshanfu, isYunshanfu } from "./parsers/yunshanfu.js";
import { detectBank, parseBank } from "./parsers/banks.js";
import { parsePdfBank, PDF_RETRY_HINT } from "./parsers/pdf.js";
import { pairTransfers, transferPairIssue } from "./lib/transfers.js";
import { isParsedStatementRow, parseFundingParts, readSheet, UNREADABLE_TRANSACTION } from "./parsers/common.js";
import { BatchStore, isBatchId, profileId, type StoredBatch, type StoredPdfUpload } from "./lib/batches.js";
import { applyStatementNames, combineBatchReviews, resolveBatchReviewConflict, statementsForBatches } from "./lib/batch-review-merge.js";
import { acquireWriteLock, assertBatchDeletable, commitBatch, ImportError } from "./lib/commit.js";
import { importLayoutError } from "../shared/import-paths.js";
import { isLocalRequest } from "./lib/local-request.js";
import { createPdfPreviewLoader } from "./lib/pdf-preview.js";
import { archiveStatement, ledgerUploadsDirectory } from "./lib/statement-uploads.js";
import { applyCnyReview, cnyRepayments } from "./lib/cny-settlement.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TAG_RE = /^[A-Za-z0-9][A-Za-z0-9_./-]*$/;
const STATUSES = new Set(["pending", "ready", "duplicate", "excluded"]);
const OTHER_BATCH_ISSUE = "另一个未提交批次已有此交易";
const STATEMENT_RETRY_HINT = "暂时无法读取这份账单。请重新上传，或重新导出账单后再试。";
const STATEMENT_ARCHIVE_HINT = "无法保存账单副本。请检查文件名和账本 uploads 目录的写入权限。";
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
  if (!batch.errors.length || batch.mergedFrom?.length) return batch.file;
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

function draftProblems(txs: ParsedTx[], ledger: LedgerInfo, opening: Set<string>) {
  const accounts = new Map(ledger.accounts.map((account) => [account.account, account]));
  const errors = new Set<string>();
  const problems: ReviewProblem[] = [];
  for (const tx of txs.filter((tx) => tx.status === "ready")) {
    const add = (message: string, field: ReviewProblem["field"]) => {
      errors.add(`${tx.sourceFile}:${tx.row}：${message}`);
      problems.push({ id: tx.id, field, message });
    };
    for (const [index, { account, currency }] of transactionPostings(tx).entries()) {
      const field = tx.postings ? "postings" : index === 0 ? "funding" : "category";
      const defined = accounts.get(account);
      if (!defined && !opening.has(account)) add(account ? `账户 ${account} 未在账本开户` : missingPostingAccountMessage[field], field);
      else if (defined && ((defined.openedAt && tx.date < defined.openedAt) || (defined.closedAt && tx.date > defined.closedAt))) add(`账户 ${account} 在交易日未生效`, field);
      else if (defined?.currencies?.length && !defined.currencies.includes(currency)) add(`账户 ${account} 不支持币种 ${currency}`, field);
    }
    if (tx.tags?.some((tag) => !TAG_RE.test(tag))) add("标签格式无效", "tags");
  }
  return { errors: [...errors], problems };
}

function referenceUncommittedBatches(txs: ParsedTx[], previous: StoredBatch[]) {
  const identities = new Map<string, Array<{ batch: StoredBatch; tx: ParsedTx }>>();
  for (const batch of previous.filter((batch) => !batch.committed && !batch.mergedInto && !batch.combinedFundingPending)) for (const tx of batch.txs) {
    if (tx.status === "excluded" || tx.excludedReason || tx.status === "duplicate") continue;
    const key = sourceKey(tx.source, tx.sourceTxId, tx.sourceFileHash, tx.row);
    if (!key) continue;
    const matches = identities.get(key) ?? [];
    if (matches.length < 3) matches.push({ batch, tx });
    identities.set(key, matches);
  }
  for (const tx of txs) {
    if (tx.status === "excluded" || tx.status === "duplicate" || tx.reviewConflictId) continue;
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
    delete tx.reviewExclusion;
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

function needsFundingAccount(tx: ParsedTx): boolean {
  return !tx.fundingAccount && !tx.fundingAccount2 && !tx.postings?.length && !tx.excludedReason
    && !needsCnySettlement(tx) && tx.status !== "excluded" && tx.status !== "duplicate";
}

function restoreKnownWechatFunding(txs: ParsedTx[], rules: ReturnType<typeof loadWechatRules>, config: AppConfig, ledger: LedgerInfo): boolean {
  let changed = false;
  for (const tx of txs) {
    if (tx.source !== "wechat" || !needsFundingAccount(tx)) continue;
    const recognition = recognizeWechatTransaction(tx, rules);
    if (!recognition) continue;
    const guess = inferFundingAccount({ ...tx, recognition }, config, ledger);
    if (!guess.account || guess.confidence < 1) continue;
    tx.recognition = recognition;
    confirmFundingAccount(tx, guess.account);
    tx.fundingReason = guess.reason;
    tx.issues = tx.issues?.filter((issue) => !fundingMappingIssue(issue));
    changed = true;
  }
  return changed;
}

function restoreRefundedPurchases(txs: readonly ParsedTx[], config: AppConfig, ledger: LedgerInfo): ParsedTx[] {
  const restored = restoreFullRefundPurchases(txs);
  for (const tx of restored) {
    if (tx.fundingAccount) continue;
    const guess = inferFundingAccount(tx, config, ledger);
    tx.fundingAccount = guess.account;
    tx.fundingConfidence = guess.confidence;
    tx.fundingReason = guess.reason;
    tx.issues = [...new Set([...(tx.issues ?? []).filter((issue) => !fundingMappingIssue(issue)), ...(guess.issues ?? [])])];
  }
  return restored;
}

type PaymentGroups = Map<string, { raw: string; fromFile: boolean; txs: Set<ParsedTx> }>;

function addPaymentGroup(groups: PaymentGroups, tx: ParsedTx, raw: string, fromFile = false): void {
  const id = crypto.createHash("sha256").update(JSON.stringify([tx.source, fromFile ? raw : normalizePaymentMethod(raw)])).digest("hex");
  const group = groups.get(id) ?? { raw, fromFile, txs: new Set<ParsedTx>() };
  group.txs.add(tx);
  groups.set(id, group);
}

function unmappedPayments(txs: ParsedTx[], wechatRules: ReturnType<typeof loadWechatRules>): PaymentGroups {
  const groups: PaymentGroups = new Map();
  for (const tx of txs) {
    if (!needsFundingAccount(tx)) continue;
    if (tx.source === "wechat" && isMissingPaymentMethod(tx.rawAccount)) {
      const recognition = recognizeWechatTransaction(tx, wechatRules);
      if (recognition) tx.recognition = recognition;
    }
    const raw = singlePaymentMethod(tx);
    if (raw) addPaymentGroup(groups, tx, raw, isStatementOnlyPayment(tx, raw));
  }
  return groups;
}

function alipayCombinedParts(tx: ParsedTx) {
  if (tx.source !== "alipay" || !isParsedStatementRow(tx) || isFamilyCard(tx)) return;
  const parts = tx.fundingParts ?? parseFundingParts(tx.rawAccount).fundingParts;
  if (parts && parts.length > 1) return parts;
}

function combinedFundingPayments(txs: ParsedTx[]) {
  const groups = new Map<string, { label: string; combination: string; first: boolean; txs: Set<ParsedTx> }>();
  const rows = new Map<ParsedTx, { parts: NonNullable<ParsedTx["fundingParts"]>; ids: string[] }>();
  for (const tx of txs) {
    if (tx.status !== "pending" || tx.excludedReason || tx.postings || tx.fundingAccount2
      || tx.fundingPartAccounts || (tx.fundingAccount && tx.fundingConfidence === 1)) continue;
    const parts = alipayCombinedParts(tx);
    if (!parts) continue;
    const labels = parts.map(({ rawAccount }) => rawAccount || "未标明支付方式");
    const keys = labels.map(normalizePaymentMethod);
    const key = [...keys].sort();
    const combination = labels.join(" & ");
    const ids = keys.map((label) => crypto.createHash("sha256")
      .update(JSON.stringify(["alipay-combined", key, label])).digest("hex"));
    ids.forEach((id, index) => {
      const group = groups.get(id) ?? { label: labels[index], combination, first: index === 0, txs: new Set<ParsedTx>() };
      group.txs.add(tx);
      groups.set(id, group);
    });
    rows.set(tx, { parts, ids });
  }
  return { groups, rows };
}

function statementFundingDefaults(txs: ParsedTx[]): Map<ParsedTx, string> {
  const statements = new Map<string, { accounts: Set<string>; confirmed: boolean; awaiting: ParsedTx[] }>();
  for (const tx of txs) {
    if (tx.merge || tx.reviewConflictId || tx.excludedReason || tx.status === "excluded" || tx.status === "duplicate"
      || tx.fundingAccount2 || tx.postings?.length) continue;
    const raw = singlePaymentMethod(tx);
    if (!raw || !isStatementOnlyPayment(tx, raw) || (!tx.sourceFileHash && raw === tx.sourceFile)) continue;
    const key = JSON.stringify([tx.source, tx.sourceFileHash, raw]);
    const group = statements.get(key) ?? { accounts: new Set<string>(), confirmed: false, awaiting: [] };
    if (tx.fundingAccount) {
      group.accounts.add(tx.fundingAccount);
      if (tx.currency === "CNY" && tx.fundingConfidence === 1) group.confirmed = true;
    } else if (needsCnySettlement(tx)) {
      group.awaiting.push(tx);
    }
    statements.set(key, group);
  }
  const defaults = new Map<ParsedTx, string>();
  for (const { accounts, confirmed, awaiting } of statements.values()) {
    if (!confirmed || accounts.size !== 1) continue;
    const [account] = accounts;
    for (const tx of awaiting) defaults.set(tx, account);
  }
  return defaults;
}

function applyStatementFundingDefault(tx: ParsedTx, name: string, ledger: LedgerInfo): boolean {
  if (!isFundingAccount(name) || !ledger.accounts.some((account) => account.account === name && accountIsActive(account, tx.date, "CNY"))) return false;
  confirmFundingAccount(tx, name);
  tx.issues = tx.issues?.filter((issue) => !fundingMappingIssue(issue));
  return true;
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
  const memoryLocation = () => classificationMemoryLocation(dataDir, ledgerRoot(), config.mainFile);
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
    if (!batch.committed && config.requireCnySettlement) {
      for (const tx of batch.txs) if (applyCnyReview(tx)) delete batch.preview;
      for (const conflict of batch.reviewConflicts ?? []) {
        for (const choice of conflict.choices) choice.txs.forEach(applyCnyReview);
      }
    }
    return batch;
  };
  const requireRevision = (batch: StoredBatch, value: unknown) => {
    if (!Number.isInteger(value) || value !== batch.revision) throw new ImportError(409, "批次已被更新，请重新加载");
  };
  const readReviewSessionId = (value: unknown) => {
    if (value === undefined) return;
    if (typeof value !== "string" || !/^[a-f0-9]{32}$/.test(value)) throw new ImportError(400, "审批会话无效，请重新打开审批页");
    return value;
  };
  const requireActiveBatch = (batch: StoredBatch, allowPendingFunding = false) => {
    if (batch.mergedInto) throw new ImportError(409, "此批次已合并，请打开合并后的批次");
    if (batch.combinedFundingPending && !allowPendingFunding) throw new ImportError(409, "请先完成组合支付资金映射");
  };
  const saveBatchRevision = (batch: StoredBatch) => {
    if (batch.reviewStatusHistory) {
      const undo = availableReviewUndo(batch);
      if (undo) batch.reviewStatusHistory.operations.length = undo.depth;
      else delete batch.reviewStatusHistory;
    }
    batch.revision++;
    delete batch.preview;
    batches.save(batch);
  };
  const publicBatch = (batch: StoredBatch) => {
    const active = activeTransactions(batch.txs);
    const counterparts = matchStatementRefunds(active);
    const txs = counterparts.size || batch.txs.some((tx) => tx.refundCounterpartId) ? batch.txs.map((tx) => {
      const refundCounterpartId = counterparts.get(tx.id);
      return refundCounterpartId !== tx.refundCounterpartId ? { ...tx, refundCounterpartId } : tx;
    }) : batch.txs;
    const undo = availableReviewUndo(batch, active);
    return { ...batch, file: batchFileLabel(batch), txs, errors: publicParseErrors(batch.errors),
      preview: undefined, pdfUploads: undefined, ledgerProfile: undefined, reviewStatusHistory: undefined, parseStats: stats(batch),
      reviewUndo: undo ? { sessionId: undo.history.sessionId, depth: undo.depth, action: undo.operation.action, count: undo.operation.entries.length } : undefined };
  };
  const publicReviewBatch = (batch: StoredBatch) => {
    const existence = new Map<string, boolean>();
    const txs = batch.txs.map((tx) => {
      if (!tx.matches?.some((match) => match.id.startsWith("batch:"))) return tx;
      const matches = tx.matches.filter((match) => {
        if (!match.id.startsWith("batch:")) return true;
        const id = match.id.split(":")[1];
        if (!existence.has(id)) existence.set(id, batches.has(id) && !batches.mergedInto(id));
        return existence.get(id);
      });
      if (matches.length === tx.matches.length) return tx;
      const issues = matches.some((match) => match.id.startsWith("batch:")) ? tx.issues : tx.issues?.filter((issue) => !otherBatchIssue(issue));
      return { ...tx, matches, issues };
    });
    return publicBatch({ ...batch, txs });
  };
  const publicConfig = () => ({ ...config, archiveUploadsInLedger: config.archiveUploadsInLedger ?? true,
    nativePathPicker: process.platform === "win32", llm: { ...config.llm, apiKey: "" } });
  const lockBatch = (id: string) => {
    if (!isBatchId(id)) throw new ImportError(404, "批次不存在");
    return acquireWriteLock(path.join(dataDir, "locks", "batches", `${id}.json`), "批次正在处理，请稍后重试");
  };
  const withBatchWrite = (handler: (req: express.Request, res: express.Response, batch: StoredBatch) => void) =>
    (req: express.Request, res: express.Response) => {
      const id = req.params.id;
      const release = lockBatch(id);
      try {
        const batch = getBatch(id);
        requireActiveBatch(batch, req.method === "DELETE");
        handler(req, res, batch);
      }
      finally { release(); }
    };

  const summarizeBatch = (batch: StoredBatch) => ({
    batchId: batch.batchId, file: batchFileLabel(batch), createdAt: batch.createdAt, revision: batch.revision, committed: batch.committed,
    mergedInto: batch.mergedInto, mergedFrom: batch.mergedFrom, combinedFundingPending: batch.combinedFundingPending,
    txCount: batch.txCount ?? batch.txs.filter((tx) => !tx.merge).length,
  });
  const listBatches = () => {
    if (!config.ledgerRoot) return [];
    const currentProfile = profile();
    return batches.list().filter((batch) => batch.ledgerProfile === currentProfile && batch.txs.some(isParsedStatementRow)).map(summarizeBatch);
  };
  const mergeSelection = (value: unknown): BatchRevision[] => {
    if (!Array.isArray(value) || value.length < 2 || value.some((item) =>
      !item || typeof item.batchId !== "string" || !isBatchId(item.batchId) || !Number.isInteger(item.revision))
      || new Set(value.map(({ batchId }) => batchId)).size !== value.length) {
      throw new ImportError(400, "请选择至少两个不同的导入批次");
    }
    return value;
  };
  const mergeInputs = (selection: BatchRevision[]) => selection.map(({ batchId, revision }) => {
    const batch = getBatch(batchId);
    requireActiveBatch(batch);
    requireRevision(batch, revision);
    if (batch.committed) throw new ImportError(409, "已过账的批次不能合并审批");
    assertBatchDeletable(batch, dataDir);
    return batch;
  });
  const reviewMergedTransactions = (txs: ParsedTx[], currentLedger: LedgerInfo, previous: StoredBatch[]) => {
    const active = activeTransactions(txs);
    const approved = new Set(active.filter((tx) => tx.status === "ready").map(({ id }) => id));
    for (const tx of active) {
      if (tx.reviewExclusion !== "deduplicate") delete tx.matches;
      delete tx.duplicateOf;
      tx.issues = tx.issues?.filter((issue) => !duplicateReviewIssue(issue) && !transferPairIssue(issue) && !otherBatchIssue(issue));
      if (tx.status === "duplicate") tx.status = "pending";
    }
    applyWechatExclusions(txs, wechatRulesFor(txs));
    const deduped = markDuplicates(active, currentLedger.transactions);
    const transfers = pairTransfers(active.filter((tx) => !tx.reviewConflictId));
    referenceUncommittedBatches(active, previous);
    for (const tx of active) {
      if (tx.reviewConflictId) tx.status = "pending";
      else if (approved.has(tx.id) && !tx.excludedReason && !needsCnySettlement(tx) && tx.status !== "duplicate") tx.status = "ready";
    }
    syncStatementRefunds(active, currentLedger.transactions);
    return { ...deduped.stats, transferPairs: transfers.pairs.length, familyCardPairs: transfers.familyCardPairs };
  };

  app.get("/api/health", (_req, res) => res.json({ ok: true }));
  app.get("/api/exclusion-rules", (_req, res) => {
    const rules: AutomaticExclusionRule[] = [
      { source: "支付宝", title: alipayWalletExclusion.title,
        description: `前 ${alipayWalletExclusion.receiptWindowSeconds} 秒内有且仅有一笔同金额的成功收款，且该收款只匹配这笔划转时，排除划转并保留收款。` },
      ...loadWechatRules().flatMap(({ when, exclude }) => exclude === undefined ? [] : [{
        source: "微信", title: exclude, description: [Array.isArray(when.category) ? when.category.join("、") : when.category,
          when.direction && (when.direction === "in" ? "收入" : "支出"), when.status,
          when.payeePrefix && `交易对方以「${when.payeePrefix}」开头`].filter(Boolean).join(" · "),
      }]),
      { source: "支付宝、微信", title: "交易未完成", description: "例如关闭、失败、取消、等待或处理中。" },
      { source: "支付宝、微信、银行表格", title: "零金额" },
      { source: "支付宝、微信", title: UNREADABLE_TRANSACTION },
    ];
    res.json(rules);
  });
  app.get("/api/batches", (_req, res) => res.json(listBatches()));
  app.post("/api/batches/merge-options", (req, res) => {
    const selected = mergeInputs(mergeSelection(req.body?.batches));
    res.json({ batches: selected.map(summarizeBatch), sources: statementsForBatches(selected) });
  });
  app.post("/api/batches/merge", (req, res) => {
    const selection = mergeSelection(req.body?.batches);
    const selectedIds = new Set(selection.map(({ batchId }) => batchId));
    const keep = req.body?.keepProgress;
    if (!Array.isArray(keep) || keep.some((id) => !selectedIds.has(id)) || new Set(keep).size !== keep.length) {
      throw new ImportError(400, "请选择要保留审批进度的批次");
    }
    const releases: Array<() => void> = [];
    try {
      for (const id of [...selectedIds].sort()) releases.push(lockBatch(id));
      const selected = mergeInputs(selection);
      const sources = applyStatementNames(statementsForBatches(selected), req.body?.names);
      const currentLedger = ledger(), memory = loadMemory(memoryLocation());
      const rules = wechatRulesFor(selected.flatMap(({ txs }) => txs));
      const resetReview = (original: ParsedTx): ParsedTx => {
        const tx: ParsedTx = {
          ...original, status: original.excludedReason ? "excluded" : "pending", finalAccount: "", suggestedAccount: "",
          fundingAccount: "", confidence: 0, flag: "*", tags: [],
        };
        delete tx.fundingAccount2;
        delete tx.postings;
        delete tx.reviewNote;
        delete tx.narration;
        delete tx.refundReviewMode;
        delete tx.reviewExclusion;
        delete tx.reason;
        if (tx.source === "wechat") tx.recognition = recognizeWechatTransaction(tx, rules);
        const funding = inferFundingAccount(tx, config, currentLedger);
        tx.fundingAccount = funding.account;
        tx.fundingConfidence = funding.confidence;
        tx.fundingReason = funding.reason;
        tx.issues = [...new Set([...(tx.issues ?? []).filter((issue) => !fundingMappingIssue(issue)), ...(funding.issues ?? [])])];
        const suggestion = classifyLocal(tx, memory, currentLedger);
        if (suggestion) {
          tx.finalAccount = tx.suggestedAccount = suggestion.account;
          tx.confidence = suggestion.confidence;
          tx.reason = suggestion.reason;
        }
        return tx;
      };
      const combined = combineBatchReviews(selected, new Set(keep), resetReview);
      restoreRefundedPurchases(activeTransactions(combined.txs), config, currentLedger);
      const ledgerProfile = profile();
      const previous = batches.list().filter((item) => item.ledgerProfile === ledgerProfile && !selectedIds.has(item.batchId));
      const dedup = reviewMergedTransactions(combined.txs, currentLedger, previous);
      const merged = batches.create({
        ...combined, file: "合并审批 · " + sources.length + " 份账单", source: "unknown",
        txCount: combined.txs.filter((tx) => !tx.merge).length,
        errors: selected.flatMap(({ errors }) => errors),
        accountsDetected: detectAccounts(combined.txs.filter((tx) => !tx.merge)),
        statementSources: sources, mergedFrom: [...selectedIds], ledgerProfile, ledgerErrors: currentLedger.errors ?? [], dedup,
        pdfUploads: Object.assign({}, ...selected.map(({ pdfUploads }) => pdfUploads ?? {})),
      });
      res.status(201).json({ batch: publicReviewBatch(merged), batches: listBatches() });
    } finally {
      for (const release of releases.reverse()) release();
    }
  });
  app.post("/api/upload", upload.array("files"), asyncRoute(async (req, res) => {
    const files = (req.files as Express.Multer.File[]) ?? [];
    if (!files.length) throw new ImportError(400, "请选择账单文件");
    const importedFiles = new Map<string, string>();
    const archiveCopies = config.archiveUploadsInLedger !== false;
    const archivedCopies: string[] = [];
    let batchSaved = false;
    try {
      const uploadConfig = structuredClone(config), uploadRoot = ledgerRoot();
      const archiveDirectory = ledgerUploadsDirectory(uploadRoot);
      const uploadProfile = profileId(uploadRoot, uploadConfig.mainFile);
      const currentLedger = parseLedger(uploadRoot, uploadConfig.mainFile, uploadConfig.pythonPath);
      const memory = loadMemory(classificationMemoryLocation(dataDir, uploadRoot, uploadConfig.mainFile));
      const txs: ParsedTx[] = [], errors: ImportPreview["errors"] = [];
      const pdfUploads: Record<string, StoredPdfUpload> = {};
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
            if (uploadConfig.requireCnySettlement) applyCnyReview(tx);
            const funding = inferFundingAccount(needsCnySettlement(tx) ? { ...tx, currency: "CNY" } : tx, uploadConfig, currentLedger);
            tx.fundingAccount = funding.account; tx.fundingConfidence = funding.confidence; tx.fundingReason = funding.reason;
            // Unmapped rows are matched against the current rules during funding preflight.
            if (!funding.account) delete tx.recognition;
            tx.issues = [...new Set([...(raw.issues ?? []), ...(funding.issues ?? [])])];
            const local = classifyLocal(tx, memory, currentLedger);
            if (local) { tx.suggestedAccount = local.account; tx.confidence = local.confidence; tx.reason = local.reason; }
            return tx;
          });
          let archiveName: string | undefined;
          if (archiveCopies) {
            try {
              archiveName = archiveStatement(file.path, archiveDirectory, name, sourceFileHash);
              archivedCopies.push(path.join(archiveDirectory, archiveName));
            } catch (error) {
              console.error(`Could not archive statement ${name}`, error);
              errors.push({ row: 0, message: `${name}：${STATEMENT_ARCHIVE_HINT}` });
              continue;
            }
          }
          for (const tx of imported) {
            const occurrence = (instances.get(tx.id) ?? 0) + 1;
            instances.set(tx.id, occurrence);
            if (occurrence > 1) tx.id = `${tx.id}:${occurrence}`;
            txs.push(tx);
          }
          for (const error of result.errors) errors.push({ ...error, message: `${name}：${error.message}` });
          if (pdf) pdfUploads[sourceFileHash] = archiveName ? { archiveName } : file.filename;
          importedFiles.set(file.path, name);
          sources.add(result.source);
        } catch (error) {
          console.error(`Could not import statement ${name}`, error);
          errors.push({ row: 0, message: `${name}：${STATEMENT_RETRY_HINT}` });
        }
      }
      if (!importedFiles.size) throw new ImportError(422, "未导入任何账单。", errors.map(({ message }) => message));

      const combinedFundingPending = txs.some(alipayCombinedParts);
      if (!combinedFundingPending) restoreRefundedPurchases(txs, uploadConfig, currentLedger);
      const llm = await classifyWithLlm(txs.filter((tx) => tx.status !== "excluded" && !needsCnySettlement(tx) && tx.confidence < 0.7), uploadConfig, currentLedger);
      for (const tx of txs) {
        const hit = llm.get(tx.id);
        if (hit && hit.confidence > tx.confidence) { tx.suggestedAccount = hit.account; tx.confidence = hit.confidence; tx.reason = hit.reason; }
        tx.finalAccount = tx.suggestedAccount;
        if (tx.status === "pending" && tx.confidence >= 0.9 && (tx.fundingConfidence ?? 0) >= 0.9 && !tx.issues?.length
          && !needsCnySettlement(tx) && !missingPostingAccount(tx)) tx.status = "ready";
      }
      if (!combinedFundingPending) suggestRefundsFromBatch(txs, currentLedger);
      const deduped = markDuplicates(txs, currentLedger.transactions), paired = pairTransfers(deduped.txs);
      if (profile() !== uploadProfile) throw new ImportError(409, "上传期间账本配置已切换，请在目标账本重新上传");
      if (!combinedFundingPending) {
        referenceUncommittedBatches(deduped.txs, batches.list().filter((previous) => previous.ledgerProfile === uploadProfile));
        syncStatementRefunds(txs, currentLedger.transactions);
      }
      const batch = batches.create({ file: [...importedFiles.values()].join(", "), source: sources.size === 1 ? [...sources][0] : "unknown",
        txCount: txs.length, txs: deduped.txs, errors,
        ...(combinedFundingPending && { combinedFundingPending }),
        accountsDetected: detectAccounts(deduped.txs),
        ...(Object.keys(pdfUploads).length ? { pdfUploads } : {}),
        ledgerProfile: uploadProfile, ledgerErrors: currentLedger.errors ?? [], dedup: { ...deduped.stats, transferPairs: paired.pairs.length, familyCardPairs: paired.familyCardPairs } });
      batchSaved = true;
      res.json({ batchId: batch.batchId, revision: batch.revision, preview: { ...publicBatch(batch), txs: undefined, lowConfidence: batch.txs.filter((tx) => tx.status === "pending").length } });
    } finally {
      const unused = files.filter((file) => !batchSaved || archiveCopies || !importedFiles.has(file.path)).map(({ path }) => path);
      if (!batchSaved) unused.push(...archivedCopies);
      for (const file of unused) {
        try { fs.rmSync(file, { force: true }); }
        catch (error) { console.error("Could not remove unused statement upload", error); }
      }
    }
  }));
  app.get("/api/batch/:id", (req, res) => {
    res.json(publicReviewBatch(getBatch(req.params.id)));
  });
  const settlementRow = (batch: StoredBatch, id: unknown) => {
    if (batch.committed) throw new ImportError(409, "已写入的批次不能再修改");
    const tx = activeTransactions(batch.txs).find((row) => row.id === id);
    if (!tx || !tx.requireCnySettlement || !originalForeignAmount(tx) || tx.merge || tx.reviewConflictId
      || (!needsCnySettlement(tx) && !tx.cnySettlement)
      || tx.excludedReason || tx.status === "excluded" || tx.status === "duplicate") {
      throw new ImportError(422, "这笔交易无法确认人民币金额");
    }
    return tx;
  };
  const repaymentChoices = (batch: StoredBatch, tx: ParsedTx) =>
    cnyRepayments(tx, [batch, ...batches.list().filter(({ batchId }) => batchId !== batch.batchId)], batch.ledgerProfile);
  app.get("/api/batch/:id/cny-repayments/:txId", (req, res) => {
    const batch = getBatch(req.params.id);
    requireActiveBatch(batch);
    res.json(repaymentChoices(batch, settlementRow(batch, req.params.txId)));
  });
  app.post("/api/batch/:id/cny-settlement", withBatchWrite((req, res, batch) => {
    requireRevision(batch, req.body?.revision);
    const tx = settlementRow(batch, req.body?.id);
    const amount = readCnySettlementAmount(req.body?.amount);
    if (amount === undefined) throw new ImportError(400, "请输入大于 0 的人民币金额，最多两位小数");
    if (tx.postings && tx.currency === "CNY") throw new ImportError(422, "请先恢复为两条分录，再修改人民币金额");
    const repaymentKey: unknown = req.body?.repaymentKey;
    if (repaymentKey !== undefined && typeof repaymentKey !== "string") throw new ImportError(400, "还款选择无效");
    const release = acquireWriteLock(path.join(dataDir, "locks", "cny-settlement", `${batch.ledgerProfile}.json`), "还款关联正在保存，请稍后重试");
    try {
      const choice = repaymentKey ? repaymentChoices(batch, tx).find(({ key }) => key === repaymentKey) : undefined;
      if (repaymentKey && (!choice || amount > choice.remaining)) throw new ImportError(422, "还款记录已变更或分摊金额超出可用金额");
      const currentLedger = ledger();
      if (!tx.fundingAccount) {
        const funding = statementFundingDefaults(activeTransactions(batch.txs)).get(tx);
        if (funding) applyStatementFundingDefault(tx, funding, currentLedger);
      }
      tx.originalAmount = originalForeignAmount(tx);
      tx.currency = "CNY";
      tx.amount = amount;
      if (choice) {
        const { remaining: _remaining, ...repayment } = choice;
        tx.cnySettlement = { method: "repayment", repayment };
      } else {
        tx.cnySettlement = { method: "manual" };
      }
      tx.status = "pending";
      delete tx.postings;
      delete tx.balanceAfter;
      delete tx.balanceIsDayEnd;
      tx.matches = tx.matches?.filter((match) => match.id.startsWith("batch:"));
      tx.issues = tx.issues?.filter((issue) => !duplicateReviewIssue(issue) && !transferPairIssue(issue));
      if (!currentLedger.accounts.some((account) => account.account === tx.fundingAccount && accountIsActive(account, tx.date, tx.currency))) {
        const funding = inferFundingAccount(tx, config, currentLedger);
        tx.fundingAccount = funding.account;
        tx.fundingConfidence = funding.confidence;
        tx.fundingReason = funding.reason;
        tx.issues = [...new Set([...(tx.issues ?? []).filter((issue) => !fundingMappingIssue(issue)), ...(funding.issues ?? [])])];
      }
      refreshLedgerDuplicateHints([tx], currentLedger.transactions);
      batch.accountsDetected = detectAccounts(batch.txs);
      saveBatchRevision(batch);
      res.json({ batch: publicReviewBatch(batch) });
    } finally { release(); }
  }));
  app.get("/api/batch/:id/pdf-preview/:txId", asyncRoute(async (req, res) => {
    const batch = getBatch(req.params.id);
    const tx = batch.txs.find(({ id }) => id === req.params.txId);
    if (!tx) throw new ImportError(404, "找不到这笔交易。");
    const preview = await loadPdfPreview(batch, tx, ledgerRoot());
    res.set("Cache-Control", "no-store").json(preview);
  }));
  app.post("/api/batch/:id/recheck-ledger", asyncRoute(async (req, res) => {
    const requested = getBatch(req.params.id);
    requireActiveBatch(requested);
    if (requested.committed) throw new ImportError(409, "已写入的批次不能再修改");
    requireRevision(requested, req.body?.revision);
    const currentLedger = await parseLedgerAsync(ledgerRoot(), config.mainFile, config.pythonPath);
    const release = lockBatch(requested.batchId);
    try {
      const batch = getBatch(requested.batchId);
      requireActiveBatch(batch);
      if (batch.committed) throw new ImportError(409, "已写入的批次不能再修改");
      requireRevision(batch, requested.revision);
      const txs = activeTransactions(batch.txs).filter((tx) => !tx.merge && !tx.reviewConflictId);
      const rules = wechatRulesFor(txs);
      const exclusionsChanged = applyWechatExclusions(txs, rules);
      const fundingChanged = restoreKnownWechatFunding(txs, rules, config, currentLedger);
      let statementFundingChanged = false;
      for (const [tx, account] of statementFundingDefaults(txs)) {
        if (applyStatementFundingDefault(tx, account, currentLedger)) statementFundingChanged = true;
      }
      const restored = restoreRefundedPurchases(txs, config, currentLedger);
      if (restored.length) markDuplicates(restored, currentLedger.transactions);
      if (restored.length || fundingChanged || statementFundingChanged) batch.accountsDetected = detectAccounts(batch.txs);
      const result = refreshLedgerDuplicateHints(txs, currentLedger.transactions);
      const refundsChanged = syncStatementRefunds(txs, currentLedger.transactions);
      if (exclusionsChanged || fundingChanged || statementFundingChanged || restored.length || result.changed || refundsChanged) saveBatchRevision(batch);
      res.json({ batch: publicReviewBatch(batch), suspected: result.suspected });
    } finally {
      release();
    }
  }));
  app.post("/api/batch/:id/exclude-suspected", withBatchWrite((req, res, batch) => {
    if (batch.committed) throw new ImportError(409, "已写入的批次不能再修改");
    requireRevision(batch, req.body?.revision);
    const sessionId = readReviewSessionId(req.body?.reviewSessionId);
    const txs = activeTransactions(batch.txs);
    const targets = planSuspectedDuplicateExclusions(txs);
    if (targets.length) {
      const previous = reviewStatuses(txs);
      for (const tx of targets) {
        Object.assign(tx, reviewStatusPatch(tx, "excluded", "deduplicate"));
        delete tx.duplicateOf;
      }
      syncStatementRefunds(txs);
      rememberReviewStatusChange(batch, txs, previous, "deduplicate", sessionId);
      saveBatchRevision(batch);
    }
    res.json({ batch: publicReviewBatch(batch), excluded: targets.length });
  }));
  app.post("/api/batch/:id/undo-review-status", withBatchWrite((req, res, batch) => {
    if (batch.committed) throw new ImportError(409, "已写入的批次不能再修改");
    requireRevision(batch, req.body?.revision);
    const sessionId = readReviewSessionId(req.body?.reviewSessionId);
    const active = activeTransactions(batch.txs);
    const undo = availableReviewUndo(batch, active);
    if (!undo || undo.history.sessionId !== sessionId) throw new ImportError(409, "本次审批没有可撤销的状态变更");
    const previous = new Map(undo.operation.entries.map(({ id, before, beforeExclusion }) =>
      [id, { status: before, reviewExclusion: beforeExclusion }]));
    for (const tx of active) {
      const state = previous.get(tx.id);
      if (state) Object.assign(tx, state);
    }
    undo.history.operations.length = undo.depth - 1;
    saveBatchRevision(batch);
    res.json({ batch: publicReviewBatch(batch), restoredIds: [...previous.keys()] });
  }));
  app.delete("/api/batch/:id", withBatchWrite((req, res, batch) => {
    requireRevision(batch, req.body?.revision);
    assertBatchDeletable(batch, dataDir);
    batches.remove(batch.batchId);
    res.json({ ok: true });
  }));
  app.post("/api/batch/:id/statement-names", withBatchWrite((req, res, batch) => {
    requireRevision(batch, req.body?.revision);
    if (!batch.statementSources?.length) throw new ImportError(422, "此批次没有可改名的账单");
    batch.statementSources = applyStatementNames(batch.statementSources, req.body?.names);
    saveBatchRevision(batch);
    res.json({ batch: publicReviewBatch(batch) });
  }));
  app.post("/api/batch/:id/review-conflicts", withBatchWrite((req, res, batch) => {
    if (batch.committed) throw new ImportError(409, "已写入的批次不能再修改");
    requireRevision(batch, req.body?.revision);
    resolveBatchReviewConflict(batch, req.body?.conflictId, req.body?.sourceBatchId);
    const previous = batches.list().filter((item) => item.ledgerProfile === batch.ledgerProfile && item.batchId !== batch.batchId);
    batch.dedup = reviewMergedTransactions(batch.txs, ledger(), previous);
    saveBatchRevision(batch);
    res.json({ batch: publicReviewBatch(batch) });
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
    if (txs.some((tx) => tx.reviewConflictId)) throw new ImportError(422, "请先核对所选交易的审批冲突");
    const counterparts = matchStatementRefunds(activeTransactions(batch.txs));
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
    requireActiveBatch(batch, true);
    requireRevision(batch, req.body?.revision);
    const finishCombinedFunding = Boolean(batch.combinedFundingPending);
    const txs = batch.committed ? [] : activeTransactions(batch.txs).filter((tx) => !tx.merge && !tx.reviewConflictId);
    const rules = wechatRulesFor(txs);
    const exclusionsChanged = applyWechatExclusions(txs, rules);
    const payments = unmappedPayments(txs, rules);
    const combined = combinedFundingPayments(txs);
    const splitPayments = txs.flatMap((tx) => {
      const fundingParts = needsFundingAccount(tx) ? unallocatedFundingParts(tx) : undefined;
      return fundingParts ? [{ tx, fundingParts }] : [];
    });
    const statementDefaults = statementFundingDefaults(txs);
    const currentLedger = finishCombinedFunding || payments.size || combined.groups.size || splitPayments.length || statementDefaults.size ? ledger() : undefined;
    const splits = splitPayments.map(({ tx, fundingParts }) => ({
      tx, fundingParts, guess: inferFundingAccount({ ...tx, fundingParts }, config, currentLedger),
    }));
    const splitRows = new Set(splits.map(({ tx }) => tx));
    for (const { tx, fundingParts, guess } of splits) {
      if (guess.account || tx.source === "alipay") continue;
      for (const part of fundingParts) {
        if (isPaymentAccountPart(part)) addPaymentGroup(payments, tx, part.rawAccount.trim());
      }
    }
    const mappings = req.body?.mappings as FundingMappingChoice[] | undefined;
    if (mappings !== undefined && (!Array.isArray(mappings) || mappings.length > payments.size + combined.groups.size
      || mappings.some((item) => !item || (combined.groups.has(item.id)
        ? item.account !== null && typeof item.account !== "string"
        : !payments.has(item.id) || typeof item.account !== "string"))
      || new Set(mappings.map((item) => item.id)).size !== mappings.length)) throw new ImportError(400, "资金映射无效");
    const available = currentLedger?.accounts.filter(({ account }) => isFundingAccount(account)) ?? [];
    const choices = new Map(mappings?.map(({ id, account }) => [id, account]));
    const groups: FundingMappingGroup[] = [];
    const resolved = new Map<ParsedTx, string>();
    let assetMapping = config.assetMapping;
    for (const [id, payment] of payments) {
      const { raw, fromFile } = payment;
      const rows = [...payment.txs];
      const { source, sourceFile } = rows[0];
      const accounts = available.filter((account) => rows.every((tx) => accountIsActive(account, tx.date, tx.currency))).map((account) => account.account);
      const guesses = new Set(rows.map((tx) => {
        const result = splitRows.has(tx) ? matchFundingAccount(raw, tx, config, currentLedger) : inferFundingAccount(tx, config, currentLedger);
        return result.account;
      }));
      const [guess] = guesses;
      const existing = guesses.size === 1 && accounts.includes(guess) ? guess : "";
      const choice = choices.get(id);
      if (choice !== undefined && (choice === null || !accounts.includes(choice))) throw new ImportError(400, `账户不可用：${fromFile ? sourceFile : raw}`);
      if (choice && existing && choice !== existing) throw new ImportError(409, "账户映射已更新");
      if (!existing) groups.push({ id, label: fromFile ? sourceFile : raw, source, count: rows.length, accounts, statementOnly: fromFile || undefined });
      const account = existing || choice;
      if (!account) continue;
      for (const tx of rows) if (!splitRows.has(tx)) resolved.set(tx, account);
      if (!existing && !fromFile) {
        assetMapping = setExactFundingMapping(assetMapping, source, raw, account);
      }
    }
    for (const [id, { label, combination, first, txs: members }] of combined.groups) {
      const rows = [...members];
      const accounts = currentLedger!.accounts.filter((account) => rows.every((tx) =>
        accountIsActive(account, tx.date, tx.currency))).map(({ account }) => account);
      const choice = choices.get(id);
      if (choice != null && !accounts.includes(choice)) throw new ImportError(400, `账户不可用：${combination} · ${label}`);
      const defaults = first ? new Set(rows.map((tx) => matchFundingAccount(label, tx, config, currentLedger, true).account)) : undefined;
      const [matched] = defaults ?? [];
      const defaultAccount = defaults?.size === 1 && accounts.includes(matched) ? matched : undefined;
      groups.push({ id, label, combination, source: "alipay", count: members.size, accounts, defaultAccount });
    }
    if (groups.some(({ id }) => !choices.has(id))) { res.json({ groups }); return; }

    for (const [tx, account] of resolved) {
      confirmFundingAccount(tx, account);
      tx.issues = tx.issues?.filter((issue) => !fundingMappingIssue(issue));
    }
    let fundingChanged = resolved.size > 0;
    for (const [tx, { parts, ids }] of combined.rows) {
      tx.fundingParts = parts;
      tx.fundingPartAccounts = ids.map((id) => choices.get(id) ?? null);
      const primary = tx.fundingPartAccounts[parts.findIndex(isPaymentAccountPart)];
      if (primary && isFundingAccount(primary)) {
        confirmFundingAccount(tx, primary);
        tx.issues = tx.issues?.filter((issue) => !fundingMappingIssue(issue));
      }
      fundingChanged = true;
    }
    const skipped = new Set<ParsedTx>();
    if (finishCombinedFunding) {
      for (const tx of batch.txs) {
        const parts = alipayCombinedParts(tx), selected = tx.fundingPartAccounts;
        if (parts && (selected?.length !== parts.length || selected.some((account) => !account))) skipped.add(tx);
      }
      batch.txs = batch.txs.filter((tx) => !skipped.has(tx));
      batch.txCount = batch.txs.length;
      delete batch.combinedFundingPending;
    }
    if (currentLedger) {
      for (const [tx, account] of resolved.size ? statementFundingDefaults(txs) : statementDefaults) {
        if (applyStatementFundingDefault(tx, account, currentLedger)) fundingChanged = true;
      }
    }
    const fundingConfig = { ...config, assetMapping };
    for (const { tx, fundingParts, guess: originalGuess } of splits) {
      if (tx.fundingAccount || skipped.has(tx)) continue;
      const guess = assetMapping === config.assetMapping ? originalGuess : inferFundingAccount({ ...tx, fundingParts }, fundingConfig, currentLedger);
      if (!guess.account) continue;
      tx.fundingParts = fundingParts;
      tx.fundingAccount = guess.account;
      tx.fundingConfidence = guess.confidence;
      tx.fundingReason = guess.reason;
      const issues = (tx.issues ?? []).filter((issue) => issue !== "组合支付" && !fundingMappingIssue(issue));
      tx.issues = [...new Set([...issues, ...(guess.issues ?? [])])];
      fundingChanged = true;
    }
    // Matching can use the new funding accounts before review starts. Resumed batches keep prior review decisions.
    if ((finishCombinedFunding || (fundingChanged && batch.revision === 1)) && currentLedger) {
      for (const tx of batch.txs) {
        delete tx.matches;
        delete tx.duplicateOf;
        tx.issues = tx.issues?.filter((issue) => !duplicateReviewIssue(issue) && !transferPairIssue(issue) && !otherBatchIssue(issue));
        tx.status = tx.excludedReason ? "excluded" : tx.status === "ready" ? "ready" : "pending";
      }
      if (finishCombinedFunding) restoreRefundedPurchases(batch.txs, fundingConfig, currentLedger);
      suggestRefundsFromBatch(batch.txs, currentLedger);
      const deduped = markDuplicates(batch.txs, currentLedger.transactions), paired = pairTransfers(batch.txs);
      referenceUncommittedBatches(batch.txs, batches.list().filter((item) => item.batchId !== batch.batchId && item.ledgerProfile === batch.ledgerProfile));
      batch.dedup = { ...deduped.stats, transferPairs: paired.pairs.length, familyCardPairs: paired.familyCardPairs };
    } else if (fundingChanged && currentLedger) {
      refreshLedgerDuplicateHints(txs, currentLedger.transactions);
    }
    const refundsChanged = syncStatementRefunds(txs.filter((tx) => !skipped.has(tx)), currentLedger?.transactions);
    if (!finishCombinedFunding && !fundingChanged && !exclusionsChanged && !refundsChanged) { res.json({ groups: [] }); return; }
    const release = lockBatch(batch.batchId);
    try {
      const latest = getBatch(batch.batchId);
      requireActiveBatch(latest, true);
      requireRevision(latest, batch.revision);
      if (latest.committed) throw new ImportError(409, "已写入的批次不能再修改");
      if (finishCombinedFunding && !batch.txs.some(isParsedStatementRow)) {
        batches.remove(batch.batchId);
        res.json({ groups: [], skippedCombined: skipped.size, batchRemoved: true });
        return;
      }
      if (assetMapping !== config.assetMapping) {
        const candidate = { ...config, assetMapping };
        saveConfig(candidate, { activeLedgerFile: options.activeLedgerFile });
        config = candidate;
      }
      batch.accountsDetected = detectAccounts(batch.txs.filter((tx) => !tx.merge));
      saveBatchRevision(batch);
    } finally {
      release();
    }
    res.json({ batch: publicBatch(batch), groups: [], config: publicConfig(), skippedCombined: skipped.size || undefined });
  });
  app.post("/api/batch/:id/funding-mapping", withBatchWrite((req, res, batch) => {
    if (batch.committed) throw new ImportError(409, "已写入的批次不能再修改");
    requireRevision(batch, req.body?.revision);
    const txs = activeTransactions(batch.txs);
    const tx = txs.find(({ id }) => id === req.body?.id);
    if (!tx) throw new ImportError(404, "交易不存在");
    if (tx.reviewConflictId) throw new ImportError(422, "请先核对这笔交易的审批冲突");
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
      && !other.reviewConflictId
      && (other.fundingConfidence ?? 1) < 1 && !other.postings && !other.fundingAccount2 && !other.excludedReason
      && (other.status === "pending" || other.status === "ready") && accountIsActive(account, other.date, other.currency)
      && normalizePaymentMethod(reusablePaymentMethod(other)) === key));
    for (const other of affected) {
      confirmFundingAccount(other, accountName);
      other.issues = other.issues?.filter((issue) => !fundingMappingIssue(issue));
    }
    refreshLedgerDuplicateHints(affected, currentLedger.transactions);
    syncStatementRefunds(txs, currentLedger.transactions);
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
    const sessionId = readReviewSessionId(req.body.reviewSessionId);
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
      if (tx.reviewConflictId) throw new ImportError(422, "请先核对这笔交易的审批冲突");
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
      if (tx.duplicateOf?.refundCopy && nextStatus && nextStatus !== "excluded") throw new ImportError(422, tx.duplicateOf.label);
      if (decision.account !== undefined && (typeof decision.account !== "string" || !hasAccount(decision.account))) throw new ImportError(400, "分类账户必须来自当前账本");
      if (decision.funding !== undefined && (typeof decision.funding !== "string" || !isFundingAccount(decision.funding) || !hasAccount(decision.funding))) throw new ImportError(400, "资金账户必须来自当前账本的资产、负债或收入账户");
      if (decision.tags !== undefined && (!Array.isArray(decision.tags) || decision.tags.length > 40 || decision.tags.some((tag) => typeof tag !== "string" || tag.length > 64 || !TAG_RE.test(tag)))) throw new ImportError(400, "标签格式无效");
      if (decision.flag !== undefined && decision.flag !== "*" && decision.flag !== "!") throw new ImportError(400, "标记应为 * 或 !");
      if (decision.reviewNote !== undefined && (typeof decision.reviewNote !== "string" || decision.reviewNote.length > 2000)) throw new ImportError(400, "备注最多 2000 字符");
      if (decision.narration != null && (typeof decision.narration !== "string" || decision.narration.length > MAX_NARRATION_LENGTH)) {
        throw new ImportError(400, `账本摘要最多 ${MAX_NARRATION_LENGTH} 字符`);
      }
      if (decision.postings !== undefined && decision.postings !== null && (!Array.isArray(decision.postings) || decision.postings.length < 2 || decision.postings.length > 40 || decision.postings.some((posting) => !posting || !hasAccount(posting.account) || !Number.isFinite(posting.amount) || typeof posting.currency !== "string" || !/^[A-Z][A-Z0-9._'-]{0,23}$/.test(posting.currency)))) throw new ImportError(400, "拆分分录必须包含有效账本账户、金额和币种");
      if (tx.requireCnySettlement && decision.postings?.some(({ currency }) => currency !== "CNY")) {
        throw new ImportError(422, "此账本的入账分录须使用人民币");
      }
      decisions.push(decision);
    }
    const changesOnly = req.body.changesOnly === true;
    const before = changesOnly ? publicBatch(batch).txs.map((tx) => ({ ...tx })) : undefined;
    const previousStatuses = reviewStatuses(active);
    let memoryUpdates: Record<string, string> | undefined;
    for (const decision of decisions) {
      const tx = txById.get(decision.id)!;
      if (tx.eventType === "refund"
        && (decision.account !== undefined || decision.status !== undefined || decision.postings !== undefined)) tx.refundReviewMode = "manual";
      if (decision.account !== undefined) {
        const account = decision.account;
        if (tx.postings) tx.postings = tx.postings.map((posting) => posting.account === tx.finalAccount ? { ...posting, account } : posting);
        else if (tx.fundingAccount2) tx.fundingAccount2 = account;
        tx.finalAccount = account;
        if (/^(Expenses|Income):/.test(account)) {
          memoryUpdates ??= {};
          memoryUpdates[classificationMemoryKey(tx.payee, tx.rawCategory)] = account;
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
      if (decision.status === "ready") {
        if (needsCnySettlement(tx)) throw new ImportError(422, CNY_SETTLEMENT_REQUIRED);
        if (requiresFundingSplit(tx)) throw new ImportError(422, FUNDING_SPLIT_REQUIRED);
        const missing = missingPostingAccount(tx);
        if (missing) throw new ImportError(422, missingPostingAccountMessage[missing]);
      }
      if (decision.status !== undefined) Object.assign(tx, reviewStatusPatch(tx, decision.status));
      else if (decision.account !== undefined) Object.assign(tx, reviewStatusPatch(tx, statusAfterCategorization(tx)));
      else if (decision.postings === null && requiresFundingSplit(tx) && tx.status === "ready") tx.status = "pending";
      if (tx.status !== "duplicate") delete tx.duplicateOf;
    }
    syncStatementRefunds(active);
    const undoAction = decisions.every(({ status }) => status === "ready") ? "approve"
      : decisions.every(({ status }) => status === "excluded") ? "exclude" : "update";
    rememberReviewStatusChange(batch, active, previousStatuses, undoAction, sessionId);
    if (memoryUpdates) saveMemory(memoryLocation(), memoryUpdates);
    saveBatchRevision(batch);
    const reviewed = publicReviewBatch(batch);
    const result = { ok: true, revision: reviewed.revision, ready: reviewed.parseStats.ready, reviewUndo: reviewed.reviewUndo };
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
    const directoryError = importLayoutError(config);
    if (directoryError) throw new ImportError(400, directoryError);
    const currentLedger = ledger();
    const active = activeTransactions(batch.txs);
    if (syncStatementRefunds(active, currentLedger.transactions)) {
      saveBatchRevision(batch);
      throw new ImportError(409, "退款配对已更新。请核对批次后重新生成预览。");
    }
    const result = generateEntries(batch.txs, batch.batchId, config);
    const defined = new Set(currentLedger.accounts.map((account) => account.account));
    const opens = suggestOpens(batch.txs, defined);
    // Accounts in the opens list will be created when the preview is committed.
    const opening = new Set(opens.map((line) => line.split(" open ")[1]));
    const draft = draftProblems(active, currentLedger, opening);
    const errors = [...draft.errors, ...(result.errors ?? [])];
    if (!result.generated.length && !errors.length) errors.push("没有标记入账的交易，请先审批");
    if (errors.length) {
      delete batch.preview;
      batches.save(batch);
      res.status(422).json({
        code: "review_incomplete", error: "请将待确认内容处理完毕后，再点击「生成预览」。",
        reviewProblems: [...(result.reviewProblems ?? []), ...draft.problems],
        errors, details: errors, revision: batch.revision,
      });
      return;
    }
    batch.preview = { revision: batch.revision, result, opens }; batches.save(batch);
    const { files, ...preview } = result;
    res.json({ ...preview, targetFiles: Object.keys(files), generated: result.generated.length, opens, revision: batch.revision, baselineErrors: currentLedger.errors ?? [] });
  }));
  app.post("/api/batch/:id/commit", withBatchWrite((req, res, batch) => {
    if (!batch.committed) requireRevision(batch, req.body.revision);
    const result = commitBatch(batch, config, ledgerRoot(), dataDir);
    if (!batch.committed && config.requireCnySettlement) {
      const ids = new Set<string>();
      for (const tx of activeTransactions(batch.txs)) {
        if (tx.status !== "pending" || tx.excludedReason || (!needsCnySettlement(tx) && !originalForeignAmount(tx)
          && !tx.merge?.originals.some(originalForeignAmount))) continue;
        ids.add(tx.id);
        for (const original of tx.merge?.originals ?? []) ids.add(original.id);
      }
      if (ids.size) {
        const reviewConflicts = batch.reviewConflicts?.filter(({ transactionIds }) => transactionIds.some((id) => ids.has(id)));
        for (const conflict of reviewConflicts ?? []) for (const id of conflict.transactionIds) ids.add(id);
        const txs = batch.txs.filter(({ id }) => ids.has(id));
        const digest = crypto.createHash("sha256").update(`cny-settlement:${batch.batchId}`).digest("hex").slice(0, 12);
        const batchId = `b${batch.createdAt}-${digest}`;
        if (!batches.has(batchId)) {
          batches.save({ batchId, createdAt: Date.now(), revision: 1, committed: false, ledgerProfile: batch.ledgerProfile,
            source: batch.source, file: `待确认外币 · ${batch.file}`, txs, txCount: activeTransactions(txs).length,
            errors: [], accountsDetected: detectAccounts(txs), pdfUploads: batch.pdfUploads,
            statementSources: batch.statementSources, reviewConflicts });
        }
        batch.settlementBatchId = batchId;
      }
    }
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
    const candidate = {
      ...base, archiveUploadsInLedger: switchingDirectory && !existing ? true : base.archiveUploadsInLedger ?? true,
      statementDirectories: switchingDirectory && !existing ? undefined : base.statementDirectories,
      ...patch, ledgerRoot: ledgerDirectory, llm: { ...base.llm, ...patch.llm },
    };
    if (typeof candidate.mainFile !== "string" || typeof candidate.monthlyDir !== "string" || (candidate.pythonPath !== undefined && typeof candidate.pythonPath !== "string")) throw new ImportError(400, "账本路径配置无效");
    const directoryError = importLayoutError(candidate);
    if (directoryError) throw new ImportError(400, directoryError);
    const main = path.resolve(root, candidate.mainFile);
    const relativeMain = path.relative(root, main);
    if (!relativeMain || relativeMain === ".." || relativeMain.startsWith(`..${path.sep}`) || path.isAbsolute(relativeMain) || !fs.existsSync(main)) throw new ImportError(400, "账本主文件不存在或位于账本目录外");
    if (!Array.isArray(candidate.assetMapping) || candidate.assetMapping.some((mapping) => !mapping || typeof mapping.keyword !== "string" || !mapping.keyword.trim() || typeof mapping.account !== "string" || !["credit", "debit"].includes(mapping.kind) || (mapping.cardSuffix !== undefined && (typeof mapping.cardSuffix !== "string" || !/^\d{0,6}$/.test(mapping.cardSuffix))))) throw new ImportError(400, "资金映射需要有效关键词、账户、借贷类型及可选卡片尾号");
    if (typeof candidate.annualLayout !== "boolean" && candidate.annualLayout !== undefined) throw new ImportError(400, "年度布局配置无效");
    if (typeof candidate.archiveUploadsInLedger !== "boolean") throw new ImportError(400, "账单副本归档设置无效");
    if (patch.requireCnySettlement !== undefined && typeof patch.requireCnySettlement !== "boolean") throw new ImportError(400, "人民币入账设置无效");
    const current = parseLedger(root, candidate.mainFile, candidate.pythonPath), defined = new Set(current.accounts.map(({ account }) => account).filter(isFundingAccount));
    const switched = !config.ledgerRoot || profileId(root, candidate.mainFile) !== profile();
    candidate.requireCnySettlement = patch.requireCnySettlement ?? (switched ? existing?.requireCnySettlement : candidate.requireCnySettlement)
      ?? (current.operatingCurrencies?.length === 1 && current.operatingCurrencies[0] === "CNY");
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
