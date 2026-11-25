import { useState } from "react";
import { formatTransactionEntry, transactionPostings, validateTransaction } from "../../src/shared/postings.js";
import { CNY_SETTLEMENT_REQUIRED, needsCnySettlement } from "../../src/shared/settlement.js";
import type { ParsedTx } from "../../src/shared/types.js";
import BeancountCode from "./BeancountCode";

function PreviewEntry({ tx, batchId }: { tx: ParsedTx; batchId: string }) {
  if (tx.excludedReason || tx.status === "excluded") return <p className="muted">{tx.excludedReason || "这笔交易已排除"}</p>;
  if (tx.status === "duplicate") return <p className="muted">这笔交易已标为重复</p>;
  if (needsCnySettlement(tx)) return <p className="muted">{CNY_SETTLEMENT_REQUIRED}</p>;

  const reviewed = tx.status === "pending" && !tx.finalAccount && tx.suggestedAccount ? { ...tx, finalAccount: tx.suggestedAccount } : tx;
  const postings = transactionPostings(reviewed);
  if (validateTransaction(reviewed, postings).length) return <p className="muted">补齐分录账户后可预览完整分录</p>;
  return <BeancountCode className="entry-code" text={formatTransactionEntry(reviewed, postings, batchId)} />;
}

export default function EntryPreview({ entries, batchId }: { entries: readonly ParsedTx[]; batchId: string }) {
  const [expanded, setExpanded] = useState(false);
  return <details className="detail-section entry-preview" onToggle={(event) => setExpanded(event.currentTarget.open)}>
    <summary>Beancount 分录预览</summary>
    {expanded && <div className="entry-preview-content">
      {entries.map((tx) => <div key={tx.id}>
        {entries.length > 1 && <h4>{tx.eventType === "refund" ? "退款" : "原消费"}</h4>}
        <PreviewEntry tx={tx} batchId={batchId} />
      </div>)}
    </div>}
  </details>;
}
