import { formatPosting, formatTransactionHeader, transactionPostings } from "../../src/shared/postings.js";
import { activeTransactions } from "../../src/shared/transactionMerge.js";
import type { BatchReviewConflict, TxStatus } from "../../src/shared/types.js";
import BeancountCode from "./BeancountCode";

const statuses: Record<TxStatus, string> = { ready: "待入账", pending: "待确认", excluded: "已排除", duplicate: "重复" };

export default function ReviewConflictPanel({ conflict, disabled, readOnly, onResolve }: {
  conflict: BatchReviewConflict;
  disabled: boolean;
  readOnly: boolean;
  onResolve: (sourceBatchId: string | null) => void;
}) {
  return <section className="review-conflict" aria-label="审批结果冲突">
    <div className="toolbar review-conflict-heading">
      <h3>审批结果冲突{conflict.transactionIds.length > 1 && " · " + conflict.transactionIds.length + " 笔"}</h3>
      {!readOnly && <button type="button" className="btn small quiet" disabled={disabled} onClick={() => onResolve(null)}>重新审批</button>}
    </div>
    {conflict.choices.map((choice) => <article className="review-conflict-choice" key={choice.batchId}>
      <div className="toolbar">
        <b title={choice.file}>{choice.file}</b>
        {!readOnly && <button type="button" className="btn small" disabled={disabled} onClick={() => onResolve(choice.batchId)}>沿用此批次</button>}
      </div>
      {activeTransactions(choice.txs).map((tx) => <div className="review-conflict-entry" key={tx.id}>
        <span className={"decision-status " + tx.status}>{statuses[tx.status]}</span>
        <BeancountCode className="entry-code" text={[
          formatTransactionHeader(tx),
          ...transactionPostings(tx).filter(({ account }) => account).map(formatPosting),
        ].join("\n")} />
        {tx.reviewNote && <small>{tx.reviewNote}</small>}
      </div>)}
    </article>)}
  </section>;
}
