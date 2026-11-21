import { isFundingAccount, normalizePaymentMethod, singlePaymentMethod } from "../../shared/funding.js";
import type { LedgerTx, ParsedTx, RefundEvidence } from "../../shared/types.js";
import { cardSuffix, statementRefundEvidence } from "../parsers/refund-evidence.js";

type RefundCopy = {
  source: string;
  date: string;
  time?: string;
  payee: string;
  sourceTxId?: string;
  sourceFile?: string;
  sourceFileHash?: string;
  rawAccount: string;
  refundEvidence?: RefundEvidence;
  fundingAccount: string;
  currency: string;
  amount: number;
};

const refundPrefix = /^(?:(?:退款|退货|撤销|冲正)\s*[-–—:·]\s*)+/u;
const platformPrefix = /^(支付宝|财付通|微信支付|微信|云闪付)\s*[-–—:·*]\s*/u;
const platforms: Readonly<Record<string, string>> = { 支付宝: "alipay", 财付通: "wechat", 微信支付: "wechat", 微信: "wechat", 云闪付: "yunshanfu" };
const platformSources = new Set(Object.values(platforms));
const merchantLabel = (payee: string) => payee.normalize("NFKC").trim().replace(refundPrefix, "");
const platform = ({ source, payee }: RefundCopy) => platformSources.has(source) ? source : platforms[merchantLabel(payee).match(platformPrefix)?.[1] ?? ""];
const paymentLabel = (tx: RefundCopy) => normalizePaymentMethod(tx.refundEvidence?.cardIdentity ?? tx.rawAccount).replace(/\s+/g, "");

function copyKey(tx: RefundCopy): string | undefined {
  const merchant = merchantLabel(tx.payee).replace(platformPrefix, "").replace(refundPrefix, "").replace(/\s+/g, "").toLowerCase();
  if (!tx.date || !Number.isFinite(tx.amount) || tx.amount <= 0 || !isFundingAccount(tx.fundingAccount) || !/[\p{L}\p{N}]/u.test(merchant)) return;
  return JSON.stringify([tx.date, merchant, tx.fundingAccount, tx.currency, tx.amount]);
}

function sameRefundCopy(a: RefundCopy, b: RefundCopy): boolean {
  if (a.time && b.time && a.time !== b.time) return false;
  const aPayment = paymentLabel(a), bPayment = paymentLabel(b);
  const aCard = cardSuffix(aPayment), bCard = cardSuffix(bPayment);
  if (a.source === b.source) {
    // Same-source IDs already use durable deduplication. ID-less statement rows need a known card and different files.
    if (a.sourceTxId || b.sourceTxId || !(aCard || a.refundEvidence?.cardIdentity) || aPayment !== bPayment) return false;
    return a.sourceFileHash && b.sourceFileHash ? a.sourceFileHash !== b.sourceFileHash
      : Boolean(a.sourceFile && b.sourceFile && a.sourceFile !== b.sourceFile);
  }
  if (aCard && bCard && aCard !== bCard) return false;
  const aPlatform = platform(a), bPlatform = platform(b);
  return !aPlatform || !bPlatform || aPlatform === bPlatform;
}

function hasCopyEvidence(tx: ParsedTx): boolean {
  if (tx.eventType !== "refund" || tx.direction !== "in" || tx.merge || tx.reviewConflictId || tx.excludedReason
    || (tx.status === "duplicate" && tx.duplicateOf?.refundCopy !== "statement") || tx.fundingAccount2 || statementRefundEvidence(tx)?.unconfirmed) return false;
  if (tx.postings) {
    const funding = tx.postings.filter((posting) => isFundingAccount(posting.account));
    return funding.length === 1 && funding[0].account === tx.fundingAccount && funding[0].amount === tx.amount && funding[0].currency === tx.currency;
  }
  return Boolean(tx.refundEvidence?.cardIdentity || singlePaymentMethod(tx));
}

function indexRefundCopies<T extends RefundCopy>(rows: readonly T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = copyKey(row);
    if (!key) continue;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return groups;
}

function compareRefundCopies(a: ParsedTx, b: ParsedTx, pairs: ReadonlyMap<string, string>): number {
  return Number(a.status === "ready") - Number(b.status === "ready")
    || Number(a.refundReviewMode === "manual") - Number(b.refundReviewMode === "manual")
    || Number(pairs.has(a.id)) - Number(pairs.has(b.id))
    || Number(Boolean(a.sourceTxId)) - Number(Boolean(b.sourceTxId))
    || Number(Boolean(a.reviewNote || a.narration)) - Number(Boolean(b.reviewNote || b.narration))
    || a.id.localeCompare(b.id);
}

/** Collapse only a mutual, unique copy. Every retained row keeps its original source identity. */
export function findStatementRefundCopies(txs: readonly ParsedTx[], pairs: ReadonlyMap<string, string>): Map<string, ParsedTx> {
  const retainedByCopy = new Map(txs.flatMap((tx) => tx.duplicateOf?.refundCopy === "statement" ? [[tx.id, tx.duplicateOf.id] as const] : []));
  const retainedIds = new Set(retainedByCopy.values());
  const candidates = txs.filter((tx) => hasCopyEvidence(tx) && (tx.status !== "excluded" || retainedIds.has(tx.id)));
  const copies = new Map<string, ParsedTx>();
  for (const group of indexRefundCopies(candidates).values()) {
    if (group.length < 2) continue;
    const matches = new Map(group.map((tx) => [tx.id, group.filter((other) => sameRefundCopy(tx, other)
      && (tx.status !== "excluded" || retainedByCopy.get(other.id) === tx.id)
      && (other.status !== "excluded" || retainedByCopy.get(tx.id) === other.id))]));
    for (const tx of group) {
      const others = matches.get(tx.id)!;
      if (tx.status === "excluded" || others.length !== 1) continue;
      const [other] = others;
      if (matches.get(other.id)?.length === 1 && (other.status === "excluded" || compareRefundCopies(tx, other, pairs) < 0)) copies.set(tx.id, other);
    }
  }
  return copies;
}

/** A previous imported refund supplies direction, source and the exact booked funding leg. */
export function findPostedRefundCopies(txs: readonly ParsedTx[], ledger: readonly LedgerTx[], statementCopies: ReadonlyMap<string, ParsedTx>): Map<string, LedgerTx> {
  const incoming = indexRefundCopies(txs.filter((tx) => tx.status !== "excluded" && hasCopyEvidence(tx)));
  const copies = new Map<string, LedgerTx>();
  if (!incoming.size) return copies;
  const posted = ledger.flatMap((tx) => {
    const source = tx.source ?? tx.metadata?.["import-source"];
    if (!source || tx.metadata?.["import-event"] !== "refund") return [];
    const funding = tx.postings.filter((posting) => isFundingAccount(posting.account));
    if (funding.length !== 1 || funding[0].amount <= 0) return [];
    const [{ account: fundingAccount, amount, currency }] = funding;
    return [{ tx, source, date: tx.date, time: tx.time, payee: tx.payee, sourceTxId: tx.sourceTxId ?? tx.metadata?.["import-id"],
      sourceFile: tx.metadata?.["source-file"], sourceFileHash: tx.metadata?.["source-file-hash"], rawAccount: tx.metadata?.["source-account"] ?? "",
      fundingAccount, amount, currency }];
  });
  const postedByKey = indexRefundCopies(posted);
  for (const [key, group] of incoming) {
    const entries = postedByKey.get(key);
    if (!entries) continue;
    const byRefund = new Map<string, ParsedTx[]>();
    for (const row of group) {
      const id = statementCopies.get(row.id)?.id ?? row.id;
      const members = byRefund.get(id) ?? [];
      members.push(row);
      byRefund.set(id, members);
    }
    const claims = new Map<string, number>();
    const candidates = [...byRefund.values()].map((members) => {
      const matches = entries.filter((entry) => members.some((row) => sameRefundCopy(row, entry)));
      for (const { tx } of matches) claims.set(tx.id, (claims.get(tx.id) ?? 0) + 1);
      return { members, matches };
    });
    for (const { members, matches } of candidates) {
      if (matches.length !== 1 || claims.get(matches[0].tx.id) !== 1) continue;
      for (const row of members) copies.set(row.id, matches[0].tx);
    }
  }
  return copies;
}
