import { createHash } from "node:crypto";
import { amountUnits } from "../../shared/categoryAllocations.js";
import { isFundingAccount } from "../../shared/funding.js";
import { amountText } from "../../shared/postings.js";
import { splitChargeKind, splitChargeMemberIds } from "../../shared/split-charges.js";
import { activeTransactions, sourceKey } from "../../shared/transactionMerge.js";
import { isSuspectedDuplicate, type LedgerTx, type ParsedTx, type SplitChargeLine, type SplitChargeMatch, type SplitChargeReview } from "../../shared/types.js";
import { cardSuffix, statementRefundEvidence } from "../parsers/refund-evidence.js";
import { ledgerSourceKeys } from "./dedup.js";

const DAY = 86_400_000;
const WINDOW_DAYS = 2;
const MAX_PART_ROWS = 16, MAX_RESULTS = 80, MAX_STEPS = 60_000;
type Line = SplitChargeLine & {
  units: bigint; account: string; currency: string; source?: string; sourceIdentity?: string; refundOf?: string; card?: string; merchant?: string;
};
const byDate = (a: SplitChargeLine, b: SplitChargeLine) => a.date.localeCompare(b.date)
  || (a.time && b.time ? a.time.localeCompare(b.time) : 0);
const ordered = (a: SplitChargeLine, b: SplitChargeLine) => byDate(a, b) <= 0;
const day = (date: string) => Date.parse(date) / DAY;
const unitsFor = (amount: number) => amountUnits(String(amount)) ?? (Number(amountText(amount)) === amount ? amountUnits(amountText(amount)) : undefined);
const normalized = (value?: string) => value?.normalize("NFKC").trim();
const merchant = (value: string) => value.normalize("NFKC").replace(/\s/g, "").toLowerCase();
const groupKey = (row: Pick<Line, "account" | "currency">) => JSON.stringify([row.account, row.currency]);
const offsetKey = (row: Pick<Line, "account" | "currency" | "date" | "units">, direction: string) =>
  JSON.stringify([row.account, row.currency, row.date, row.units.toString(), direction]);
const sameOrder = (a: Line, b: Line) => Boolean(a.orderId && a.orderId === b.orderId && a.source === b.source);
const differentCard = (a: Line, b: Line) => Boolean(a.card && b.card && a.card !== b.card);
const publicLine = (row: Line): SplitChargeLine => ({
  id: row.id, date: row.date, time: row.time, amount: row.amount, payee: row.payee,
  sourceTxId: row.sourceTxId, orderId: row.orderId, file: row.file, line: row.line, posted: row.posted,
});

function draftLine(tx: ParsedTx): Line | undefined {
  const units = unitsFor(tx.amount);
  if (!units || units < 0n) return;
  return { id: tx.id, date: tx.date, time: tx.time, amount: tx.amount, units, currency: tx.currency, account: tx.fundingAccount,
    payee: tx.payee || tx.note, file: tx.sourceFile, line: tx.row, source: tx.source, sourceTxId: tx.sourceTxId,
    orderId: normalized(tx.orderId), sourceIdentity: sourceKey(tx.source, tx.sourceTxId, tx.sourceFileHash, tx.row),
    refundOf: statementRefundEvidence(tx)?.originalSourceTxId, card: cardSuffix(tx.rawAccount), merchant: merchant(tx.payee) };
}

function add<T>(index: Map<string, T[]>, key: string, value: T) {
  const rows = index.get(key);
  if (rows) rows.push(value);
  else index.set(key, [value]);
}

export function findSplitChargeReview(txs: readonly ParsedTx[], ledger: readonly LedgerTx[], saved: readonly SplitChargeMatch[] = []): SplitChargeReview {
  const active = activeTransactions(txs);
  const byId = new Map(active.map((tx) => [tx.id, tx]));
  const confirmed = saved.map((match) => ({
    ...match, canExcludeOffsets: false,
    offsetsExcluded: Boolean(match.refund && !match.original.posted && byId.get(match.original.id)?.status === "excluded"
      && byId.get(match.refund.id)?.status === "excluded"),
  }));
  const debitIndex = new Map<string, Line[]>(), refunds: Line[] = [];
  for (const tx of active) {
    const kind = splitChargeKind(tx);
    if (!kind) continue;
    const row = draftLine(tx);
    if (!row) continue;
    if (kind === "refund") refunds.push(row);
    else add(debitIndex, groupKey(row), row);
  }
  const needed = new Map<string, Set<string>>();
  for (const row of refunds) {
    const key = groupKey(row);
    if ((debitIndex.get(key)?.length ?? 0) < 2) continue;
    const dates = needed.get(key) ?? new Set<string>();
    for (let index = 0; index <= WINDOW_DAYS; index++) dates.add(new Date((day(row.date) - index) * DAY).toISOString().slice(0, 10));
    needed.set(key, dates);
  }
  const postedIndex = new Map<string, Line[]>(), postedOffsets = new Set<string>(), postedIdentities = new Set<string>();
  for (const tx of ledger) {
    for (const key of ledgerSourceKeys(tx)) postedIdentities.add(key);
    const funding = tx.postings.filter((posting) => isFundingAccount(posting.account));
    for (const posting of funding) {
      const { account, currency, amount } = posting;
      const key = groupKey(posting);
      if (!needed.get(key)?.has(tx.date)) continue;
      const units = unitsFor(Math.abs(amount));
      if (!units) continue;
      postedOffsets.add(offsetKey({ account, currency, date: tx.date, units }, amount < 0 ? "out" : "in"));
      if (amount >= 0 || funding.length !== 1 || !tx.postings.some((leg) => leg.account.startsWith("Expenses:") && leg.amount > 0)
        || ["refund", "transfer", "income"].includes(tx.metadata?.["import-event"] ?? "")) continue;
      add(postedIndex, key, { id: "posted:" + tx.id, date: tx.date, time: tx.time, account, currency, amount: -amount, units,
        payee: tx.payee || tx.narration, source: tx.source ?? tx.metadata?.["import-source"],
        sourceTxId: tx.sourceTxId ?? tx.metadata?.["import-id"], orderId: normalized(tx.metadata?.["source-order-id"]),
        card: cardSuffix(tx.metadata?.["source-account"] ?? ""), merchant: merchant(tx.metadata?.["source-payee"] ?? tx.payee),
        file: tx.file, line: tx.line, posted: true });
    }
  }

  const isPosted = (row: Line, direction: string) => Boolean(row.sourceIdentity && postedIdentities.has(row.sourceIdentity))
    || postedOffsets.has(offsetKey(row, direction));
  const needsDuplicateReview = (row: Line) => {
    const tx = byId.get(row.id);
    return tx && (isSuspectedDuplicate(tx) || tx.matches?.some(({ id }) => id.startsWith("batch:")));
  };
  const reserved = new Map(saved.flatMap((match) => splitChargeMemberIds(match).map((id) => [id, match.id])));
  const confirmedById = new Map(confirmed.map((match) => [match.id, match]));
  const found: SplitChargeMatch[] = [];
  const refundMembers = new Set(saved.filter((match) => match.refund).flatMap(splitChargeMemberIds));
  let steps = 0, limited = false;
  const visit = () => {
    if (++steps <= MAX_STEPS && found.length < MAX_RESULTS) return true;
    limited = true;
    return false;
  };
  const searchParts = (original: Line, parts: Line[], refund?: Line) => {
    const pool = parts.filter((row) => !reserved.has(row.id) || reserved.get(row.id) === reserved.get(original.id));
    pool.sort((a, b) => Number(sameOrder(original, b)) - Number(sameOrder(original, a)) || byDate(a, b));
    if (pool.length > MAX_PART_ROWS) limited = true;
    const candidates = pool.slice(0, MAX_PART_ROWS);
    if (candidates.length < 2) return;
    const chosen: Line[] = [];
    const search = (start: number, remaining: bigint) => {
      if (!visit()) return;
      for (let index = start; index < candidates.length; index++) {
        const row = candidates[index];
        if (row.units > remaining || chosen.some((part) => differentCard(part, row))) continue;
        chosen.push(row);
        if (row.units < remaining) search(index + 1, remaining - row.units);
        else if (chosen.length >= 2) {
          const lines = [...chosen].sort(byDate);
          const sorted = [...lines].sort((a, b) => a.id.localeCompare(b.id));
          const ids = [original.id, ...(refund ? [refund.id] : []), ...lines.map(({ id }) => id).sort()];
          const id = createHash("sha256").update(JSON.stringify([ids, groupKey(original), original.date, refund?.date,
            original.amount, sorted.map(({ date, amount }) => [date, amount])])).digest("hex").slice(0, 24);
          const existing = confirmedById.get(id);
          if (existing && refund) {
            existing.canExcludeOffsets = !original.posted && !isPosted(original, "out") && !isPosted(refund, "in")
              && !needsDuplicateReview(original) && !needsDuplicateReview(refund);
          } else if (!existing && ids.every((member) => !reserved.has(member))) {
            if (refund) for (const member of ids) refundMembers.add(member);
            found.push({
              id, fundingAccount: original.account, currency: original.currency, original: publicLine(original),
              ...(refund && {
                refund: publicLine(refund),
                refundEvidence: refund.refundOf && refund.source === original.source && refund.refundOf === original.sourceTxId ? "reference"
                  : sameOrder(original, refund) ? "order" : "amount",
              }),
              parts: lines.map(publicLine),
              splitEvidence: lines.every((part) => sameOrder(original, part) || (refund && sameOrder(refund, part))) ? "order"
                : original.merchant && lines.every((part) => part.merchant === original.merchant) ? "merchant" : "amount",
            });
          }
        }
        chosen.pop();
        if (steps > MAX_STEPS || found.length >= MAX_RESULTS) { limited = true; return; }
      }
    };
    search(0, original.units);
  };
  for (const refund of refunds) {
    if (!visit()) break;
    const key = groupKey(refund);
    if (!needed.has(key)) continue;
    const debits = debitIndex.get(key)!;
    const originals = [...debits.filter((row) => !row.sourceIdentity || !postedIdentities.has(row.sourceIdentity)), ...(postedIndex.get(key) ?? [])]
      .filter((row) => row.units === refund.units && ordered(row, refund) && day(refund.date) - day(row.date) <= WINDOW_DAYS
        && !differentCard(row, refund) && (!refund.refundOf || row.source !== refund.source || !row.sourceTxId || row.sourceTxId === refund.refundOf));
    const parts = debits.filter((row) => row.units < refund.units && ordered(refund, row)
      && day(row.date) - day(refund.date) <= WINDOW_DAYS && !differentCard(refund, row)
      && (!row.sourceIdentity || !postedIdentities.has(row.sourceIdentity))).sort(byDate);
    for (const original of originals) {
      if (!visit()) break;
      searchParts(original, parts.filter((row) => day(row.date) - day(original.date) <= WINDOW_DAYS && !differentCard(original, row)), refund);
    }
  }
  // Prefer the refund-backed relationship when the same rows already explain an actual reversal.
  for (const debits of debitIndex.values()) {
    const available = debits.filter((row) => !refundMembers.has(row.id) && !reserved.has(row.id)
      && (!row.sourceIdentity || !postedIdentities.has(row.sourceIdentity)));
    if (available.length < 3) continue;
    const byDay = new Map<string, Line[]>();
    for (const row of available) add(byDay, row.date, row);
    for (const original of available) {
      if (!visit()) break;
      const parts: Line[] = [];
      for (let delta = -WINDOW_DAYS; delta <= WINDOW_DAYS; delta++) {
        const date = new Date((day(original.date) + delta) * DAY).toISOString().slice(0, 10);
        for (const row of byDay.get(date) ?? []) {
          if (row.units < original.units && !differentCard(original, row)) parts.push(row);
        }
      }
      searchParts(original, parts);
    }
  }
  const uses = new Map<string, number>();
  for (const match of found) for (const id of splitChargeMemberIds(match)) uses.set(id, (uses.get(id) ?? 0) + 1);
  const evidenceRank = (match: SplitChargeMatch) => Number(match.refundEvidence === "reference") * 4
    + Number(match.refundEvidence === "order") * 2 + Number(match.splitEvidence === "order");
  found.sort((a, b) => evidenceRank(b) - evidenceRank(a));
  return { confirmed, limited, candidates: found.map((match) => ({ ...match, overlaps: splitChargeMemberIds(match).some((id) => (uses.get(id) ?? 0) > 1) })) };
}
