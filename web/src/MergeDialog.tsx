import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { amountText, validDate } from "../../src/shared/postings.js";
import { planTransactionMerge } from "../../src/shared/transactionMerge.js";
import { MAX_NARRATION_LENGTH, reviewPayeeText, type ParsedTx } from "../../src/shared/types.js";
import type { MergeDraft } from "./api";
import useAnchoredOptions from "./useAnchoredOptions";

export default function MergeDialog({ members, accounts, busy, error, onClose, onConfirm }: {
  members: ParsedTx[];
  accounts: ReadonlySet<string>;
  busy: boolean;
  error: string;
  onClose: () => void;
  onConfirm: (draft: MergeDraft) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const payeeInput = useRef<HTMLInputElement>(null);
  const payeeList = useRef<HTMLUListElement>(null);
  const actions = useRef<HTMLDivElement>(null);
  const payeeId = useId();
  const singleDate = members.length > 0 && members.every((tx) => tx.date === members[0].date);
  const [date, setDate] = useState(singleDate ? members[0].date : "");
  const [payee, setPayee] = useState("");
  const [activePayeeIndex, setActivePayeeIndex] = useState(-1);
  const [narration, setNarration] = useState("");
  const plan = useMemo(() => planTransactionMerge(members, accounts), [members, accounts]);
  const { commonPayee, payeeOptions } = useMemo(() => {
    const names = members.map((tx) => reviewPayeeText(tx).trim());
    const options = [...new Set(names.filter((name) => name && name.length <= MAX_NARRATION_LENGTH))];
    const common = options.length === 1 && names.every((name) => name === options[0]) ? options[0] : "";
    return { commonPayee: common, payeeOptions: options };
  }, [members]);
  const multiplePayees = payeeOptions.length > 1;
  const showPayees = multiplePayees && activePayeeIndex >= 0 && activePayeeIndex < payeeOptions.length;
  const payeeListId = `${payeeId}-options`;
  const payeeHintId = `${payeeId}-keys`;
  const effectivePayee = payee.trim() || commonPayee;
  const valid = !plan.errors.length && validDate(date) && Boolean(effectivePayee);

  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element || element.open) return;
    element.showModal();
    if (singleDate) payeeInput.current?.focus();
  }, [singleDate]);

  useAnchoredOptions(showPayees, payeeInput, payeeList, actions);
  useLayoutEffect(() => {
    const list = payeeList.current;
    const item = list?.children.item(activePayeeIndex);
    if (!list || !item) return;
    const bounds = list.getBoundingClientRect();
    const option = item.getBoundingClientRect();
    if (option.top < bounds.top) list.scrollTop += option.top - bounds.top;
    else if (option.bottom > bounds.bottom) list.scrollTop += option.bottom - bounds.bottom;
  }, [activePayeeIndex]);

  const closePayees = () => setActivePayeeIndex(-1);

  return <dialog ref={dialog} className="merge-dialog" aria-labelledby="merge-heading" onCancel={(event) => {
    event.preventDefault();
    if (!busy) onClose();
  }}>
    <form onSubmit={(event) => {
      event.preventDefault();
      if (valid && !busy) onConfirm({ date, payee: effectivePayee, narration });
    }}>
      <div className="toolbar merge-heading"><h2 id="merge-heading">合并记账</h2><span className="muted">{members.length} 笔原交易</span></div>
      <ul className="merge-members" aria-label="所选原交易">
        {members.map((tx) => <li key={tx.id}>
          <div><strong>{reviewPayeeText(tx) || "（无商户）"}</strong><time dateTime={tx.date}>{tx.date}</time></div>
          <span className={`amt ${tx.direction}`}>{tx.direction === "in" ? "+" : "−"}{amountText(tx.amount)} {tx.currency}</span>
        </li>)}
      </ul>
      <div className="merge-totals"><strong>各币种净额</strong>{plan.totals.map(({ currency, amount }) => <span key={currency}>{amountText(amount)} {currency}</span>)}</div>
      {plan.warnings.map((warning) => <p className="merge-warning" key={warning}>{warning}</p>)}
      {plan.skipsPosting && <p className="merge-warning">同一资金账户收支抵消，审批时可确认不入账。</p>}
      {plan.errors.length > 0 && <ul className="merge-errors error-line">{plan.errors.map((message) => <li key={message}>{message}</li>)}</ul>}
      <fieldset disabled={busy} className="merge-fields">
        <label>记账日期<input type="date" value={date} readOnly={singleDate} required onChange={(event) => setDate(event.target.value)} /></label>
        <div className="merge-payee-field">
          <div className="merge-payee-label">
            <label htmlFor={payeeId}>商户</label>
            {payeeOptions.length > 0 && <small id={payeeHintId}>{multiplePayees ? "Tab 切换 · Enter 确认" : "Tab 补全"}</small>}
          </div>
          <input ref={payeeInput} id={payeeId} value={payee} placeholder={payeeOptions[0] ?? "输入商户"} required={!commonPayee}
            maxLength={MAX_NARRATION_LENGTH} autoComplete="off" role={multiplePayees ? "combobox" : undefined}
            aria-autocomplete={multiplePayees ? "list" : undefined} aria-expanded={multiplePayees ? showPayees : undefined}
            aria-controls={showPayees ? payeeListId : undefined}
            aria-activedescendant={showPayees ? `${payeeListId}-${activePayeeIndex}` : undefined}
            aria-describedby={payeeOptions.length > 0 ? payeeHintId : undefined} onBlur={closePayees}
            onChange={(event) => { setPayee(event.target.value); closePayees(); }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
              if (showPayees && (event.key === "Enter" || event.key === "Escape")) {
                event.preventDefault();
                event.stopPropagation();
                closePayees();
                return;
              }
              const tab = event.key === "Tab" && !event.shiftKey && (showPayees || !payee.trim()) && payeeOptions.length > 0;
              const arrow = multiplePayees && (event.key === "ArrowDown" || event.key === "ArrowUp");
              if (!tab && !arrow) return;
              event.preventDefault();
              const step = event.key === "ArrowUp" ? -1 : 1;
              const index = showPayees ? (activePayeeIndex + step + payeeOptions.length) % payeeOptions.length
                : step === 1 ? 0 : payeeOptions.length - 1;
              setPayee(payeeOptions[index]);
              if (multiplePayees) setActivePayeeIndex(index);
            }} />
          {showPayees && <ul id={payeeListId} ref={payeeList} role="listbox" aria-label="商户候选" className="merge-payee-options">
            {payeeOptions.map((option, index) => <li key={option} id={`${payeeListId}-${index}`} role="option" className="merge-payee-option"
              aria-selected={index === activePayeeIndex} onMouseDown={(event) => event.preventDefault()}
              onClick={() => { setPayee(option); closePayees(); }}>
              <span>{option}</span><span aria-hidden="true">{index === activePayeeIndex ? "✓" : ""}</span>
            </li>)}
          </ul>}
        </div>
        <label>账本摘要<input value={narration} maxLength={MAX_NARRATION_LENGTH} onChange={(event) => setNarration(event.target.value)} /></label>
      </fieldset>
      {error && <p className="error-line" role="alert">{error}</p>}
      <div className="toolbar merge-actions" ref={actions}>
        <button className="btn" type="button" disabled={busy} onClick={onClose}>取消</button>
        <button className="btn primary" type="submit" disabled={busy || !valid}>{busy ? "正在合并…" : "创建合并"}</button>
      </div>
    </form>
  </dialog>;
}
