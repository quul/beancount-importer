import type { ParsedTx, TxDecision } from "../../src/shared/types.js";

type ReviewPatch = (tx: ParsedTx) => Partial<ParsedTx>;
export type ReviewPatches = ReadonlyMap<string, ReviewPatch>;

export function reviewPatches(decisions: readonly TxDecision[]): Map<string, ReviewPatch> {
  return new Map(decisions.map(({ id, account, funding, status, tags, flag, reviewNote }) => {
    const fields: Partial<ParsedTx> = {
      ...(account !== undefined && { finalAccount: account }),
      ...(funding !== undefined && { fundingAccount: funding, fundingConfidence: 1, fundingReason: undefined }),
      ...(status !== undefined && { status }),
      ...(status !== undefined && status !== "duplicate" && { duplicateOf: undefined }),
      ...(tags !== undefined && { tags }),
      ...(flag !== undefined && { flag }),
      ...(reviewNote !== undefined && { reviewNote }),
    };
    return [id, (tx) => tx.source === "wechat" && tx.eventType === "refund" && (account !== undefined || status !== undefined)
      ? { ...fields, refundReviewMode: "manual" } : fields];
  }));
}

export function applyPendingReviewPatches(txs: ParsedTx[], pending: readonly ReviewPatches[]): ParsedTx[] {
  if (!pending.length) return txs;
  const rows = new Map(txs.map((tx) => [tx.id, tx]));
  for (const patches of pending) for (const [id, apply] of patches) {
    const tx = rows.get(id);
    if (tx) rows.set(id, { ...tx, ...apply(tx) });
  }
  return txs.map((tx) => rows.get(tx.id)!);
}
