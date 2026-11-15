/** Native Beancount loading is the authority for includes, booking and validation. */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { LedgerError, LedgerInfo } from "../../shared/types.js";

const BRIDGE = path.resolve(import.meta.dirname, "../../../scripts/ledger_bridge.py");

export interface LedgerValidation {
  ok: boolean;
  loader: string;
  errors: LedgerError[];
}

type BridgeResult = LedgerInfo & LedgerValidation & { fatal?: string };

/** Prefer the ledger's own environment, so validation uses its installed version. */
export function discoverPython(rootDir?: string): string {
  if (process.env.ACCOUNT_IMPORT_PYTHON) return process.env.ACCOUNT_IMPORT_PYTHON;
  if (rootDir) {
    for (const dir of ["venv", ".venv"]) {
      const candidate = path.join(rootDir, dir, "bin", "python");
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return "python3";
}

function bridge(
  request: { operation: "inspect" | "validate"; file?: string; text?: string },
  pythonPath?: string,
): BridgeResult {
  const python = pythonPath || discoverPython(request.file ? path.dirname(request.file) : undefined);
  const proc = spawnSync(python, ["-B", BRIDGE], {
    input: JSON.stringify(request),
    encoding: "utf-8",
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    maxBuffer: 32 * 1024 * 1024,
    timeout: 60_000,
  });
  if (proc.error) throw new Error(`无法启动 Beancount Python (${python}): ${proc.error.message}`);
  let result: BridgeResult;
  try {
    result = JSON.parse(proc.stdout) as BridgeResult;
  } catch {
    throw new Error(`Beancount 桥接未返回有效 JSON (${python}): ${proc.stderr.trim() || `exit ${proc.status}`}`);
  }
  if (result.fatal || proc.status !== 0) {
    throw new Error(result.fatal || `Beancount 桥接失败: ${proc.stderr.trim() || proc.status}`);
  }
  return result;
}

export function parseLedger(rootDir: string, mainFile: string, pythonPath?: string): LedgerInfo {
  const file = path.resolve(rootDir, mainFile);
  if (!fs.existsSync(file)) throw new Error(`账本入口不存在: ${file}`);
  const result = bridge({ operation: "inspect", file }, pythonPath || discoverPython(rootDir));
  return { accounts: result.accounts, transactions: result.transactions, payeeIndex: result.payeeIndex, errors: result.errors, loader: result.loader };
}

/** Text parsing is native as well; no regex fallback silently drops directives. */
export function parseLedgerText(text: string, pythonPath?: string): LedgerInfo {
  const result = bridge({ operation: "inspect", text }, pythonPath);
  return { accounts: result.accounts, transactions: result.transactions, payeeIndex: result.payeeIndex, errors: result.errors, loader: result.loader };
}

export function validateLedgerFile(file: string, pythonPath?: string): LedgerValidation {
  const result = bridge({ operation: "validate", file: path.resolve(file) }, pythonPath);
  return { ok: result.ok, loader: result.loader, errors: result.errors };
}

export function validateLedgerText(text: string, pythonPath?: string): LedgerValidation {
  const result = bridge({ operation: "validate", text }, pythonPath);
  return { ok: result.ok, loader: result.loader, errors: result.errors };
}
