import type { ParsedTx, TxDecision } from "../../src/shared/types.js";
import { missingPostingAccount, statusAfterCategorization } from "../../src/shared/postings.js";

type ReviewPatch = (tx: ParsedTx, rows: ReadonlyMap<string, ParsedTx>) => Partial<ParsedTx>;
export type ReviewPatches = ReadonlyMap<string, ReviewPatch>;

export function reviewPatches(decisions: readonly TxDecision[]): Map<string, ReviewPatch> {
  return new Map(decisions.map(({ id, account, funding, status, tags, flag, reviewNote }) => {
    const fields: Partial<ParsedTx> = {
      ...(account !== undefined && { finalAccount: account }),
      ...(funding !== undefined && { fundingAccount: funding, fundingConfidence: 1, fundingReason: undefined }),
      ...(tags !== undefined && { tags }),
      ...(flag !== undefined && { flag }),
      ...(reviewNote !== undefined && { reviewNote }),
    };
    return [id, (tx) => {
      const updated = { ...fields };
      if (account !== undefined && tx.fundingAccount2 && !tx.postings) updated.fundingAccount2 = account;
      const edited = { ...tx, ...updated };
      const nextStatus = status === "ready" && missingPostingAccount(edited) ? undefined
        : status ?? (account === undefined ? undefined : statusAfterCategorization(edited));
      const manualRefund = tx.eventType === "refund"
        && (account !== undefined || status !== undefined);
      return {
        ...updated,
        ...(nextStatus !== undefined && { status: nextStatus }),
        ...(nextStatus !== undefined && nextStatus !== "duplicate" && { duplicateOf: undefined }),
        ...(manualRefund && { refundReviewMode: "manual" }),
      };
    }];
  }));
}

export function applyPendingReviewPatches(txs: ParsedTx[], pending: readonly ReviewPatches[]): ParsedTx[] {
  if (!pending.length) return txs;
  const rows = new Map(txs.map((tx) => [tx.id, tx]));
  for (const patches of pending) for (const [id, apply] of patches) {
    const tx = rows.get(id);
    if (tx) rows.set(id, { ...tx, ...apply(tx, rows) });
  }
  return txs.map((tx) => rows.get(tx.id)!);
}
