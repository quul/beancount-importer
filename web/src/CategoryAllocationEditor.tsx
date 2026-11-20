import { allocationAmountText, planCategoryAllocations } from "../../src/shared/categoryAllocations.js";
import { amountText } from "../../src/shared/postings.js";
import type { CategoryAllocation, ParsedAccount, ParsedTx } from "../../src/shared/types.js";
import AccountSelect from "./AccountSelect";

export default function CategoryAllocationEditor({ tx, allocations, accounts, dirty, disabled, readOnly, onChange, onSave, onDiscard }: {
  tx: ParsedTx;
  allocations: CategoryAllocation[];
  accounts: ParsedAccount[];
  dirty: boolean;
  disabled: boolean;
  readOnly: boolean;
  onChange: (allocations: CategoryAllocation[]) => void;
  onSave: () => void;
  onDiscard: () => void;
}) {
  const { total, remaining, error, postings } = planCategoryAllocations(tx, allocations);
  const outsideLedger = Boolean(postings?.some(({ account }) => !accounts.some((option) => option.account === account)));
  const change = (index: number, patch: Partial<CategoryAllocation>) =>
    onChange(allocations.map((allocation, i) => i === index ? { ...allocation, ...patch } : allocation));
  const payee = tx.payee || "（无商户）";

  return <div className="category-allocations" role="group" aria-label={`分类金额 · ${payee}`}>
    {allocations.map((allocation, index) => <div className="category-allocation" key={index}>
      <AccountSelect value={allocation.account} accounts={accounts} label={`分类账户 ${index + 1} · ${payee}`} disabled={disabled} autoHighlight
        onChange={(account) => change(index, { account })} />
      <input inputMode="decimal" value={allocation.amount} aria-label={`分类金额 ${index + 1} · ${payee}`}
        placeholder="金额" disabled={disabled} onChange={(event) => change(index, { amount: event.target.value })} />
      {!readOnly && <button className="btn category-icon" type="button" aria-label={`移除分类 ${index + 1} · ${payee}`}
        disabled={disabled || allocations.length === 1} onClick={() => onChange(allocations.filter((_, i) => i !== index))}>−</button>}
    </div>)}
    <div className="category-totals" role="status">
      <span>合计 {allocationAmountText(total)} / {amountText(tx.amount)} {tx.currency}</span>
      {remaining !== 0n && <span className="category-difference">{remaining > 0n ? "还差" : "超出"} {allocationAmountText(remaining > 0n ? remaining : -remaining)}</span>}
      {outsideLedger && <span className="error-line">请选择账本中的账户</span>}
      {error && error !== "分类金额合计须等于交易金额" && <span className="error-line">{error}</span>}
    </div>
    {dirty && <div className="toolbar category-edit-actions">
      <button className="btn primary small" type="button" disabled={disabled || !postings || outsideLedger} onClick={onSave}>保存分类</button>
      <button className="btn small" type="button" disabled={disabled} onClick={onDiscard}>取消</button>
    </div>}
  </div>;
}
