/**
 * Reads the existing beancount ledger so the importer can:
 *  - learn payee → account mappings from history (better than a fresh LLM call)
 *  - avoid re-importing transactions already booked
 *  - validate that generated entries reference opened accounts
 */

import fs from "node:fs";
import path from "node:path";
import type { LedgerInfo, LedgerTx, ParsedAccount } from "../../shared/types.js";

const ACCOUNT_RE =
  /([A-Z][A-Za-z-]*):([A-Za-z0-9-]+(?::[A-Za-z0-9-]+)*)/g;

function accountType(root: string): ParsedAccount["type"] {
  switch (root) {
    case "Assets":
      return "assets";
    case "Liabilities":
      return "liabilities";
    case "Equity":
      return "equity";
    case "Income":
      return "income";
    case "Expenses":
      return "expenses";
    default:
      return "expenses";
  }
}

export function parseLedgerText(text: string) {
  const accounts = new Map<string, ParsedAccount>();
  const transactions: LedgerTx[] = [];

  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // include "file.beancount"
    const inc = line.match(/^\s*include\s+"([^"]+)"/);
    if (inc) {
      const [, file] = inc;
      // resolved by caller (needs root dir); record as pending
      pendingIncludes.push(file);
    }

    // YYYY-MM-DD open Account
    const open = line.match(
      /^(\d{4}-\d{2}-\d{2})\s+open\s+([A-Z][A-Za-z0-9:-]*)\s*(?:"([^"]*)")?\s*(?:([A-Z]{3,4}))?\s*$/,
    );
    if (open) {
      const [, date, account, , currency] = open;
      accounts.set(account, {
        account,
        type: accountType(account.split(":")[0]),
        openedAt: date,
        currency: currency || undefined,
      });
      i++;
      continue;
    }

    // YYYY-MM-DD * "payee" / "narration"
    const txn = line.match(
      /^(\d{4}-\d{2}-\d{2})\s+[*!]\s*(?:"([^"]*)"\s*)?(?:"([^"]*)")?\s*$/,
    );
    if (txn) {
      const [, date, payee, narration] = txn;
      const postings: LedgerTx["postings"] = [];
      let j = i + 1;
      let seq = 0;
      while (j < lines.length && /^\s+/.test(lines[j])) {
        const pline = lines[j].trim();
        const pm = pline.match(
          /^([A-Z][A-Za-z0-9:-]*)\s+(-?[\d.]+)\s+([A-Z]{3,4})/,
        );
        if (pm) {
          postings.push({
            account: pm[1],
            amount: parseFloat(pm[2]),
            currency: pm[3],
          });
        } else if (/^[A-Z][A-Za-z0-9:-]*\s*$/.test(pline)) {
          postings.push({ account: pline, amount: NaN, currency: "" });
        }
        j++;
        seq++;
      }
      transactions.push({
        id: `ledger-${transactions.length}`,
        date,
        payee: payee || "",
        narration: narration || "",
        postings,
      });
      i = j;
      continue;
    }

    i++;
  }

  return { accounts: [...accounts.values()], transactions };
}

// simple include collector (module-scoped, cleared per parse)
const pendingIncludes: string[] = [];

export function parseLedger(rootDir: string, mainFile: string): LedgerInfo {
  const accounts = new Map<string, ParsedAccount>();
  const transactions: LedgerTx[] = [];
  const payeeIndex: LedgerInfo["payeeIndex"] = {};

  const seen = new Set<string>();

  const loadFile = (abs: string, depth: number) => {
    if (depth > 10 || seen.has(abs)) return;
    if (!fs.existsSync(abs)) return;
    seen.add(abs);
    const text = fs.readFileSync(abs, "utf-8");
    const parsed = parseLedgerText(text);
    for (const a of parsed.accounts) accounts.set(a.account, a);
    transactions.push(...parsed.transactions);
    for (const inc of pendingIncludes.splice(0)) {
      loadFile(path.resolve(path.dirname(abs), inc), depth + 1);
    }
  };

  loadFile(path.resolve(rootDir, mainFile), 0);

  // build payee → account frequency index from history
  for (const t of transactions) {
    if (!t.payee) continue;
    const expenseLeg = t.postings.find(
      (p) =>
        p.account.startsWith("Expenses:") || p.account.startsWith("Income:"),
    );
    if (!expenseLeg) continue;
    const list = (payeeIndex[t.payee] ??= []);
    const existing = list.find((x) => x.account === expenseLeg.account);
    if (existing) existing.count++;
    else list.push({ account: expenseLeg.account, count: 1 });
  }
  for (const k of Object.keys(payeeIndex)) {
    payeeIndex[k].sort((a, b) => b.count - a.count);
  }

  return {
    accounts: [...accounts.values()],
    transactions,
    payeeIndex,
  };
}
