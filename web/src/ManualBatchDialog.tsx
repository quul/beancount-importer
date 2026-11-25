import { useId, useLayoutEffect, useRef, useState } from "react";
import { DEFAULT_MANUAL_CURRENCY, isManualCurrency, manualFundingProblem, validateManualTransaction, MAX_MANUAL_DESCRIPTION, MAX_MANUAL_ROWS,
  type ManualBatchInput, type ManualTransactionInput } from "../../src/shared/manual-batch.js";
import type { ParsedAccount } from "../../src/shared/types.js";
import AccountSelect from "./AccountSelect";
import ManualBatchBalances from "./ManualBatchBalances";
import ManualEntryCalendar from "./ManualEntryCalendar";
import SearchSelect from "./SearchSelect";

type ManualRow = ManualTransactionInput & { id: number };

export default function ManualBatchDialog({ accounts, ledgerProfile, ledgerCurrencies, requireCnySettlement, busy, error, onClose, onSubmit }: {
  accounts: ParsedAccount[];
  ledgerProfile: string;
  ledgerCurrencies: string[];
  requireCnySettlement: boolean;
  busy: boolean;
  error: string;
  onClose: () => void;
  onSubmit: (input: ManualBatchInput) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const uid = useId();
  const nextRowId = useRef(1);
  const submission = useRef<{ key: string; id: string }>();
  const [fundingAccount, setFundingAccount] = useState("");
  const [rows, setRows] = useState<ManualRow[]>([]);
  const [attempted, setAttempted] = useState(false);
  const fundingAccounts = accounts.filter((account) => !manualFundingProblem(account));
  const accountByName = new Map(accounts.map((account) => [account.account, account]));
  const defaultProblem = manualFundingProblem(accountByName.get(fundingAccount));
  const currencyOptions = [...new Set([DEFAULT_MANUAL_CURRENCY, ...ledgerCurrencies, "USD", "HKD", "TWD", "JPY", "EUR"])]
    .filter(isManualCurrency).map((value) => ({ value }));
  const dateCounts = new Map<string, number>();
  for (const { date } of rows) dateCounts.set(date, (dateCounts.get(date) ?? 0) + 1);

  useLayoutEffect(() => {
    if (!dialog.current?.open) dialog.current?.showModal();
  }, []);
  const updateRow = (id: number, patch: Partial<ManualTransactionInput>) =>
    setRows((previous) => previous.map((row) => row.id === id ? { ...row, ...patch } : row));
  const amountId = (id: number) => uid + "-amount-" + id;
  const addRow = (date: string) => {
    const id = nextRowId.current++;
    setRows((previous) => [...previous, { id, date, amount: "", currency: DEFAULT_MANUAL_CURRENCY, description: "" }]);
  };
  const rowProblems = (row: ManualTransactionInput) =>
    validateManualTransaction(row, accountByName.get(row.fundingAccount ?? fundingAccount), requireCnySettlement).problems;

  const submit = () => {
    if (!rows.length) return;
    setAttempted(true);
    const payload = rows.map(({ id: _id, ...row }) => row);
    const firstInvalid = defaultProblem ? uid + "-funding" : rows.map((row) => {
      const problem = rowProblems(row);
      if (problem.amount) return amountId(row.id);
      if (problem.currency) return uid + "-currency-" + row.id;
      if (problem.fundingAccount) return uid + "-account-" + row.id;
    }).find(Boolean);
    if (firstInvalid) {
      document.getElementById(firstInvalid)?.focus();
      return;
    }
    const key = JSON.stringify([fundingAccount, payload]);
    if (submission.current?.key !== key) {
      const suffix = Array.from(crypto.getRandomValues(new Uint8Array(6)), (byte) => byte.toString(16).padStart(2, "0")).join("");
      submission.current = { key, id: "b" + Date.now() + "-" + suffix };
    }
    onSubmit({ batchId: submission.current.id, ledgerProfile, fundingAccount, rows: payload });
  };

  return <dialog ref={dialog} className="merge-dialog manual-batch-dialog" aria-labelledby={uid + "-title"}
    onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <form onSubmit={(event) => { event.preventDefault(); if (!busy) submit(); }}>
      <div className="manual-batch-heading">
        <h2 id={uid + "-title"}>手动录入一批</h2>
        <button type="button" className="btn quiet manual-batch-close" aria-label="关闭手动录入"
          disabled={busy} onClick={onClose}><span aria-hidden="true">×</span></button>
      </div>
      <div className="manual-batch-setup">
        <ManualEntryCalendar dateCounts={dateCounts} disabled={busy || rows.length >= MAX_MANUAL_ROWS} onAdd={addRow} />
        <div className="manual-batch-side">
          <div className="manual-batch-default">
            <label htmlFor={uid + "-funding"}>默认资金账户</label>
            <AccountSelect value={fundingAccount} accounts={fundingAccounts} label="默认资金账户" inputId={uid + "-funding"}
              disabled={busy || !fundingAccounts.length} onChange={setFundingAccount}
              validationMessage={attempted ? defaultProblem : undefined} />
            {!fundingAccounts.length && <p className="muted">账本中没有可用的资金账户。</p>}
          </div>
          <ManualBatchBalances key={ledgerProfile} ledgerProfile={ledgerProfile} fundingAccount={fundingAccount}
            accounts={accountByName} rows={rows} requireCnySettlement={requireCnySettlement} />
        </div>
      </div>
      {rows.length > 0 && <div className="manual-batch-columns" aria-hidden="true">
        <span>交易日期</span><span>金额</span><span>商家或说明</span><span>资金账户</span><span />
      </div>}
      <div className="manual-batch-rows">
        {rows.map((row, index) => {
          const descriptionId = uid + "-description-" + row.id;
          const accountId = uid + "-account-" + row.id;
          const label = "第 " + (index + 1) + " 笔";
          const problems = attempted ? rowProblems(row) : undefined;
          const fundingProblem = defaultProblem && row.fundingAccount === undefined ? undefined : problems?.fundingAccount;
          return <div className="manual-batch-row" role="group" aria-label={label} key={row.id}>
            <time className="manual-batch-date" dateTime={row.date}>{row.date}</time>
            <div className="manual-batch-field">
              <label htmlFor={amountId(row.id)}>金额</label>
              <div className="manual-batch-amount">
                <input id={amountId(row.id)} aria-label={label + "金额"} title="退款填负数" value={row.amount} disabled={busy}
                  aria-invalid={Boolean(problems?.amount) || undefined}
                  aria-describedby={problems?.amount ? amountId(row.id) + "-error" : undefined}
                  onChange={(event) => updateRow(row.id, { amount: event.target.value })} />
                <SearchSelect inputId={uid + "-currency-" + row.id} label={label + "币种"} value={row.currency ?? DEFAULT_MANUAL_CURRENCY}
                  disabled={busy} onChange={(currency) => updateRow(row.id, { currency })} autoHighlight
                  options={currencyOptions} placeholder="币种" emptyMessage="没有匹配的币种" validationMessage={problems?.currency}
                  createOption={(query) => {
                    const value = query.trim().normalize("NFKC").toUpperCase();
                    if (isManualCurrency(value)) return { value, label: "使用 " + value };
                  }} />
              </div>
              {problems?.amount && <small className="review-field-error" id={amountId(row.id) + "-error"}>{problems.amount}</small>}
            </div>
            <div className="manual-batch-field">
              <label htmlFor={descriptionId}>商家或说明</label>
              <input id={descriptionId} aria-label={label + "商家或说明"} maxLength={MAX_MANUAL_DESCRIPTION} value={row.description}
                disabled={busy} onChange={(event) => updateRow(row.id, { description: event.target.value })} />
            </div>
            <div className="manual-batch-field">
              <label htmlFor={accountId}>资金账户</label>
              <AccountSelect value={row.fundingAccount ?? fundingAccount} accounts={fundingAccounts} inputId={accountId} label={label + "资金账户"}
                disabled={busy || !fundingAccount} onChange={(account) => updateRow(row.id, { fundingAccount: account === fundingAccount ? undefined : account })}
                validationMessage={fundingProblem} />
              {row.fundingAccount !== undefined && <button type="button" className="btn small manual-batch-reset"
                aria-label={label + "恢复默认资金账户"} disabled={busy} onClick={() => updateRow(row.id, { fundingAccount: undefined })}>恢复默认</button>}
            </div>
            <button type="button" className="btn manual-batch-remove" aria-label={"删除" + label} title="删除此笔"
              disabled={busy} onClick={() => setRows((previous) => previous.filter(({ id }) => id !== row.id))}>
              <span aria-hidden="true">×</span>
            </button>
          </div>;
        })}
      </div>
      {error && <p className="error-line manual-batch-error" role="alert">{error}</p>}
      <div className="toolbar manual-batch-actions">
        <span className="muted" role="status">{rows.length} 笔</span>
        <span className="spacer" />
        <button type="button" className="btn" disabled={busy} onClick={onClose}>取消</button>
        <button type="submit" className="btn primary" disabled={busy || !fundingAccounts.length || !rows.length}>{busy ? "正在保存…" : "保存并审阅"}</button>
      </div>
    </form>
  </dialog>;
}
