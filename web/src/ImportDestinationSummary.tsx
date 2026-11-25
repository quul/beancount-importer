import { useMemo } from "react";
import { importFundingAccount, importStatementKinds, transactionImportTarget, type ImportLayout } from "../../src/shared/import-paths.js";
import { validDate } from "../../src/shared/postings.js";
import { needsCnySettlement } from "../../src/shared/settlement.js";
import { activeTransactions } from "../../src/shared/transactionMerge.js";
import type { ImportStatementKind, ParsedTx } from "../../src/shared/types.js";

export function summarizeImportDirectories(layout: ImportLayout, txs: readonly ParsedTx[]) {
  const byId = new Map(txs.map((tx) => [tx.id, tx]));
  const totals = new Map<string, { count: number; kinds: Set<ImportStatementKind>; hasDefault: boolean }>();
  for (const tx of activeTransactions(txs)) {
    if ((tx.status !== "pending" && tx.status !== "ready") || tx.excludedReason || tx.reviewConflictId
      || needsCnySettlement(tx) || !validDate(tx.date)) continue;
    const members = tx.merge?.originals.map(({ id }) => byId.get(id));
    const { file, kinds } = transactionImportTarget(layout, tx, { account: importFundingAccount(tx) || "{account}", members });
    const directory = file.slice(0, file.lastIndexOf("/") + 1);
    const summary = totals.get(directory) ?? { count: 0, kinds: new Set<ImportStatementKind>(), hasDefault: false };
    summary.count++;
    summary.hasDefault ||= kinds.length === 0;
    kinds.forEach((kind) => summary.kinds.add(kind));
    totals.set(directory, summary);
  }
  return [...totals.entries()].sort(([a, left], [b, right]) =>
    Number(Boolean(right.kinds.size)) - Number(Boolean(left.kinds.size)) || a.localeCompare(b));
}

export default function ImportDestinationSummary({ layout, txs, rulesHref }: {
  layout: ImportLayout;
  txs: readonly ParsedTx[];
  rulesHref: string;
}) {
  const destinations = useMemo(() => summarizeImportDirectories(layout, txs), [layout, txs]);
  if (!destinations.length) return null;
  return <section className="review-destinations" aria-labelledby="review-destinations-heading">
    <div className="toolbar review-destinations-heading">
      <h3 id="review-destinations-heading">预计保存位置</h3>
      <a className="btn small quiet" href={rulesHref}>查看保存规则</a>
    </div>
    <dl>
      {destinations.map(([directory, { count, kinds, hasDefault }]) => {
        const labels = [...kinds].map((kind) => importStatementKinds[kind].label);
        if (hasDefault) labels.push("其他分录");
        const label = hasDefault && destinations.length === 1 ? "本批可审批交易" : labels.join("、");
        return <div className="review-destination" key={directory}>
          <dt>{label} <small>{count} 笔</small></dt>
          <dd>{directory ? <code>{directory.replaceAll("{account}", "（资金账户待确认）")}</code> : "账本目录"}</dd>
        </div>;
      })}
    </dl>
  </section>;
}
