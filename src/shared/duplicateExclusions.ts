import { isFundingAccount } from "./funding.js";
import { canExcludeSuspectedDuplicate, crossSourceDuplicateReviewIssue, CROSS_SOURCE_MATCH_REASON, type ParsedTx } from "./types.js";

function merchantName(payee: string): string {
  return payee.normalize("NFKC").trim().replace(/^(?:(?:支付宝|财付通|微信支付|微信|云闪付)\s*[-–—:·*]\s*)+/u, "")
    .replace(/\s+/g, "").toLowerCase();
}

function sameCrossSourceTransaction(tx: ParsedTx, other: ParsedTx): boolean {
  if (tx.source === other.source || tx.merge || other.merge || !tx.date || tx.date !== other.date
    || !Number.isFinite(tx.amount) || tx.amount <= 0 || tx.amount !== other.amount || tx.currency !== other.currency
    || (tx.time && other.time && tx.time !== other.time)
    || tx.direction !== other.direction || (tx.eventType && other.eventType && tx.eventType !== other.eventType)
    || tx.fundingAccount !== other.fundingAccount || !isFundingAccount(tx.fundingAccount)) return false;
  const merchant = merchantName(tx.payee);
  return /[\p{L}\p{N}]/u.test(merchant) && merchant === merchantName(other.payee);
}

function hasReviewDetails(tx: ParsedTx): boolean {
  return Boolean(tx.reviewNote || tx.narration || tx.tags?.length || tx.flag === "!");
}

function compareCopies(a: ParsedTx, b: ParsedTx): number {
  return Number(a.status === "ready") - Number(b.status === "ready")
    || Number(Boolean(a.postings?.length)) - Number(Boolean(b.postings?.length))
    || Number(Boolean(a.finalAccount)) - Number(Boolean(b.finalAccount))
    || Number(hasReviewDetails(a)) - Number(hasReviewDetails(b))
    || Number(Boolean(a.sourceTxId)) - Number(Boolean(b.sourceTxId))
    || a.id.localeCompare(b.id);
}

export function planSuspectedDuplicateExclusions(txs: readonly ParsedTx[]): ParsedTx[] {
  const byId = new Map(txs.map((tx) => [tx.id, tx]));
  const crossSourceIds = new Set<string>();
  const uniqueMatches = new Map<string, ParsedTx>();
  for (const tx of txs) {
    if (tx.issues?.some(crossSourceDuplicateReviewIssue)) crossSourceIds.add(tx.id);
    const candidates = new Set<ParsedTx>();
    for (const { id, reason } of tx.matches ?? []) {
      if (reason !== CROSS_SOURCE_MATCH_REASON) continue;
      crossSourceIds.add(tx.id);
      const other = byId.get(id);
      if (!other || tx.source === other.source) continue;
      crossSourceIds.add(other.id);
      if (sameCrossSourceTransaction(tx, other)) candidates.add(other);
    }
    if (candidates.size === 1) uniqueMatches.set(tx.id, [...candidates][0]);
  }

  return txs.filter((tx) => {
    if (tx.excludedReason || !canExcludeSuspectedDuplicate(tx)) return false;
    if (!crossSourceIds.has(tx.id)) return true;
    const other = uniqueMatches.get(tx.id);
    return Boolean(other && uniqueMatches.get(other.id) === tx && !other.excludedReason
      && canExcludeSuspectedDuplicate(other) && compareCopies(tx, other) < 0);
  });
}
