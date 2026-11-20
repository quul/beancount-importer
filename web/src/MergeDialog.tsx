import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { amountText, validDate } from "../../src/shared/postings.js";
import { planTransactionMerge } from "../../src/shared/transactionMerge.js";
import { MAX_NARRATION_LENGTH, type ParsedTx } from "../../src/shared/types.js";
import type { MergeDraft } from "./api";

export default function MergeDialog({ members, accounts, busy, error, onClose, onConfirm }: {
  members: ParsedTx[];
  accounts: ReadonlySet<string>;
  busy: boolean;
  error: string;
  onClose: () => void;
  onConfirm: (draft: MergeDraft) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const singleDate = members.length > 0 && members.every((tx) => tx.date === members[0].date);
  const [date, setDate] = useState(singleDate ? members[0].date : "");
  const [payee, setPayee] = useState("");
  const [narration, setNarration] = useState("");
  const plan = useMemo(() => planTransactionMerge(members, accounts), [members, accounts]);
  const valid = !plan.errors.length && validDate(date) && Boolean(payee.trim());

  useLayoutEffect(() => { dialog.current?.showModal(); }, []);

  return <dialog ref={dialog} className="merge-dialog" aria-labelledby="merge-heading" onCancel={(event) => {
    event.preventDefault();
    if (!busy) onClose();
  }}>
    <form onSubmit={(event) => {
      event.preventDefault();
      if (valid && !busy) onConfirm({ date, payee, narration });
    }}>
      <div className="toolbar merge-heading"><h2 id="merge-heading">合并记账</h2><span className="muted">{members.length} 笔原交易</span></div>
      <ul className="merge-members" aria-label="所选原交易">
        {members.map((tx) => <li key={tx.id}>
          <div><strong>{tx.payee || "（无商户）"}</strong><time dateTime={tx.date}>{tx.date}</time></div>
          <span className={`amt ${tx.direction}`}>{tx.direction === "in" ? "+" : "−"}{amountText(tx.amount)} {tx.currency}</span>
        </li>)}
      </ul>
      <div className="merge-totals"><strong>各币种净额</strong>{plan.totals.map(({ currency, amount }) => <span key={currency}>{amountText(amount)} {currency}</span>)}</div>
      {plan.warnings.map((warning) => <p className="merge-warning" key={warning}>{warning}</p>)}
      {plan.skipsPosting && <p className="merge-warning">同一资金账户收支抵消，审批时可确认不入账。</p>}
      {plan.errors.length > 0 && <ul className="merge-errors error-line">{plan.errors.map((message) => <li key={message}>{message}</li>)}</ul>}
      <fieldset disabled={busy} className="merge-fields">
        <label>记账日期<input type="date" value={date} readOnly={singleDate} required onChange={(event) => setDate(event.target.value)} /></label>
        <label>商户<input value={payee} required maxLength={MAX_NARRATION_LENGTH} onChange={(event) => setPayee(event.target.value)} /></label>
        <label>账本摘要<input value={narration} maxLength={MAX_NARRATION_LENGTH} onChange={(event) => setNarration(event.target.value)} /></label>
      </fieldset>
      {error && <p className="error-line" role="alert">{error}</p>}
      <div className="toolbar merge-actions">
        <button className="btn" type="button" disabled={busy} onClick={onClose}>取消</button>
        <button className="btn primary" type="submit" disabled={busy || !valid}>{busy ? "正在合并…" : "创建合并"}</button>
      </div>
    </form>
  </dialog>;
}
