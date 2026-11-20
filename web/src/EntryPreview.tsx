import { useState } from "react";
import { formatPosting, formatTransactionEntry, formatTransactionHeader, transactionPostings, validateTransaction } from "../../src/shared/postings.js";
import type { ParsedTx } from "../../src/shared/types.js";
import BeancountCode from "./BeancountCode";

function PreviewEntry({ tx, batchId }: { tx: ParsedTx; batchId: string }) {
  const [showFull, setShowFull] = useState(false);
  if (tx.excludedReason || tx.status === "excluded") return <p className="muted">{tx.excludedReason || "这笔交易已排除"}</p>;
  if (tx.status === "duplicate") return <p className="muted">这笔交易已标为重复</p>;

  const reviewed = tx.status === "pending" && !tx.finalAccount && tx.suggestedAccount ? { ...tx, finalAccount: tx.suggestedAccount } : tx;
  const postings = transactionPostings(reviewed);
  const errors = validateTransaction(reviewed, postings);
  const summary = [formatTransactionHeader(reviewed), ...(errors.length ? [] : postings.map(formatPosting))].join("\n");
  return <>
    <BeancountCode className="entry-code entry-summary" text={summary} />
    {errors.length > 0 && <p className="muted">{postings.some(({ account }) => !account)
      ? "补齐分录账户后可预览完整分录" : errors.join(" · ")}</p>}
    {!errors.length && <details className="entry-full" onToggle={(event) => setShowFull(event.currentTarget.open)}>
      <summary>完整分录</summary>
      {showFull && <BeancountCode className="entry-code" text={formatTransactionEntry(reviewed, postings, batchId)} />}
    </details>}
  </>;
}

export default function EntryPreview({ entries, batchId }: { entries: readonly ParsedTx[]; batchId: string }) {
  return <section className="entry-preview" aria-label="Beancount 分录预览">
    <h3>Beancount 分录预览</h3>
    {entries.map((tx) => <div key={tx.id}>
      {entries.length > 1 && <h4>{tx.eventType === "refund" ? "退款" : "原消费"}</h4>}
      <PreviewEntry tx={tx} batchId={batchId} />
    </div>)}
  </section>;
}
