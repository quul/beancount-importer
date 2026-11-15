/**
 * Generate beancount entries from confirmed transactions, grouped per month.
 * Also generates balance assertions from statement-provided running balances.
 */

import type { GenerateResult, ParsedTx } from "../../shared/types.js";

function fmtAmount(n: number): string {
  return n.toFixed(2);
}

function esc(s: string): string {
  return s.replace(/"/g, "'");
}

/**
 * Multi-leg logic:
 *  - alipay/wechat tx funded by a bank card → the money never touched the
 *    alipay balance; postings: expense + bank card directly. We keep the
 *    alipay payee/note for categorization but the funding leg is the bank.
 *  - income txs: reverse posting order (income account negative).
 *  - credit card (kind=credit) funding → Liabilities account.
 */
export function generateEntries(txs: ParsedTx[]): GenerateResult {
  const monthFiles: Record<string, string> = {};
  const generated: string[] = [];

  for (const tx of txs) {
    if (tx.status !== "ready") continue;
    const month = tx.date.slice(0, 7).replace("-", "");
    const buf = (monthFiles[month] ??= "");
    void buf;

    const lines: string[] = [];
    const narration = [tx.note, tx.rawCategory].filter(Boolean).join(" · ").slice(0, 60);
    lines.push(
      `${tx.date} * "${esc(tx.payee || tx.rawAccount || "未知")}"${narration ? ` "${esc(narration)}"` : ""}`,
    );

    const amt = fmtAmount(tx.amount);
    if (tx.fundingAccount2) {
      // paired transfer: money moves from fundingAccount to fundingAccount2
      // (e.g. bank → credit card repayment): bank -X, card +X
      lines.push(`  ${tx.fundingAccount2}  ${amt} CNY`);
      lines.push(`  ${tx.fundingAccount}  -${amt} CNY`);
    } else if (tx.direction === "out") {
      lines.push(`  ${tx.finalAccount}  ${amt} CNY`);
      lines.push(`  ${tx.fundingAccount}  -${amt} CNY`);
    } else {
      lines.push(`  ${tx.fundingAccount}  ${amt} CNY`);
      lines.push(`  ${tx.finalAccount}  -${amt} CNY`);
    }

    // balance assertion from statement running balance (bank statements)
    if (tx.balanceAfter != null && tx.fundingAccount && !tx.fundingAccount2) {
      lines.push(`  ${tx.fundingAccount} = ${fmtAmount(tx.balanceAfter)} CNY ; balance from ${tx.source}`);
    }
    // paired transfer: assert the receiving account too
    if (tx.balanceAfter != null && tx.fundingAccount2) {
      lines.push(`  ${tx.fundingAccount2} = ${fmtAmount(tx.balanceAfter)} CNY ; balance from ${tx.source}`);
    }

    lines.push("");
    monthFiles[month] = (monthFiles[month] || "") + lines.join("\n");
    generated.push(tx.id);
  }

  const entries = Object.entries(monthFiles)
    .map(([m, body]) => `; ===== ${m} =====\n${body}`)
    .join("\n");

  return { entries, monthFiles, generated };
}

/** Suggest `open` directives for accounts that don't exist in the ledger yet. */
export function suggestOpens(
  txs: ParsedTx[],
  existingAccounts: Set<string>,
): string[] {
  const needed = new Set<string>();
  for (const tx of txs) {
    if (tx.status !== "ready") continue;
    for (const acc of [tx.finalAccount, tx.fundingAccount, tx.fundingAccount2]) {
      if (acc && !existingAccounts.has(acc)) needed.add(acc);
    }
  }
  const today = new Date().toISOString().slice(0, 10);
  return [...needed].sort().map((a) => `${today} open ${a}`);
}
