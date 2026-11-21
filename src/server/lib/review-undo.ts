import { activeTransactions } from "../../shared/transactionMerge.js";
import type { ParsedTx, ReviewStatusUndo, TxStatus } from "../../shared/types.js";
import type { StoredBatch } from "./batches.js";

export function reviewStatuses(txs: readonly ParsedTx[]): Map<string, TxStatus> {
  return new Map(txs.filter((tx) => !tx.duplicateOf?.refundCopy).map(({ id, status }) => [id, status]));
}

export function rememberReviewStatusChange(batch: StoredBatch, txs: readonly ParsedTx[], previous: ReadonlyMap<string, TxStatus>,
  action: ReviewStatusUndo["action"], sessionId: string | undefined): void {
  const entries = txs.flatMap(({ id, status, duplicateOf }) => {
    const before = previous.get(id);
    return before && before !== status && !duplicateOf?.refundCopy ? [{ id, before, after: status }] : [];
  });
  if (!entries.length) return;
  if (!sessionId) {
    delete batch.reviewStatusHistory;
    return;
  }
  if (batch.reviewStatusHistory?.sessionId !== sessionId) batch.reviewStatusHistory = { sessionId, operations: [] };
  batch.reviewStatusHistory.operations.push({ action, entries });
}

export function availableReviewUndo(batch: StoredBatch, active?: readonly ParsedTx[]) {
  const history = batch.reviewStatusHistory;
  if (!history?.operations.length || batch.committed || batch.mergedInto) return;
  const byId = new Map((active ?? activeTransactions(batch.txs)).map((tx) => [tx.id, tx]));
  for (let index = history.operations.length - 1; index >= 0; index--) {
    const operation = history.operations[index];
    const canRestore = operation.entries.every(({ id, before, after }) => {
      const tx = byId.get(id);
      return tx?.status === after && !tx.reviewConflictId && !tx.duplicateOf?.refundCopy && (!tx.excludedReason || before === "excluded");
    });
    if (canRestore) return { operation, history, depth: index + 1 };
  }
}
