/** Only durable source identity proves a duplicate; amount matches are review candidates. */
import type { DraftPosting, LedgerMatch, LedgerTx, ParsedTx } from "../../shared/types.js";
import { CROSS_SOURCE_ISSUE, CROSS_SOURCE_MATCH_REASON, ledgerDuplicateReviewIssue, LEDGER_DUPLICATE_ISSUE } from "../../shared/types.js";
import { isFundingAccount } from "../../shared/funding.js";
import { fundingPostingSign } from "../../shared/postings.js";
import { sourceKey } from "../../shared/transactionMerge.js";

export { sourceKey };

export interface Fingerprint { key: string; source: string }
const normPayee = (value: string) => value.replace(/[\s（）()]/g, "").toLowerCase();
export function fingerprint(tx: { date: string; amount: number; direction: string; payee: string }): string {
  return [looseFingerprint(tx), normPayee(tx.payee)].join("|");
}
export function looseFingerprint(tx: { date: string; amount: number; direction: string }): string {
  return [tx.date, tx.amount.toFixed(2), tx.direction].join("|");
}
export function sourcePriority(source: string): number { return /alipay|wechat/.test(source) ? 3 : source === "yunshanfu" ? 2 : source.startsWith("bank-") ? 1 : 0; }
export interface DedupResult { txs: ParsedTx[]; stats: { crossSourceDuplicates: number; ledgerDuplicates: number } }

const usableAccount = (account: string) => isFundingAccount(account) && !/FixMe|Unknown/i.test(account);
const sameAmount = (a: number, b: number) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 0.005;
const SAME_PAYEE_REASON = "日期、金额、商户相同";
const OTHER_PAYEE_REASON = "日期、金额相同，商户不同";
const ROUNDING_REASON = "账本资金金额自动补全时发生舍入";
function addIssue(tx: ParsedTx, issue: string) { tx.issues = [...new Set([...(tx.issues ?? []), issue])]; tx.status = "pending"; }

function ledgerSourceKeys(tx: LedgerTx): string[] {
  const key = sourceKey(tx.source ?? tx.metadata?.["import-source"], tx.sourceTxId ?? tx.metadata?.["import-id"], tx.metadata?.["source-file-hash"], tx.metadata?.["source-row"]);
  const keys = key ? [key] : [];
  const members = tx.metadata?.["import-members"];
  if (!members) return keys;
  try {
    const originals: unknown = JSON.parse(members);
    if (!Array.isArray(originals)) return keys;
    for (const member of originals) {
      if (typeof member?.source !== "string") continue;
      const memberKey = sourceKey(member.source, typeof member.sourceTxId === "string" ? member.sourceTxId : undefined,
        typeof member.sourceFileHash === "string" ? member.sourceFileHash : undefined, typeof member.row === "number" ? member.row : undefined);
      if (memberKey) keys.push(memberKey);
    }
  } catch { /* Keep legacy provenance when a hand-edited metadata value is invalid. */ }
  return keys;
}

function ledgerDuplicateCandidates(tx: ParsedTx, ledgerTxs: LedgerTx[], assignedLedger: Set<string>): LedgerMatch[] {
  if (!usableAccount(tx.fundingAccount)) return [];
  const payment = (posting: DraftPosting) => posting.account === tx.fundingAccount && posting.currency === tx.currency;
  const amount = fundingPostingSign(tx) * tx.amount;
  const candidates: LedgerMatch[] = [];
  for (const ledger of ledgerTxs) {
    if (assignedLedger.has(ledger.id) || ledger.date !== tx.date) continue;
    const unrounded = ledger.unroundedFunding;
    let reason: string;
    if (ledger.postings.some((posting) => payment(posting) && sameAmount(posting.amount, amount))) {
      reason = normPayee(ledger.payee) === normPayee(tx.payee) ? SAME_PAYEE_REASON : OTHER_PAYEE_REASON;
    } else if (unrounded && payment(unrounded) && unrounded.amount === amount) {
      reason = `${ROUNDING_REASON}，明细合计 ${Math.abs(unrounded.amount)} ${unrounded.currency}`;
    } else continue;
    candidates.push({ id: ledger.id, date: ledger.date, payee: ledger.payee, narration: ledger.narration,
      file: ledger.file, line: ledger.line, postings: ledger.postings, reason });
  }
  return candidates;
}

export function refreshLedgerDuplicateHints(txs: ParsedTx[], ledgerTxs: LedgerTx[]) {
  const assignedLedger = new Set(txs.flatMap((tx) => tx.duplicateOf ? [tx.duplicateOf.id] : []));
  let changed = false, suspected = 0;
  for (const tx of txs) {
    if (tx.status === "excluded" || tx.status === "duplicate" || tx.excludedReason) continue;
    const candidates = ledgerDuplicateCandidates(tx, ledgerTxs, assignedLedger);
    const candidateIds = new Set(candidates.map((match) => match.id));
    const previousMatches = tx.matches ?? [];
    const previousIssues = tx.issues ?? [];
    const otherMatches = previousMatches.filter(({ id, reason }) => !candidateIds.has(id)
      && reason !== SAME_PAYEE_REASON && reason !== OTHER_PAYEE_REASON && !reason.startsWith(ROUNDING_REASON));
    const matches = [...candidates, ...otherMatches];
    const issues = previousIssues.filter((issue) => !ledgerDuplicateReviewIssue(issue));
    if (candidates.length) {
      suspected++;
      const originalIndex = previousIssues.findIndex(ledgerDuplicateReviewIssue);
      issues.splice(originalIndex < 0 ? issues.length : originalIndex, 0, LEDGER_DUPLICATE_ISSUE);
    }
    if (JSON.stringify(matches) === JSON.stringify(previousMatches) && JSON.stringify(issues) === JSON.stringify(previousIssues)) continue;
    tx.matches = matches;
    tx.issues = issues;
    changed = true;
  }
  return { changed, suspected };
}

export function markDuplicates(allTxs: ParsedTx[], ledgerTxs: LedgerTx[]): DedupResult {
  const stats = { crossSourceDuplicates: 0, ledgerDuplicates: 0 };
  const durable = new Map<string, LedgerTx>();
  for (const tx of ledgerTxs) for (const key of ledgerSourceKeys(tx)) durable.set(key, tx);
  const seenSource = new Map<string, ParsedTx>();
  const assignedLedger = new Set<string>();
  for (const tx of allTxs) {
    if (tx.status === "excluded" || tx.excludedReason) continue;
    const keys = (tx.merge?.originals ?? [tx]).map((member) => sourceKey(member.source, member.sourceTxId, member.sourceFileHash, member.row))
      .filter((key): key is string => key !== undefined);
    const imported = keys.map((key) => durable.get(key)).find(Boolean);
    if (imported) {
      assignedLedger.add(imported.id);
      tx.status = "duplicate";
      tx.duplicateOf = { id: imported.id, where: imported.file ?? "ledger", label: tx.merge ? "合并组包含已入账的原交易" : tx.sourceTxId ? "来源交易号已存在于账本" : "同一来源文件的该行已存在于账本" };
      tx.matches = [{ id: imported.id, date: imported.date, payee: imported.payee, narration: imported.narration,
        file: imported.file, line: imported.line, postings: imported.postings, reason: tx.duplicateOf.label }];
      stats.ledgerDuplicates++;
      continue;
    }
    const previous = keys.map((key) => seenSource.get(key)).find(Boolean);
    if (previous) {
      tx.status = "duplicate";
      tx.duplicateOf = { id: previous.id, where: previous.sourceFile, label: tx.merge ? "合并组包含重复的原交易" : tx.sourceTxId ? "同来源交易号重复上传" : "相同来源文件的该行重复上传" };
      stats.crossSourceDuplicates++;
      continue;
    }
    for (const key of keys) seenSource.set(key, tx);
  }
  for (const tx of allTxs) {
    if (tx.status === "excluded" || tx.status === "duplicate" || tx.excludedReason || !usableAccount(tx.fundingAccount)) continue;
    tx.matches = ledgerDuplicateCandidates(tx, ledgerTxs, assignedLedger);
    if (tx.matches.length) addIssue(tx, LEDGER_DUPLICATE_ISSUE);
  }
  // Preserve one-to-one semantics: no same-day amount-only candidate is consumed or discarded.
  const groups = new Map<string, ParsedTx[]>();
  for (const tx of allTxs) {
    if (tx.status === "excluded" || tx.status === "duplicate" || tx.excludedReason || !usableAccount(tx.fundingAccount)) continue;
    const key = `${looseFingerprint(tx)}|${tx.currency}|${tx.fundingAccount}`;
    const group = groups.get(key) ?? []; group.push(tx); groups.set(key, group);
  }
  for (const group of groups.values()) {
    if (group.length < 2 || new Set(group.map((tx) => tx.source)).size < 2) continue;
    for (const tx of group) {
      const siblings = group.filter((other) => other !== tx && other.source !== tx.source);
      if (!siblings.length) continue;
      addIssue(tx, CROSS_SOURCE_ISSUE);
      tx.matches ??= [];
      for (const sibling of siblings) tx.matches.push({ id: sibling.id, date: sibling.date, payee: sibling.payee, narration: sibling.note,
        file: sibling.sourceFile, line: sibling.row, reason: CROSS_SOURCE_MATCH_REASON, postings: sibling.postings ?? [] });
    }
  }
  // Merchant history is useful even while wallet identity or transaction amount
  // is unresolved. References are presentation context and never duplicate proof.
  for (const tx of allTxs) {
    if (tx.status === "duplicate" || !normPayee(tx.payee)) continue;
    const existing = new Set((tx.matches ?? []).map((match) => match.id));
    const history = ledgerTxs.filter((ledger) => {
      if (normPayee(ledger.payee) !== normPayee(tx.payee) || existing.has(ledger.id)) return false;
      existing.add(ledger.id); return true;
    })
      .sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5);
    if (!history.length) continue;
    tx.matches ??= [];
    for (const ledger of history) tx.matches.push({ id: ledger.id, date: ledger.date, payee: ledger.payee, narration: ledger.narration,
      file: ledger.file, line: ledger.line, postings: ledger.postings, reason: "历史分类参考，不作为重复依据" });
  }
  return { txs: allTxs, stats };
}
