/**
 * Express server: parse → classify → dedup → review → generate pipeline.
 * State is kept in memory per upload batch (suitable for a personal tool).
 */

import express from "express";
import path from "node:path";
import fs from "node:fs";
import multer from "multer";
import type { AppConfig, ImportPreview, ParsedTx } from "../shared/types.js";
import { loadConfig, saveConfig } from "./config.js";
import { parseLedger } from "./lib/ledger.js";
import { markDuplicates } from "./lib/dedup.js";
import {
  classifyLocal,
  classifyWithLlm,
  loadMemory,
  saveMemory,
} from "./lib/classify.js";
import { inferFundingAccount, detectAccounts } from "./lib/accounts.js";
import { generateEntries, suggestOpens } from "./lib/generate.js";
import { isAlipay, parseAlipay } from "./parsers/alipay.js";
import { isWechat, parseWechat } from "./parsers/wechat.js";
import { parseYunshanfu, isYunshanfu } from "./parsers/yunshanfu.js";
import { detectBank, parseBank } from "./parsers/banks.js";
import { parsePdfBank } from "./parsers/pdf.js";
import { pairTransfers } from "./lib/transfers.js";
import { readSheet, findHeader } from "./parsers/common.js";

const ROOT = path.resolve(import.meta.dirname, "../..");
const DATA_DIR = path.join(ROOT, "server-data");
fs.mkdirSync(DATA_DIR, { recursive: true });

let config = loadConfig(DATA_DIR);
const memory = loadMemory(path.join(DATA_DIR, "memory.json"));

function ledgerRoot(): string {
  return path.resolve(ROOT, config.ledgerRoot);
}

const app = express();
app.use(express.json({ limit: "50mb" }));
const upload = multer({ dest: path.join(DATA_DIR, "uploads") });

/** in-memory batch store: batchId → preview */
const batches = new Map<string, ImportPreview & { createdAt: number }>();

app.post("/api/upload", upload.array("files"), async (req, res) => {
  const files = (req.files as Express.Multer.File[]) ?? [];
  if (!files.length) {
    res.status(400).json({ error: "no files" });
    return;
  }

  const ledger = parseLedger(ledgerRoot(), config.mainFile);
  const allTxs: ParsedTx[] = [];
  const allErrors: ImportPreview["errors"] = [];
  let source: ImportPreview["source"] = "unknown";

  for (const f of files) {
    const name = f.originalname;
    let result = null;

    try {
      if (isAlipay(f.path, name)) result = parseAlipay(f.path);
      else if (isWechat(name)) result = parseWechat(f.path);
      else if (isYunshanfu(name)) result = parseYunshanfu(f.path);
      else if (name.toLowerCase().endsWith(".pdf")) {
        const bankDef = detectBank(name, []);
        result = await parsePdfBank(f.path, bankDef?.source ?? "bank-generic");
      } else {
        const { rows } = readSheet(f.path);
        const bankDef = detectBank(name, rows);
        if (bankDef) result = parseBank(f.path, bankDef);
      }
    } catch (e) {
      allErrors.push({ row: 0, message: `${name}: 解析失败 ${(e as Error).message}` });
      continue;
    }

    if (!result) {
      allErrors.push({ row: 0, message: `${name}: 无法识别账单类型` });
      continue;
    }
    source = result.source;
    for (const raw of result.txs) {
      const tx: ParsedTx = {
        ...raw,
        sourceFile: name,
        status: "pending",
        fundingAccount: "",
        suggestedAccount: "Expenses:Other",
        confidence: 0,
        finalAccount: "",
      };
      const funding = inferFundingAccount(tx, config);
      tx.fundingAccount = funding.account;

      // local classification
      const local = classifyLocal(tx, memory, ledger);
      if (local) {
        tx.suggestedAccount = local.account;
        tx.confidence = local.confidence;
        tx.reason = local.reason;
      }
      allTxs.push(tx);
    }
    allErrors.push(...result.errors.map((e) => ({ row: e.row, message: `${name}: ${e.message}` })));
  }

  // LLM batch for unresolved
  const unresolved = allTxs.filter((t) => t.confidence < 0.7);
  if (unresolved.length) {
    const llmResults = await classifyWithLlm(unresolved, config, ledger);
    for (const tx of allTxs) {
      const hit = llmResults.get(tx.id);
      if (hit && hit.confidence >= tx.confidence) {
        tx.suggestedAccount = hit.account;
        tx.confidence = hit.confidence;
        tx.reason = hit.reason;
      }
    }
  }

  // finalize suggestions: auto-accept high confidence, else Expenses:Other
  for (const tx of allTxs) {
    tx.finalAccount =
      tx.confidence >= 0.9 && tx.status === "pending" ? tx.suggestedAccount : tx.suggestedAccount;
    if (tx.status === "pending" && tx.confidence >= 0.9) tx.status = "ready";
  }

  // transfer pairing (credit-card repayment, self-transfer, top-up)
  const { pairs } = pairTransfers(allTxs);

  // dedup against siblings + ledger
  const { txs: deduped, stats } = markDuplicates(allTxs, ledger.transactions);

  const batchId = `b${Date.now()}`;
  const preview: ImportPreview & { createdAt: number } = {
    file: files.map((f) => f.originalname).join(", "),
    source,
    txCount: deduped.length,
    txs: deduped,
    errors: allErrors,
    accountsDetected: detectAccounts(deduped).map((d) => ({
      ...d,
      guess: d.raw,
    })),
    createdAt: Date.now(),
  };
  batches.set(batchId, preview);

  res.json({
    batchId,
    preview: {
      ...preview,
      txs: undefined,
      txCount: deduped.length,
      dedup: { ...stats, transferPairs: pairs.length },
      lowConfidence: deduped.filter((t) => t.confidence < 0.7 && t.status === "pending").length,
    },
  });
});

app.get("/api/batch/:id", (req, res) => {
  const b = batches.get(req.params.id);
  if (!b) {
    res.status(404).json({ error: "batch not found" });
    return;
  }
  res.json(b);
});

app.post("/api/batch/:id/decide", (req, res) => {
  const b = batches.get(req.params.id);
  if (!b) {
    res.status(404).json({ error: "batch not found" });
    return;
  }
  const { decisions } = req.body as {
    decisions: Array<{ id: string; account?: string; funding?: string; status?: string }>;
  };
  for (const d of decisions) {
    const tx = b.txs.find((t) => t.id === d.id);
    if (!tx) continue;
    if (d.account) {
      tx.finalAccount = d.account;
      // remember user decision
      const key = `${tx.payee.replace(/\s+/g, "").slice(0, 32)}|${tx.rawCategory.slice(0, 24)}`;
      memory.mapping[key] = d.account;
    }
    if (d.funding) tx.fundingAccount = d.funding;
    if (d.status) tx.status = d.status as ParsedTx["status"];
    else if (d.account) tx.status = "ready";
  }
  saveMemory(path.join(DATA_DIR, "memory.json"), memory);
  res.json({ ok: true, ready: b.txs.filter((t) => t.status === "ready").length });
});

app.post("/api/batch/:id/generate", (req, res) => {
  const b = batches.get(req.params.id);
  if (!b) {
    res.status(404).json({ error: "batch not found" });
    return;
  }
  const ledger = parseLedger(ledgerRoot(), config.mainFile);
  const { entries, monthFiles, generated } = generateEntries(b.txs);
  const opens = suggestOpens(
    b.txs,
    new Set(ledger.accounts.map((a) => a.account)),
  );
  res.json({ entries, monthFiles, generated: generated.length, opens });
});

/** Commit: append monthly files into the ledger dir and update includes. */
app.post("/api/batch/:id/commit", (req, res) => {
  const b = batches.get(req.params.id);
  if (!b) {
    res.status(404).json({ error: "batch not found" });
    return;
  }
  const { monthFiles, opens } = req.body as {
    monthFiles: Record<string, string>;
    opens: string[];
  };
  const root = ledgerRoot();
  const monthlyDir = path.resolve(root, config.monthlyDir);
  fs.mkdirSync(monthlyDir, { recursive: true });

  const written: string[] = [];
  for (const [month, body] of Object.entries(monthFiles)) {
    const file = path.join(monthlyDir, `${month}.beancount`);
    fs.appendFileSync(file, body, "utf-8");
    written.push(`${config.monthlyDir}/${month}.beancount`);
  }

  // ensure includes in main file
  const mainPath = path.resolve(root, config.mainFile);
  let mainText = fs.existsSync(mainPath) ? fs.readFileSync(mainPath, "utf-8") : "";
  for (const w of written) {
    const inc = `include "${w}"`;
    if (!mainText.includes(inc)) mainText += `\n${inc}`;
  }
  if (opens.length) {
    mainText += `\n; auto-open accounts\n${opens.join("\n")}\n`;
  }
  fs.writeFileSync(mainPath, mainText, "utf-8");

  res.json({ ok: true, written, opens });
});

/** Validate the ledger with `bean-check` if beancount is installed. */
app.get("/api/validate", async (req, res) => {
  const main = path.resolve(ledgerRoot(), config.mainFile);
  try {
    const { spawn } = await import("node:child_process");
    const proc = spawn("bean-check", [main]);
    let stdout = "", stderr = "";
    // ENOENT arrives as an async 'error' event, not a throw; guard against
    // double-responding when both error and close fire
    let responded = false;
    proc.on("error", () => {
      if (responded) return;
      responded = true;
      res.json({ available: false, ok: false, output: "bean-check 未安装（pip install beancount）" });
    });
    proc.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    proc.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    const code = await new Promise<number>((resolve) => proc.on("close", resolve));
    if (responded) return;
    responded = true;
    res.json({ available: true, ok: code === 0, output: (stdout + stderr).trim() || "(no output)" });
  } catch {
    res.json({ available: false, ok: false, output: "bean-check 未安装（pip install beancount）" });
  }
});

/** Launch fava on the ledger (idempotent: returns existing port if running). */
let favaProc: ReturnType<typeof import("node:child_process").spawn> | null = null;
app.post("/api/fava", async (req, res) => {
  const port = 5000;
  if (favaProc && !favaProc.killed) {
    res.json({ running: true, port, alreadyRunning: true });
    return;
  }
  try {
    const { spawn } = await import("node:child_process");
    favaProc = spawn(
      "fava",
      ["-p", String(port), "-H", "127.0.0.1", path.resolve(ledgerRoot(), config.mainFile)],
      { stdio: "ignore", detached: false },
    );
    // ENOENT arrives as async 'error' event; guard against double-responding
    let responded = false;
    favaProc.on("error", () => {
      if (responded) return;
      responded = true;
      favaProc = null;
      res.json({ running: false, port, error: "fava 未安装（pip install fava）" });
    });
    favaProc.on("exit", () => (favaProc = null));
    // fava needs a moment to boot
    await new Promise((r) => setTimeout(r, 1500));
    if (responded) return;
    responded = true;
    res.json({ running: true, port, alreadyRunning: false });
  } catch {
    res.json({ running: false, port, error: "fava 未安装（pip install fava）" });
  }
});

app.get("/api/ledger", (req, res) => {
  const ledger = parseLedger(ledgerRoot(), config.mainFile);
  res.json({
    accountCount: ledger.accounts.length,
    txCount: ledger.transactions.length,
    accounts: ledger.accounts,
  });
});

app.get("/api/config", (req, res) => res.json(config));
app.post("/api/config", (req, res) => {
  config = { ...config, ...(req.body as Partial<AppConfig>) };
  saveConfig(DATA_DIR, config);
  res.json(config);
});

const PORT = Number(process.env.PORT ?? 8787);
app.listen(PORT, () => {
  console.log(`bean-import server → http://localhost:${PORT}`);
});
