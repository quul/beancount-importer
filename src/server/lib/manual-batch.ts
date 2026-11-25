import type { LedgerInfo, ParsedTx } from "../../shared/types.js";
import { MANUAL_BATCH_LABEL, MAX_MANUAL_DESCRIPTION, MAX_MANUAL_ROWS, manualFundingProblem, validateManualTransaction } from "../../shared/manual-batch.js";
import { ImportError } from "./commit.js";

export function readManualBatch(batchId: string, defaultFunding: unknown, rows: unknown, ledger: LedgerInfo, requireCnySettlement = false) {
  const accounts = new Map(ledger.accounts.map((account) => [account.account, account]));
  const defaultAccount = typeof defaultFunding === "string" ? accounts.get(defaultFunding) : undefined;
  const defaultProblem = manualFundingProblem(defaultAccount);
  if (defaultProblem || !defaultAccount) throw new ImportError(400, defaultProblem);
  if (!Array.isArray(rows) || !rows.length || rows.length > MAX_MANUAL_ROWS) {
    throw new ImportError(400, "每批请录入 1 至 " + MAX_MANUAL_ROWS + " 笔交易");
  }
  const file = MANUAL_BATCH_LABEL + " · " + defaultAccount.account;
  const txs = rows.map((row, index): ParsedTx => {
    const line = index + 1, label = "第 " + line + " 笔：";
    if (!row || typeof row.date !== "string" || typeof row.amount !== "string"
      || typeof row.description !== "string" || row.description.length > MAX_MANUAL_DESCRIPTION
      || (row.currency !== undefined && typeof row.currency !== "string")
      || (row.fundingAccount !== undefined && typeof row.fundingAccount !== "string")) {
      throw new ImportError(400, label + "录入内容格式无效");
    }
    const funding = row.fundingAccount ?? defaultAccount.account;
    const { amount, currency, problems } = validateManualTransaction(row, accounts.get(funding), requireCnySettlement);
    const problem = Object.values(problems).find(Boolean);
    if (problem || amount === undefined) throw new ImportError(400, label + (problem ?? problems.amount));
    const id = batchId + "-" + line;
    const isRefund = amount < 0;
    return {
      id, sourceTxId: id, source: "manual", sourceFile: file, row: line, date: row.date,
      amount: Math.abs(amount), direction: isRefund ? "in" : "out", currency, eventType: isRefund ? "refund" : "expense",
      payee: row.description.trim(), note: "", rawCategory: "", rawAccount: funding,
      status: "pending", fundingAccount: funding, fundingConfidence: 1,
      suggestedAccount: "", finalAccount: "", confidence: 0, tags: [], flag: "*",
    };
  });
  return { file, txs };
}
