import { createHash } from "node:crypto";
import path from "node:path";
import { activeTransactions, mergeSource, sourceKey } from "../../shared/transactionMerge.js";
import type { BatchReviewConflict, ParsedTx, StatementName, StatementSource } from "../../shared/types.js";
import type { StoredBatch } from "./batches.js";
import { ImportError } from "./commit.js";

function originalStatement(batchId: string, tx: ParsedTx): StatementSource {
  const file = path.basename(tx.sourceFile.replace(/\\/g, "/"));
  const id = createHash("sha256").update(JSON.stringify([tx.sourceFileHash || batchId, file])).digest("hex");
  return { id, file, name: path.basename(file, path.extname(file)) || file };
}

export function statementsForBatches(batches: readonly StoredBatch[]): StatementSource[] {
  const sources = new Map<string, StatementSource>();
  for (const batch of batches) {
    const statements = batch.statementSources ?? batch.txs.filter((tx) => !tx.merge).map((tx) => originalStatement(batch.batchId, tx));
    for (const statement of statements) if (!sources.has(statement.id)) sources.set(statement.id, statement);
  }
  return [...sources.values()];
}

export function applyStatementNames(sources: StatementSource[], names: unknown): StatementSource[] {
  const valid = new Set(sources.map(({ id }) => id));
  if (!Array.isArray(names) || names.some((item) => !item || !valid.has(item.id)
    || typeof item.name !== "string" || item.name.length > 500 || /[\x00-\x1f\x7f]/.test(item.name))
    || new Set(names.map(({ id }) => id)).size !== names.length) {
    throw new ImportError(400, "请填写有效的账单显示名");
  }
  const byId = new Map((names as StatementName[]).map(({ id, name }) => [id, name.trim()]));
  return sources.map((source) => byId.has(source.id)
    ? { ...source, name: byId.get(source.id) || path.basename(source.file, path.extname(source.file)) || source.file }
    : source);
}

interface OriginalRow {
  id: string;
  tx: ParsedTx;
  sources: Set<string>;
}

type ConflictChoice = BatchReviewConflict["choices"][number];

interface ReviewUnit {
  origin: Pick<ConflictChoice, "batchId" | "file">;
  memberIds: string[];
  txs: ParsedTx[];
  signature: string;
}

function reviewedRow(tx: ParsedTx, original: OriginalRow): ParsedTx {
  const { reviewConflictId, refundCounterpartId, ...fields } = tx;
  return { ...fields, id: original.id, statementSourceIds: [...original.sources] };
}

function reviewSignature(tx: ParsedTx, memberIds: string[]): string {
  const postings = tx.postings?.map(({ account, currency, amount }) => JSON.stringify([account, currency, amount])).sort();
  return JSON.stringify([
    [...memberIds].sort(), tx.status, tx.finalAccount, tx.fundingAccount, tx.fundingAccount2 ?? null, postings,
    tx.flag ?? "*", [...(tx.tags ?? [])].sort(), tx.reviewNote ?? "", tx.narration ?? null,
    tx.refundReviewMode ?? null, tx.merge ? [tx.date, tx.payee] : null,
  ]);
}

export function combineBatchReviews(
  batches: readonly StoredBatch[],
  keepProgress: ReadonlySet<string>,
  resetReview: (tx: ParsedTx) => ParsedTx,
) {
  const originals = new Map<string, OriginalRow>();
  const originalsByBatch = new Map<string, Map<string, OriginalRow>>();
  for (const batch of batches) {
    const byId = new Map<string, OriginalRow>();
    originalsByBatch.set(batch.batchId, byId);
    for (const tx of batch.txs) {
      if (tx.merge) continue;
      const key = sourceKey(tx.source, tx.sourceTxId, tx.sourceFileHash, tx.row) ?? batch.batchId + ":row:" + tx.id;
      let original = originals.get(key);
      if (!original) {
        original = { id: "original-" + (originals.size + 1), tx, sources: new Set() };
        originals.set(key, original);
      }
      for (const source of tx.statementSourceIds ?? [originalStatement(batch.batchId, tx).id]) original.sources.add(source);
      byId.set(tx.id, original);
    }
  }

  const drafts = new Map<string, ParsedTx>();
  for (const original of originals.values()) drafts.set(original.id, reviewedRow(resetReview(original.tx), original));
  const groups: ParsedTx[] = [];
  const unitsByMember = new Map<string, ReviewUnit[]>();
  let nextGroupId = 0;

  const collect = (origin: ReviewUnit["origin"], txs: ParsedTx[], byId: Map<string, OriginalRow>) => {
    const previous = new Map(txs.map((tx) => [tx.id, tx]));
    const claimed = new Set<string>();
    const addUnit = (tx: ParsedTx, members: ParsedTx[]) => {
      const mapped = members.flatMap((member) => {
        const original = byId.get(member.id);
        return original ? [reviewedRow(member, original)] : [];
      });
      const memberIds = mapped.map(({ id }) => id);
      if (mapped.length !== members.length || new Set(memberIds).size !== memberIds.length
        || memberIds.some((id) => claimed.has(id))) return;
      if (tx.merge) {
        mapped.push({
          ...tx,
          id: "review-group-" + (++nextGroupId),
          merge: { ...tx.merge, originals: mapped.map(mergeSource) },
        });
      }
      const unit = { origin, memberIds, txs: mapped, signature: reviewSignature(tx, memberIds) };
      for (const id of memberIds) {
        claimed.add(id);
        const other = unitsByMember.get(id) ?? [];
        other.push(unit);
        unitsByMember.set(id, other);
      }
    };

    // Prefer an existing reviewed group over duplicate copies of its component rows.
    const active = activeTransactions(txs).filter((tx) => !tx.reviewConflictId && tx.status !== "duplicate");
    for (const tx of active.filter((entry) => entry.merge)) {
      const members = tx.merge!.originals.flatMap(({ id }) => previous.get(id) ?? []);
      if (members.length === tx.merge!.originals.length) addUnit(tx, members);
    }
    for (const tx of txs) {
      if (tx.merge || tx.reviewConflictId || tx.status === "duplicate") continue;
      addUnit(tx, [tx]);
    }
  };

  for (const batch of batches) {
    if (!keepProgress.has(batch.batchId)) continue;
    const byId = originalsByBatch.get(batch.batchId)!;
    collect({ batchId: batch.batchId, file: batch.file }, batch.txs, byId);
    for (const conflict of batch.reviewConflicts ?? []) for (const choice of conflict.choices) {
      collect({ batchId: choice.batchId, file: choice.file }, choice.txs, byId);
    }
  }

  const seen = new Set<string>();
  const conflicts: BatchReviewConflict[] = [];
  for (const id of unitsByMember.keys()) {
    if (seen.has(id)) continue;
    const memberIds = [id];
    const units = new Set<ReviewUnit>();
    let disagreement = false;
    for (let i = 0; i < memberIds.length; i++) {
      const member = memberIds[i];
      if (seen.has(member)) continue;
      seen.add(member);
      const alternatives = unitsByMember.get(member)!;
      if (alternatives.some(({ signature }) => signature !== alternatives[0].signature)) disagreement = true;
      for (const unit of alternatives) {
        if (units.has(unit)) continue;
        units.add(unit);
        for (const relative of unit.memberIds) if (!seen.has(relative)) memberIds.push(relative);
      }
    }

    if (!disagreement) {
      for (const tx of units.values().next().value!.txs) {
        if (tx.merge) groups.push(tx);
        else drafts.set(tx.id, tx);
      }
      continue;
    }

    const transactionIds = [...new Set(memberIds)];
    const choices = new Map<string, ConflictChoice>();
    for (const { origin, txs } of units) {
      const choice = choices.get(origin.batchId) ?? { ...origin, txs: [] };
      choice.txs.push(...txs);
      choices.set(origin.batchId, choice);
    }
    const conflictId = "review-conflict-" + (conflicts.length + 1);
    conflicts.push({ id: conflictId, transactionIds, choices: [...choices.values()] });
    for (const member of transactionIds) drafts.get(member)!.reviewConflictId = conflictId;
  }

  return { txs: [...drafts.values(), ...groups], reviewConflicts: conflicts };
}

export function resolveBatchReviewConflict(batch: StoredBatch, id: unknown, sourceBatchId: unknown): void {
  const conflict = batch.reviewConflicts?.find((item) => item.id === id);
  if (!conflict) throw new ImportError(409, "这组审批冲突已变更，请重新加载");
  const choice = conflict.choices.find(({ batchId }) => batchId === sourceBatchId);
  if (sourceBatchId !== null && !choice) throw new ImportError(400, "请选择要沿用的批次");
  const selected = new Map(choice?.txs.filter((tx) => !tx.merge).map((tx) => [tx.id, tx]));
  batch.txs = batch.txs.map((tx) => {
    if (tx.reviewConflictId !== conflict.id) return tx;
    const resolved = { ...(selected.get(tx.id) ?? tx) };
    delete resolved.reviewConflictId;
    return resolved;
  });
  batch.txs.push(...(choice?.txs.filter((tx) => tx.merge) ?? []));
  batch.reviewConflicts = batch.reviewConflicts!.filter((item) => item.id !== id);
}
