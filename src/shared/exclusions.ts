import type { ExclusionKind, ParsedTx, ReviewExclusionKind, TxStatus } from "./types.js";

export function exclusionKind(tx: Pick<ParsedTx, "status" | "reviewExclusion" | "excludedReason" | "merge">): ExclusionKind | undefined {
  if (tx.status !== "excluded") return;
  if (tx.reviewExclusion) return tx.reviewExclusion;
  if (tx.excludedReason) return tx.merge ? "manual" : "automatic";
}

export function reviewStatusPatch(tx: Pick<ParsedTx, "status" | "reviewExclusion">, status: TxStatus,
  action: ReviewExclusionKind = "manual"): Pick<ParsedTx, "status" | "reviewExclusion"> {
  const reviewExclusion = status !== "excluded" ? undefined : tx.status === "excluded" ? tx.reviewExclusion : action;
  return reviewExclusion === tx.reviewExclusion ? { status } : { status, reviewExclusion };
}
