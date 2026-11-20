import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import type { AppConfig, LedgerError } from "../../shared/types.js";
import { activeTransactions } from "../../shared/transactionMerge.js";
import { atomicJson, profileId, type StoredBatch } from "./batches.js";
import { discoverPython, parseLedger } from "./ledger.js";
import { generateEntries } from "./generate.js";
import { importDirectoryError } from "./import-paths.js";
import { markDuplicates } from "./dedup.js";

export class ImportError extends Error {
  constructor(public readonly status: number, message: string, public readonly details?: unknown) {
    super(message);
  }
}

interface Change { relative: string; before: string | null; after: string }
interface Journal {
  batchId: string;
  ledgerProfile: string;
  status: "prepared" | "writing" | "applied" | "rolled-back";
  changes: Change[];
  written: string[];
  validation: { baselineErrors: LedgerError[]; newErrors: LedgerError[] };
}

const read = (file: string) => fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;

function inside(root: string, relative: string): string {
  const result = path.resolve(root, relative);
  const fromRoot = path.relative(root, result);
  if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot)) {
    throw new ImportError(400, "账本文件路径必须位于账本目录内");
  }
  // Existing symlink parents could otherwise redirect writes outside the ledger.
  let current = root;
  for (const part of fromRoot.split(path.sep)) {
    current = path.join(current, part);
    if (fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new ImportError(400, "写入路径不能包含符号链接");
    }
  }
  return result;
}

function replaceFile(file: string, content: string | null): void {
  if (content === null) { fs.rmSync(file, { force: true }); return; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.bean-import-${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temporary, content, { mode: fs.existsSync(file) ? fs.statSync(file).mode : 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

/** Resolve an include through root aliases, but never through a child symlink. */
function includeRelative(root: string, parent: string, include: string): string {
  if (/[\*?\[\]\\]/.test(include) || /^(?:~|\$)/.test(include)) {
    throw new ImportError(422, "隔离校验暂不支持通配符、环境变量或转义路径的 include");
  }
  const absolute = path.resolve(root, path.dirname(parent), include);
  const anchor = path.parse(absolute).root;
  const components = path.relative(anchor, absolute).split(path.sep);
  let prefix = anchor;
  for (let i = 0; i < components.length; i++) {
    prefix = path.join(prefix, components[i]);
    if (!fs.existsSync(prefix)) continue;
    // This accepts /var -> /private/var (or another alias of the root itself),
    // while inside() rejects symbolic links below the canonical ledger root.
    if (fs.realpathSync(prefix) === root) {
      return path.relative(root, inside(root, components.slice(i + 1).join(path.sep)));
    }
  }
  throw new ImportError(422, "账本 include 超出账本目录，无法隔离校验");
}

function withInclude(text: string, relative: string, root: string, parent: string): string {
  const escaped = relative.replace(/\\/g, "/");
  const target = includeRelative(root, parent, escaped);
  const present = text.split(/\r?\n/).some((line) => {
    const include = line.match(/^[ \t]*include[ \t]+"([^"]+)"/)?.[1];
    return include !== undefined && includeRelative(root, parent, include) === target;
  });
  return present ? text : `${text.trimEnd()}\ninclude "${escaped}"\n`;
}

function errorKey(error: LedgerError, staged: string, root: string): string {
  const normalize = (s: string) => s.split(staged).join(root).replace(/\\/g, "/");
  return JSON.stringify([normalize(error.file ?? ""), error.line, normalize(error.message), error.type]);
}

export function acquireWriteLock(file: string, busyMessage: string): () => void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let lock: { pid: number } | undefined;
  try {
    lock = JSON.parse(fs.readFileSync(file, "utf8")) as { pid: number };
  } catch (error) {
    if (error instanceof SyntaxError) throw new ImportError(409, busyMessage);
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (lock) {
    let alive = true;
    try { process.kill(lock.pid, 0); } catch (error) { alive = (error as NodeJS.ErrnoException).code !== "ESRCH"; }
    if (alive) throw new ImportError(409, busyMessage);
    fs.rmSync(file, { force: true });
  }
  try { fs.writeFileSync(file, JSON.stringify({ pid: process.pid }), { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throw new ImportError(409, busyMessage);
  }
  return () => fs.rmSync(file, { force: true });
}

export function assertBatchDeletable(batch: StoredBatch, dataDir: string): void {
  if (batch.committed) throw new ImportError(409, "已过账的批次不能删除");
  const journal = read(path.join(dataDir, "commits", `${batch.batchId}.json`));
  if (journal && (JSON.parse(journal) as Journal).status !== "rolled-back") {
    throw new ImportError(409, "此批次有待核对的过账记录，请先确认过账状态");
  }
}

/** Complete or roll back an interrupted commit without appending the batch again. */
function recover(root: string, journal: Journal, journalFile: string): boolean {
  const states = journal.changes.map((change) => read(inside(root, change.relative)));
  if (states.every((value, i) => value === journal.changes[i].after)) {
    journal.status = "applied";
    atomicJson(journalFile, journal);
    return true;
  }
  if (journal.status === "applied") {
    throw new ImportError(409, "该批次已写入，之后账本被修改；请核对提交记录，不能再次追加");
  }
  if (states.some((value, i) => value !== journal.changes[i].before && value !== journal.changes[i].after)) {
    throw new ImportError(409, "中断提交的文件已有外部修改，请先核对提交记录后恢复");
  }
  journal.changes.forEach((change, i) => {
    if (states[i] === change.after) replaceFile(inside(root, change.relative), change.before);
  });
  journal.status = "rolled-back";
  atomicJson(journalFile, journal);
  return false;
}

export function commitBatch(batch: StoredBatch, config: AppConfig, root: string, dataDir: string) {
  root = fs.realpathSync(path.resolve(root));
  const profile = profileId(root, config.mainFile);
  if (batch.ledgerProfile !== profile) throw new ImportError(409, "账本配置已改变，请切回此批次的账本再操作");
  const release = acquireWriteLock(path.join(dataDir, "locks", `${profile}.json`), "另一个批次正在写入该账本，请稍后重试");
  const journalFile = path.join(dataDir, "commits", `${batch.batchId}.json`);
  let stage: string | undefined;
  try {
    const journals = path.join(dataDir, "commits");
    if (fs.existsSync(journals)) {
      for (const name of fs.readdirSync(journals).filter((name) => name.endsWith(".json"))) {
        const file = path.join(journals, name);
        const interrupted = JSON.parse(fs.readFileSync(file, "utf8")) as Journal;
        if (interrupted.ledgerProfile === profile && interrupted.batchId !== batch.batchId && ["prepared", "writing"].includes(interrupted.status)) {
          recover(root, interrupted, file);
        }
      }
    }
    if (fs.existsSync(journalFile)) {
      const previous = JSON.parse(fs.readFileSync(journalFile, "utf8")) as Journal;
      if (previous.ledgerProfile !== profile) throw new ImportError(409, "提交记录与当前账本不一致");
      if (previous.status !== "rolled-back" && recover(root, previous, journalFile)) {
        return { ok: true, written: previous.written, opens: [], alreadyCommitted: true, validation: previous.validation };
      }
    }
    if (batch.committed) return { ok: true, written: batch.written ?? [], opens: [], alreadyCommitted: true };
    if (!batch.preview || batch.preview.revision !== batch.revision) throw new ImportError(409, "请先生成当前审阅版本的预览");

    const python = config.pythonPath || discoverPython(root);
    const directoryError = importDirectoryError(config.monthlyDir);
    if (directoryError) throw new ImportError(400, directoryError);
    const generated = generateEntries(batch.txs, batch.batchId, config);
    if (generated.errors?.length) throw new ImportError(422, "分录校验未通过", generated.errors);
    if (!generated.generated.length) throw new ImportError(422, "没有已确认的交易可写入");
    const previousFiles = batch.preview.result.files;
    const hasNewVariables = /\{(?:month|source|account)\}/.test(config.monthlyDir) || (!config.annualLayout && config.monthlyDir.includes("{year}"));
    if (previousFiles
      ? JSON.stringify(generated.files) !== JSON.stringify(previousFiles)
      : hasNewVariables || JSON.stringify(generated.monthFiles) !== JSON.stringify(batch.preview.result.monthFiles)) {
      throw new ImportError(409, "预览与当前批次不一致，请重新生成");
    }

    stage = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bean-import-")));
    const snapshot = new Map<string, string>();
    const originalText = new Map<string, string>();
    const mainRelative = path.relative(root, inside(root, config.mainFile));
    const excluded = (name: string) => [".git", "venv", ".venv", "node_modules", "__pycache__"].includes(name) || name.endsWith(".picklecache");
    const copy = (from: string, to: string) => {
      for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
        if (excluded(entry.name)) continue;
        const source = path.join(from, entry.name), target = path.join(to, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) { fs.mkdirSync(target, { recursive: true }); copy(source, target); }
        else if (entry.isFile()) {
          const bytes = fs.readFileSync(source);
          fs.writeFileSync(target, bytes);
          snapshot.set(path.relative(root, source), crypto.createHash("sha256").update(bytes).digest("hex"));
        }
      }
    };
    copy(root, stage);
    // Walk the actual include graph (including files with nonstandard suffixes).
    // Run both before loading the baseline and after applying the draft, because
    // a planned main/annual file can contain original absolute include paths.
    const rewriteIncludes = () => {
      const seen = new Set<string>();
      const visit = (relative: string) => {
        if (seen.has(relative)) return;
        seen.add(relative);
        const stagedFile = inside(stage!, relative);
        if (!fs.existsSync(stagedFile)) {
          if (fs.existsSync(inside(root, relative))) throw new ImportError(422, "账本 include 引用了快照排除目录中的文件，无法隔离校验");
          return; // Truly missing includes are reported by the native loader.
        }
        const text = fs.readFileSync(stagedFile, "utf8");
        if (snapshot.has(relative) && !originalText.has(relative)) originalText.set(relative, text);
        const targets: string[] = [];
        const rewritten = text.replace(/(^[ \t]*include[ \t]+")([^"]+)(")/gm, (_match, prefix: string, include: string, suffix: string) => {
          const target = includeRelative(root, relative, include);
          targets.push(target);
          return `${prefix}${path.relative(path.dirname(stagedFile), inside(stage!, target)).replace(/\\/g, "/")}${suffix}`;
        });
        if (rewritten !== text) fs.writeFileSync(stagedFile, rewritten);
        targets.forEach(visit);
      };
      visit(mainRelative);
    };
    rewriteIncludes();
    // Both baseline and duplicate identity come from the same byte snapshot that
    // is later checked against the original tree. No pre-snapshot race window.
    const ledger = parseLedger(stage, mainRelative, python);
    const ready = structuredClone(activeTransactions(batch.txs).filter((tx) => tx.status === "ready"));
    const rechecked = markDuplicates(ready, ledger.transactions);
    if (rechecked.txs.some((tx) => tx.status === "duplicate")) {
      throw new ImportError(409, "账本已包含此批次的部分交易，请重新导入对账后再提交");
    }
    const toOriginal = (error: LedgerError): LedgerError => ({ ...error,
      file: error.file?.split(stage!).join(root), message: error.message.split(stage!).join(root) });
    const baselineErrors = (ledger.errors ?? []).map(toOriginal);
    const planned = new Map<string, string>();
    const content = (relative: string) => {
      if (planned.has(relative)) return planned.get(relative)!;
      if (snapshot.has(relative) && !originalText.has(relative)) originalText.set(relative, fs.readFileSync(inside(stage!, relative), "utf8"));
      return originalText.get(relative) ?? "";
    };
    const written: string[] = [];
    const annualFiles = new Map<string, string>();
    for (const [target, { year, body }] of Object.entries(generated.files)) {
      const relative = path.normalize(target);
      inside(root, relative);
      planned.set(relative, `${content(relative).trimEnd()}\n\n; import-batch: ${batch.batchId}\n${body.trimEnd()}\n`);
      written.push(target);
      if (config.annualLayout) {
        const annual = path.join("years", year, `${year}.bean`);
        annualFiles.set(year, annual);
        planned.set(annual, withInclude(content(annual), path.relative(path.dirname(annual), relative), root, annual));
      } else {
        planned.set(mainRelative, withInclude(content(mainRelative), path.relative(path.dirname(mainRelative), relative), root, mainRelative));
      }
    }
    const opens = batch.preview.opens;
    for (const [year, annual] of annualFiles) {
      const opensText = opens.filter((line) => line.startsWith(`${year}-`)).map((line) => `${line}\n`).join("");
      planned.set(annual, opensText + content(annual));
      planned.set(mainRelative, withInclude(content(mainRelative), path.relative(path.dirname(mainRelative), annual), root, mainRelative));
    }
    if (!config.annualLayout && opens.length) {
      planned.set(mainRelative, `${opens.join("\n")}\n${content(mainRelative)}`);
    }
    for (const [relative, after] of planned) replaceFile(inside(stage, relative), after);
    rewriteIncludes();
    const stagedLedger = parseLedger(stage, mainRelative, python);
    const validation = { errors: stagedLedger.errors ?? [] };
    const existing = new Map<string, number>();
    for (const error of ledger.errors ?? []) {
      const key = errorKey(error, stage, root); existing.set(key, (existing.get(key) ?? 0) + 1);
    }
    const newErrors = validation.errors.filter((error) => {
      const key = errorKey(error, stage!, root), count = existing.get(key) ?? 0;
      if (count) { existing.set(key, count - 1); return false; }
      return true;
    }).map(toOriginal);
    if (newErrors.length) throw new ImportError(422, "暂存账本产生新增校验错误，尚未写入真实账本", newErrors);
    const stagedIds = new Set(stagedLedger.transactions.filter((tx) => tx.metadata?.["import-batch"] === batch.batchId).map((tx) => tx.metadata?.["import-row-id"]));
    if (generated.generated.some((id) => !stagedIds.has(id))) throw new ImportError(422, "部分生成分录未进入暂存账本的 include 链，尚未写入");
    const currentFiles = new Set<string>();
    const scan = (directory: string) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (excluded(entry.name) || entry.isSymbolicLink()) continue;
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) scan(absolute);
        else if (entry.isFile()) currentFiles.add(path.relative(root, absolute));
      }
    };
    scan(root);
    if (currentFiles.size !== snapshot.size || [...currentFiles].some((relative) => !snapshot.has(relative))) {
      throw new ImportError(409, "校验期间账本新增或删除了文件，请重新生成预览后重试");
    }
    for (const [relative, expected] of snapshot) {
      const current = fs.existsSync(inside(root, relative)) ? fs.readFileSync(inside(root, relative)) : null;
      if (!current || crypto.createHash("sha256").update(current).digest("hex") !== expected) {
        throw new ImportError(409, "校验期间账本已被修改，请重新生成预览后重试");
      }
    }
    const changes = [...planned].map(([relative, after]) => ({ relative, before: snapshot.has(relative) ? originalText.get(relative)! : null, after }));
    if (changes.some((change) => read(inside(root, change.relative)) !== change.before)) {
      throw new ImportError(409, "校验期间目标文件已改变，请重新生成预览");
    }
    const journal: Journal = { batchId: batch.batchId, ledgerProfile: profile, status: "prepared", changes, written, validation: { baselineErrors, newErrors } };
    atomicJson(journalFile, journal);
    journal.status = "writing"; atomicJson(journalFile, journal);
    try {
      for (const change of changes) {
        const file = inside(root, change.relative);
        if (read(file) !== change.before) throw new ImportError(409, "账本文件已被其他程序修改");
        replaceFile(file, change.after);
      }
      journal.status = "applied"; atomicJson(journalFile, journal);
    } catch (error) {
      recover(root, journal, journalFile);
      throw error;
    }
    return { ok: true, written, opens: [], alreadyCommitted: false, validation: journal.validation };
  } finally {
    if (stage) fs.rmSync(stage, { recursive: true, force: true });
    release();
  }
}
