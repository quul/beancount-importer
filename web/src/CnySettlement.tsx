import { useState } from "react";
import { amountText } from "../../src/shared/postings.js";
import { originalForeignAmount, readPositiveCnyAmount } from "../../src/shared/settlement.js";
import type { CnyRepaymentChoice, ParsedTx } from "../../src/shared/types.js";
import { api } from "./api";

export default function CnySettlement({ tx, batchId, editable, disabled, onSave }: {
  tx: ParsedTx;
  batchId: string;
  editable: boolean;
  disabled: boolean;
  onSave: (amount: string, repaymentKey?: string) => void;
}) {
  const original = originalForeignAmount(tx);
  const [amount, setAmount] = useState(tx.currency === "CNY" ? tx.amount.toFixed(2) : "");
  const [selected, setSelected] = useState(tx.cnySettlement?.repayment?.key ?? "");
  const [choices, setChoices] = useState<CnyRepaymentChoice[] | "loading" | "error">();
  if (!original) return null;
  const repayment = tx.cnySettlement?.repayment;
  const showsCny = tx.currency === "CNY" || tx.requireCnySettlement;
  const bookedAmount = tx.currency === "CNY" ? `¥${tx.amount.toFixed(2)}`
    : showsCny ? "待确认" : `${amountText(tx.amount)} ${tx.currency}`;
  const selectedChoice = Array.isArray(choices) ? choices.find(({ key }) => key === selected) : undefined;
  const entered = readPositiveCnyAmount(amount);
  const overAllocated = entered !== undefined && selectedChoice && entered > selectedChoice.remaining;
  const load = () => {
    setChoices("loading");
    void api.cnyRepayments(batchId, tx.id).then((rows) => {
      setChoices(rows);
      setSelected((key) => rows.some((row) => row.key === key) ? key : "");
    }, () => setChoices("error"));
  };

  return <section className="detail-section cny-settlement" aria-label="交易金额">
    <dl className="tx-meta settlement-summary">
      <div><dt>原交易</dt><dd>{amountText(original.amount)} {original.currency}</dd></div>
      <div><dt>{showsCny ? "人民币入账金额" : "记账金额"}</dt><dd>{bookedAmount}</dd></div>
      {repayment && <div><dt>关联还款</dt><dd>{repayment.date} · {repayment.payee || repayment.sourceFile} · ¥{repayment.amount.toFixed(2)}</dd></div>}
    </dl>
    {editable && <div className="settlement-fields">
      <label htmlFor={`review-settlement-${tx.id}`}>本笔人民币金额</label>
      <input id={`review-settlement-${tx.id}`} inputMode="decimal" value={amount}
        disabled={disabled} onChange={(event) => setAmount(event.target.value)} />
      <div className="toolbar">
        <button type="button" className="btn small primary" disabled={disabled || entered === undefined || Boolean(overAllocated)}
          onClick={() => onSave(amount.trim(), selected || undefined)}>保存人民币金额</button>
        <button type="button" className="btn small" disabled={disabled || choices === "loading"} onClick={load}>查找人民币还款</button>
      </div>
      {Array.isArray(choices) && (choices.length ? <label>关联还款
        <select value={selected} disabled={disabled} onChange={(event) => setSelected(event.target.value)}>
          <option value="">手动确认金额</option>
          {choices.map(({ key, date, amount: total, payee, sourceFile, row }) => <option value={key} key={key}>
            {date} · {payee || sourceFile} · ¥{total.toFixed(2)} · 第 {row} 行
          </option>)}
        </select>
      </label> : <p className="muted" role="status">暂无同卡人民币还款记录。</p>)}
      {choices === "error" && <p role="status">暂时无法读取还款记录。</p>}
      {selectedChoice && <p className="muted">请填写本笔的分摊金额。该还款可分配 ¥{selectedChoice.remaining.toFixed(2)}。</p>}
      {overAllocated && <p className="error-line" role="alert">分摊金额超出可用金额。</p>}
    </div>}
  </section>;
}
