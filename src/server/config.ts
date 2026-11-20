import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AppConfig } from "../shared/types.js";
import { discoverPython, parseLedger } from "./lib/ledger.js";
import { accountIsActive, buildAssetMapping } from "./lib/accounts.js";
import { atomicJson } from "./lib/batches.js";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../..");
const LEDGER_SETTINGS = ".beancount-importer.json";
const hasLedger = (directory: string) => fs.existsSync(path.join(directory, LEDGER_SETTINGS)) || fs.existsSync(path.join(directory, "main.bean"));

export function defaultActiveLedgerFile(): string {
  const home = os.homedir();
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "BeancountImporter", "active-ledger.json");
  }
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "BeancountImporter", "active-ledger.json");
  }
  return path.join(process.env.XDG_STATE_HOME || path.join(home, ".local", "state"), "beancount-importer", "active-ledger.json");
}

/** Find a local accounting checkout without storing a personal absolute path in source. */
export function discoverLedgerRoot(): string | undefined {
  if (process.env.ACCOUNT_IMPORT_LEDGER_ROOT) return path.resolve(process.env.ACCOUNT_IMPORT_LEDGER_ROOT);
  let ancestor = PROJECT_ROOT;
  while (true) {
    const candidate = path.join(ancestor, "accounting");
    if (hasLedger(candidate)) return candidate;
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const candidate = path.join(os.homedir(), "workspace", "accounting");
  return hasLedger(candidate) ? candidate : undefined;
}

function defaultConfig(ledgerRoot: string): AppConfig {
  return {
    ledgerRoot,
    mainFile: "main.bean",
    monthlyDir: "years/{year}/imported",
    annualLayout: true,
    pythonPath: ledgerRoot ? discoverPython(ledgerRoot) : undefined,
    assetMapping: [],
    accounts: [],
    llm: { provider: "off", apiBase: "https://api.openai.com/v1", model: "", apiKey: "" },
  };
}

function readSettings(file: string): Partial<AppConfig> | undefined {
  try {
    const data: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (data === null || typeof data !== "object" || Array.isArray(data)) throw new Error("需要 JSON 对象");
    return data as Partial<AppConfig>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`无法读取设置文件 ${file}：${(error as Error).message}`);
  }
}

export function readLedgerSettings(root: string): Partial<AppConfig> | undefined {
  const file = path.join(root, LEDGER_SETTINGS);
  const entry = fs.lstatSync(file, { throwIfNoEntry: false });
  if (entry && !entry.isFile()) throw new Error(`账本设置路径必须是普通文件：${file}`);
  return entry ? readSettings(file) : undefined;
}

function readActiveLedgerRoot(file: string | undefined): string | undefined {
  if (!file) return undefined;
  try {
    const root = readSettings(file)?.ledgerRoot;
    return typeof root === "string" && path.isAbsolute(root) ? root : undefined;
  } catch (error) {
    console.warn((error as Error).message);
    return undefined;
  }
}

function configSource(dataDir: string, activeLedgerFile?: string) {
  const override = process.env.ACCOUNT_IMPORT_LEDGER_ROOT;
  const selected = override ? path.resolve(override) : readActiveLedgerRoot(activeLedgerFile);
  const discovered = selected ?? discoverLedgerRoot();
  const selectedSettings = selected ? readLedgerSettings(selected) : undefined;
  if (selected && selectedSettings) return { ledgerRoot: selected, settings: selectedSettings, saved: selectedSettings, useLegacy: false };
  const legacy = readSettings(path.join(dataDir, "config.json"));
  const previousRoot = legacy?.ledgerRoot ? path.resolve(PROJECT_ROOT, legacy.ledgerRoot) : undefined;
  const legacyDemo = /(?:^|[/\\])beancount-import-auto[/\\]?$/.test(legacy?.ledgerRoot ?? "") && legacy?.mainFile === "main.beancount";
  const preferredRoot = legacyDemo && discovered ? discovered : previousRoot;
  const ledgerRoot = selected ?? preferredRoot ?? discovered ?? "";
  const saved = ledgerRoot && !selected ? readLedgerSettings(ledgerRoot) : undefined;
  const useLegacy = !saved && legacy && (!previousRoot || legacyDemo || path.relative(previousRoot, ledgerRoot) === "");
  const settings = { ...(saved ?? (useLegacy ? legacy : undefined)) };
  // The old Windows defaults sometimes persisted the Unix fallback before a ledger was selected.
  if (useLegacy && !previousRoot && process.platform === "win32" && settings.pythonPath === "python3") delete settings.pythonPath;
  if (useLegacy && legacyDemo && discovered) {
    const { mainFile, monthlyDir, annualLayout, pythonPath, assetMapping, accounts } = defaultConfig(discovered);
    Object.assign(settings, { mainFile, monthlyDir, annualLayout, pythonPath, assetMapping, accounts });
  }
  return { ledgerRoot, settings, saved, useLegacy: Boolean(useLegacy) };
}

export function readStoredConfig(dataDir: string, activeLedgerFile?: string): Partial<AppConfig> {
  const { ledgerRoot, settings } = configSource(dataDir, activeLedgerFile);
  return { ...settings, ledgerRoot };
}

export function configWithDefaults(ledgerRoot: string, settings: Partial<AppConfig>): AppConfig {
  const defaults = defaultConfig(ledgerRoot ? path.resolve(PROJECT_ROOT, ledgerRoot) : "");
  return {
    ...defaults, ...settings, ledgerRoot,
    llm: { ...defaults.llm, ...settings.llm },
  };
}

export function loadConfig(dataDir: string, activeLedgerFile?: string): AppConfig {
  const { ledgerRoot, settings, saved, useLegacy } = configSource(dataDir, activeLedgerFile);
  const config = configWithDefaults(ledgerRoot, settings);
  // Existing errors are surfaced by the API. Missing Python/native loader is
  // an explicit setup failure, never an empty-account regex fallback.
  if (ledgerRoot && fs.existsSync(path.resolve(ledgerRoot, config.mainFile))) {
    config.pythonPath ||= discoverPython(ledgerRoot);
    const ledger = parseLedger(ledgerRoot, config.mainFile, config.pythonPath);
    const today = new Date().toISOString().slice(0, 10);
    const active = ledger.accounts.filter((a) => accountIsActive(a, today));
    const defined = new Set(ledger.accounts.map((a) => a.account));
    const explicit = (config.assetMapping ?? []).filter((m) => defined.has(m.account));
    const hasSavedMappings = saved && Array.isArray(saved.assetMapping);
    config.assetMapping = hasSavedMappings || explicit.length ? explicit : buildAssetMapping(active);
    config.accounts = active.map((a) => a.account).sort();
    if (useLegacy) {
      saveConfig({ ...config, assetMapping: settings.assetMapping?.length ? settings.assetMapping : config.assetMapping }, { migratedFrom: dataDir, activeLedgerFile });
    }
  }
  return config;
}

export function saveConfig(config: AppConfig, { migratedFrom, activeLedgerFile }: { migratedFrom?: string; activeLedgerFile?: string } = {}) {
  const { ledgerRoot, ...settings } = config;
  if (!ledgerRoot.trim()) throw new Error("请先选择账本目录");
  const directory = path.resolve(PROJECT_ROOT, ledgerRoot);
  if (!fs.statSync(directory, { throwIfNoEntry: false })?.isDirectory()) throw new Error("账本目录不存在");
  const previous = readLedgerSettings(directory);
  const ledgerFile = path.join(directory, LEDGER_SETTINGS);
  atomicJson(ledgerFile, settings);
  if (activeLedgerFile && readActiveLedgerRoot(activeLedgerFile) !== directory) {
    try {
      atomicJson(activeLedgerFile, { ledgerRoot: directory });
    } catch (error) {
      if (previous) atomicJson(ledgerFile, previous);
      else fs.unlinkSync(ledgerFile);
      throw new Error(`无法记住账本目录：${(error as Error).message}`);
    }
  }
  if (migratedFrom) {
    const legacyFile = path.join(migratedFrom, "config.json");
    try { fs.rmSync(legacyFile, { force: true }); }
    catch { console.warn(`设置已迁移，无法移除旧设置文件：${legacyFile}`); }
  }
}
