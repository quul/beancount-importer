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
      reason: normPayee(ledger.payee) === normPayee(tx.payee) ? "同日、同资金账户、同币种、同方向金额及商户；缺少来源交易号，需人工确认" : "同日、同资金账户、同币种及同方向金额；商户描述可能不同，需人工确认" }));
    if (candidates.length) addIssue(tx, candidates.length > 1 ? "已有账本存在多个可能匹配，请逐笔核对" : "已有账本存在可能匹配，确认重复后再排除");
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
      addIssue(tx, "跨来源流水可能记录同一资金变动，请核对商户、时间和交易号后选择保留项");
      tx.matches ??= [];
      for (const sibling of siblings) tx.matches.push({ id: sibling.id, date: sibling.date, payee: sibling.payee, narration: sibling.note,
        file: sibling.sourceFile, line: sibling.row, reason: "跨来源：同资金账户、日期、币种、方向及金额；仅建议匹配", postings: sibling.postings ?? [] });
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
