import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AppConfig } from "../shared/types.js";
import { discoverPython, parseLedger } from "./lib/ledger.js";
import { accountIsActive, buildAssetMapping } from "./lib/accounts.js";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../..");

/** Find a local accounting checkout without storing a personal absolute path in source. */
export function discoverLedgerRoot(): string | undefined {
  if (process.env.ACCOUNT_IMPORT_LEDGER_ROOT) return path.resolve(process.env.ACCOUNT_IMPORT_LEDGER_ROOT);
  let ancestor = PROJECT_ROOT;
  while (true) {
    const candidate = path.join(ancestor, "accounting");
    if (fs.existsSync(path.join(candidate, "main.bean"))) return candidate;
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const candidate = path.join(os.homedir(), "workspace", "accounting");
  return fs.existsSync(path.join(candidate, "main.bean")) ? candidate : undefined;
}

function defaultConfig(ledgerRoot: string): AppConfig {
  return {
    ledgerRoot,
    mainFile: "main.bean",
    monthlyDir: "years/{year}/imported",
    annualLayout: true,
    pythonPath: discoverPython(ledgerRoot),
    assetMapping: [],
    accounts: [],
    llm: { provider: "off", apiBase: "https://api.openai.com/v1", model: "", apiKey: "" },
  };
}

export function loadConfig(root: string): AppConfig {
  const file = path.join(root, "config.json");
  const raw = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf-8")) as Partial<AppConfig> : {};
  const discovered = discoverLedgerRoot();
  const legacyDemo = /(?:^|[/\\])beancount-import-auto[/\\]?$/.test(raw.ledgerRoot || "") && raw.mainFile === "main.beancount";
  const migrate = legacyDemo && !!discovered;
  const ledgerRoot = migrate ? discovered! : raw.ledgerRoot ?? discovered ?? "";
  const absoluteRoot = path.resolve(PROJECT_ROOT, ledgerRoot);
  const defaults = defaultConfig(absoluteRoot);
  const config: AppConfig = {
    ...defaults,
    ...raw,
    ledgerRoot,
    ...(migrate ? { mainFile: "main.bean", monthlyDir: defaults.monthlyDir, annualLayout: true, pythonPath: defaults.pythonPath, assetMapping: [], accounts: [] } : {}),
    llm: { ...defaults.llm, ...(raw.llm ?? {}) },
  };
  // Existing errors are surfaced by the API. Missing Python/native loader is
  // an explicit setup failure, never an empty-account regex fallback.
  if (ledgerRoot && fs.existsSync(path.resolve(absoluteRoot, config.mainFile))) {
    config.pythonPath ||= discoverPython(absoluteRoot);
    const ledger = parseLedger(absoluteRoot, config.mainFile, config.pythonPath);
    const today = new Date().toISOString().slice(0, 10);
    const active = ledger.accounts.filter((a) => accountIsActive(a, today));
    const defined = new Set(ledger.accounts.map((a) => a.account));
    const explicit = (config.assetMapping ?? []).filter((m) => defined.has(m.account));
    config.assetMapping = explicit.length ? explicit : buildAssetMapping(active);
    config.accounts = active.map((a) => a.account).sort();
  }
  if (!fs.existsSync(file) || migrate) saveConfig(root, config);
  return config;
}

export function saveConfig(root: string, config: AppConfig) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify(config, null, 2), { encoding: "utf-8", mode: 0o600 });
}
