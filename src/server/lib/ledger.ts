/** Native Beancount loading is the authority for includes, booking and validation. */
import fs from "node:fs";
import path from "node:path";
import { execFile, spawnSync } from "node:child_process";
import type { LedgerError, LedgerInfo } from "../../shared/types.js";

const BRIDGE = path.resolve(import.meta.dirname, "../../../scripts/ledger_bridge.py");
const READ_LEDGER_HINT = "无法读取账本。请在「账本设置」中检查主文件和 Python 路径。";
const START_PYTHON_HINT = "无法启动账本读取程序。请在「账本设置」中检查 Python 路径。";

export class LedgerAccessError extends Error {
  constructor(message: string, readonly hint: string) { super(message); }
}

export interface LedgerValidation {
  ok: boolean;
  loader: string;
  errors: LedgerError[];
}

type BridgeResult = LedgerInfo & LedgerValidation & { fatal?: string };
type BridgeRequest = { operation: "inspect" | "validate"; file?: string; text?: string; trackAccountSources?: boolean };
const bridgeOptions = () => ({
  encoding: "utf-8" as const,
  env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PYTHONIOENCODING: "utf-8" },
  maxBuffer: 32 * 1024 * 1024,
  timeout: 60_000,
  windowsHide: true,
});

/** Prefer the ledger's own environment, so validation uses its installed version. */
export function discoverPython(rootDir?: string): string {
  if (process.env.ACCOUNT_IMPORT_PYTHON) return process.env.ACCOUNT_IMPORT_PYTHON;
  if (rootDir) {
    for (const dir of ["venv", ".venv"]) {
      const candidate = process.platform === "win32" ? path.join(rootDir, dir, "Scripts", "python.exe") : path.join(rootDir, dir, "bin", "python");
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return process.platform === "win32" ? "python" : "python3";
}

function bridgeOutput(python: string, stdout: string, stderr: string, status: number | null): BridgeResult {
  let result: BridgeResult;
  try {
    result = JSON.parse(stdout) as BridgeResult;
  } catch {
    throw new LedgerAccessError(`Beancount 桥接未返回有效 JSON (${python}): ${stderr.trim() || `exit ${status}`}`, READ_LEDGER_HINT);
  }
  if (result.fatal || status !== 0) {
    throw new LedgerAccessError(result.fatal || `Beancount 桥接失败: ${stderr.trim() || status}`, READ_LEDGER_HINT);
  }
  return result;
}

function bridge(request: BridgeRequest, pythonPath?: string): BridgeResult {
  const python = pythonPath || discoverPython(request.file ? path.dirname(request.file) : undefined);
  const proc = spawnSync(python, ["-B", BRIDGE], { ...bridgeOptions(), input: JSON.stringify(request) });
  if (proc.error) throw new LedgerAccessError(`无法启动 Beancount Python (${python}): ${proc.error.message}`, START_PYTHON_HINT);
  return bridgeOutput(python, proc.stdout, proc.stderr, proc.status);
}

function ledgerFile(rootDir: string, mainFile: string): string {
  const file = path.resolve(rootDir, mainFile);
  if (!fs.existsSync(file)) throw new LedgerAccessError(`账本入口不存在: ${file}`, "找不到账本主文件。请在「账本设置」中检查账本目录和主文件。");
  return file;
}

function ledgerInfo({ accounts, transactions, payeeIndex, errors, loader, accountSources, operatingCurrencies }: BridgeResult): LedgerInfo {
  return { accounts, transactions, payeeIndex, errors, loader, operatingCurrencies, ...(accountSources ? { accountSources } : {}) };
}

export function parseLedger(rootDir: string, mainFile: string, pythonPath?: string, trackAccountSources = false): LedgerInfo {
  return ledgerInfo(bridge({ operation: "inspect", file: ledgerFile(rootDir, mainFile), trackAccountSources }, pythonPath || discoverPython(rootDir)));
}

/** Interactive reads wait for Python without blocking other HTTP requests. */
export async function parseLedgerAsync(rootDir: string, mainFile: string, pythonPath?: string, trackAccountSources = false): Promise<LedgerInfo> {
  const file = ledgerFile(rootDir, mainFile);
  const python = pythonPath || discoverPython(rootDir);
  return new Promise((resolve, reject) => {
    const child = execFile(python, ["-B", BRIDGE], bridgeOptions(), (error, stdout, stderr) => {
      const status = error?.code;
      if (error && typeof status !== "number") {
        reject(new LedgerAccessError(`无法启动 Beancount Python (${python}): ${error.message}`, START_PYTHON_HINT));
        return;
      }
      try {
        resolve(ledgerInfo(bridgeOutput(python, stdout, stderr, typeof status === "number" ? status : 0)));
      } catch (failure) {
        reject(failure);
      }
    });
    // execFile reports subprocess failures, including an early exit while stdin is being written.
    child.stdin?.on("error", () => {});
    child.stdin?.end(JSON.stringify({ operation: "inspect", file, trackAccountSources }));
  });
}

/** Text parsing is native as well; no regex fallback silently drops directives. */
export function parseLedgerText(text: string, pythonPath?: string): LedgerInfo {
  return ledgerInfo(bridge({ operation: "inspect", text }, pythonPath));
}

export function validateLedgerFile(file: string, pythonPath?: string): LedgerValidation {
  const result = bridge({ operation: "validate", file: path.resolve(file) }, pythonPath);
  return { ok: result.ok, loader: result.loader, errors: result.errors };
}

export function validateLedgerText(text: string, pythonPath?: string): LedgerValidation {
  const result = bridge({ operation: "validate", text }, pythonPath);
  return { ok: result.ok, loader: result.loader, errors: result.errors };
}
