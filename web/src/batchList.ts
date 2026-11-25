import type { BatchSummary } from "./api";

export function groupBatchList(batches: readonly BatchSummary[]) {
  const children = new Map<string, BatchSummary[]>();
  const ids = new Set(batches.map(({ batchId }) => batchId));
  const active: BatchSummary[] = [], completed: BatchSummary[] = [], staged: BatchSummary[] = [];
  for (const item of batches) {
    if (!item.mergedInto) continue;
    const originals = children.get(item.mergedInto) ?? [];
    originals.push(item);
    children.set(item.mergedInto, originals);
  }
  for (const item of batches) {
    if (item.mergedInto) continue;
    (item.combinedFundingPending ? staged : item.committed ? completed : active).push(item);
  }
  return { children, active, completed, staged, deleted: [...children.keys()].filter((id) => !ids.has(id)) };
}
