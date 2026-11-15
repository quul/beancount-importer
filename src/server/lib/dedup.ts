/** Only durable source identity proves a duplicate; amount matches are review candidates. */
import type { LedgerTx, ParsedTx } from "../../shared/types.js";

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

const usableAccount = (account: string) => /^(Assets|Liabilities):/.test(account) && !/FixMe|Unknown/i.test(account);
const signedAmount = (tx: ParsedTx) => tx.direction === "in" ? tx.amount : -tx.amount;
const sameAmount = (a: number, b: number) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 0.005;
export function sourceKey(source?: string, id?: string, fileHash?: string, row?: string | number): string | undefined {
  if (!source) return undefined;
  if (id) return `${source}|id:${id}`;
  if (fileHash && row != null && /^\d+$/.test(String(row))) return `${source}|file:${fileHash}|row:${row}`;
  return undefined;
}
function addIssue(tx: ParsedTx, issue: string) { tx.issues = [...new Set([...(tx.issues ?? []), issue])]; tx.status = "pending"; }

export function markDuplicates(allTxs: ParsedTx[], ledgerTxs: LedgerTx[]): DedupResult {
  const stats = { crossSourceDuplicates: 0, ledgerDuplicates: 0 };
  const durable = new Map<string, LedgerTx>();
  for (const tx of ledgerTxs) {
    const key = sourceKey(tx.source ?? tx.metadata?.["import-source"], tx.sourceTxId ?? tx.metadata?.["import-id"], tx.metadata?.["source-file-hash"], tx.metadata?.["source-row"]);
    if (key) durable.set(key, tx);
  }
  const seenSource = new Map<string, ParsedTx>();
  const assignedLedger = new Set<string>();
  for (const tx of allTxs) {
    if (tx.status === "excluded" || tx.excludedReason) continue;
    const key = sourceKey(tx.source, tx.sourceTxId, tx.sourceFileHash, tx.row);
    const imported = key ? durable.get(key) : undefined;
    if (imported) {
      assignedLedger.add(imported.id);
      tx.status = "duplicate";
      tx.duplicateOf = { id: imported.id, where: imported.file ?? "ledger", label: tx.sourceTxId ? "来源交易号已存在于账本" : "同一来源文件的该行已存在于账本" };
      tx.matches = [{ id: imported.id, date: imported.date, payee: imported.payee, narration: imported.narration,
        file: imported.file, line: imported.line, postings: imported.postings, reason: tx.duplicateOf.label }];
      stats.ledgerDuplicates++;
      continue;
    }
    const previous = key ? seenSource.get(key) : undefined;
    if (previous) {
      tx.status = "duplicate";
      tx.duplicateOf = { id: previous.id, where: previous.sourceFile, label: tx.sourceTxId ? "同来源交易号重复上传" : "相同来源文件的该行重复上传" };
      stats.crossSourceDuplicates++;
      continue;
    }
    if (key) seenSource.set(key, tx);
  }
  for (const tx of allTxs) {
    if (tx.status === "excluded" || tx.status === "duplicate" || tx.excludedReason || !usableAccount(tx.fundingAccount)) continue;
    const candidates = ledgerTxs.filter((ledger) => !assignedLedger.has(ledger.id) && ledger.date === tx.date
      && ledger.postings.some((posting) => posting.account === tx.fundingAccount && posting.currency === tx.currency && sameAmount(posting.amount, signedAmount(tx))));
    tx.matches = candidates.map((ledger) => ({ id: ledger.id, date: ledger.date, payee: ledger.payee, narration: ledger.narration,
      file: ledger.file, line: ledger.line, postings: ledger.postings,
      reason: normPayee(ledger.payee) === normPayee(tx.payee) ? "账本中已有同日同金额的相似交易，请确认是否重复" : "账本中已有同日同金额的交易（商户不同），请确认是否重复" }));
    if (candidates.length) addIssue(tx, candidates.length > 1 ? "可能和账本中的多笔历史交易重复，请逐笔核对" : "可能和账本中的历史交易重复，请确认");
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
      addIssue(tx, "不同来源的流水可能是同一笔交易，请核对后只保留一笔");
      tx.matches ??= [];
      for (const sibling of siblings) tx.matches.push({ id: sibling.id, date: sibling.date, payee: sibling.payee, narration: sibling.note,
        file: sibling.sourceFile, line: sibling.row, reason: "另一来源有同日同金额的流水，可能是同一笔交易", postings: sibling.postings ?? [] });
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
