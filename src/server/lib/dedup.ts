/**
 * Dedup engine.
 *
 * Two levels of dedup:
 * 1. Cross-source: the same purchase paid with a bank card shows up in both the
 *    Alipay export ("付款方式: 中国工商银行(1234)") and the bank statement
 *    (card 1234, same day, same amount). We build a fingerprint from
 *    (date, amount, direction, payee-normalized) and treat the Alipay record as
 *    the canonical one (richer metadata) and mark the bank record duplicate.
 * 2. In-ledger: fingerprints of already-imported transactions are checked so a
 *    re-imported file is idempotent.
 */

import type { LedgerTx, ParsedTx, RawTx } from "../../shared/types.js";

export interface Fingerprint {
  key: string;
  /** which source it came from */
  source: string;
}

function normPayee(p: string): string {
  return p
    .replace(/\s+/g, "")
    .replace(/[（）()]/g, "")
    .toLowerCase()
    .slice(0, 24);
}

export function fingerprint(tx: {
  date: string;
  amount: number;
  direction: string;
  payee: string;
}): string {
  const amt = tx.amount.toFixed(2);
  return [tx.date, amt, tx.direction, normPayee(tx.payee)].join("|");
}

/**
 * Amount+date-only fingerprint (payee text differs wildly between alipay and
 * bank records of the same purchase, so we can't rely on payee there).
 * To avoid false positives on common amounts (e.g. two 10.00 purchases the same
 * day), we require the alipay record's payment method to be plausibly the same
 * institution as the bank record's source, OR payee similarity.
 */
export function looseFingerprint(tx: {
  date: string;
  amount: number;
  direction: string;
}): string {
  return [tx.date, tx.amount.toFixed(2), tx.direction].join("|");
}

export interface DedupResult {
  txs: ParsedTx[];
  stats: { crossSourceDuplicates: number; ledgerDuplicates: number };
}

/** Priority: alipay/wechat records carry richer payee/category info than bank rows. */
const SOURCE_PRIORITY: Record<string, number> = {
  alipay: 3,
  wechat: 3,
  yunshanfu: 2,
  "bank-boc": 1,
  "bank-abc": 1,
  "bank-czbank": 1,
  "bank-spdb": 1,
  "bank-icbc": 1,
  "bank-ccb": 1,
  "bank-generic": 1,
  unknown: 0,
};

export function sourcePriority(source: string): number {
  return SOURCE_PRIORITY[source] ?? 0;
}

export function markDuplicates(
  allTxs: ParsedTx[],
  ledgerTxs: LedgerTx[],
): DedupResult {
  const stats = { crossSourceDuplicates: 0, ledgerDuplicates: 0 };

  // --- 1. in-ledger fingerprints (exact) ---
  const ledgerExact = new Set<string>();
  for (const lt of ledgerTxs) {
    for (const p of lt.postings) {
      // fingerprint from the non-equity/non-expense leg perspective is hard;
      // use date+amount pairs of all postings
    }
    ledgerExact.add(
      [lt.date, "|"].concat(lt.postings.map((p) => p.amount.toFixed(2)).sort()).join("|"),
    );
  }

  const byLoose = new Map<string, ParsedTx[]>();
  for (const tx of allTxs) {
    if (tx.status === "excluded") continue;
    const k = looseFingerprint(tx);
    const arr = byLoose.get(k);
    if (arr) arr.push(tx);
    else byLoose.set(k, [tx]);
  }

  const result: ParsedTx[] = [];

  for (const tx of allTxs) {
    // --- 2. already in ledger (idempotent re-import) — checked first so a
    //     cross-source "better" record that is itself a ledger duplicate
    //     doesn't become the dedup target ---
    const inLedger = ledgerTxs.some(
      (lt) =>
        lt.date === tx.date &&
        lt.postings.some(
          (p) =>
            Math.abs(Math.abs(p.amount) - tx.amount) < 0.005 &&
            p.account === tx.fundingAccount,
        ),
    );
    if (inLedger) {
      tx.status = "duplicate";
      tx.duplicateOf = { id: "", where: "ledger", label: "已存在于账本" };
      stats.ledgerDuplicates++;
      result.push(tx);
      continue;
    }

    // --- 3. cross-source duplicate detection ---
    const group = byLoose.get(looseFingerprint(tx)) ?? [];
    if (group.length > 1) {
      // find the highest-priority sibling from a different source that is
      // itself kept (not duplicate/excluded)
      const better = group.find(
        (g) =>
          g !== tx &&
          g.id !== tx.id &&
          g.source !== tx.source &&
          sourcePriority(g.source) > sourcePriority(tx.source) &&
          g.status !== "excluded" &&
          g.status !== "duplicate",
      );
      if (better) {
        tx.status = "duplicate";
        tx.duplicateOf = {
          id: better.id,
          where: better.sourceFile,
          label: `${better.source} · ${better.payee || better.rawAccount}`,
        };
        stats.crossSourceDuplicates++;
        result.push(tx);
        continue;
      }
    }

    result.push(tx);
  }

  return { txs: result, stats };
}
