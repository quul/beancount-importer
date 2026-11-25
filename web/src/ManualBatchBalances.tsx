import { useEffect, useState } from "react";
import type { ManualTransactionInput } from "../../src/shared/manual-batch.js";
import type { LedgerBalanceSnapshot, ParsedAccount } from "../../src/shared/types.js";
import { api, ApiError } from "./api";
import { localToday } from "./calendarDates";
import { projectManualBalances, type BalanceValue } from "./manualBalancePreview";

function BalanceAmount({ value }: { value: BalanceValue }) {
  return "amount" in value
    ? <span className="manual-balance-amount"><b>{value.amount}</b> <span className="muted">{value.currency}</span></span>
    : <span className="muted">{value.message}</span>;
}

export default function ManualBatchBalances({ ledgerProfile, fundingAccount, accounts, rows, requireCnySettlement }: {
  ledgerProfile: string;
  fundingAccount: string;
  accounts: ReadonlyMap<string, ParsedAccount>;
  rows: readonly (ManualTransactionInput & { id: number })[];
  requireCnySettlement: boolean;
}) {
  const [snapshot, setSnapshot] = useState<{ ledger: LedgerBalanceSnapshot; date: string } | { error: string }>();

  useEffect(() => {
    const request = new AbortController();
    const date = localToday();
    void api.ledgerBalances(date, ledgerProfile, request.signal).then((ledger) => {
      if (!request.signal.aborted) setSnapshot({ ledger, date });
    }).catch((failure) => {
      if (!request.signal.aborted) setSnapshot({ error: failure instanceof ApiError ? failure.message : "无法读取账户余额" });
    });
    return () => request.abort();
  }, [ledgerProfile]);

  if (!fundingAccount) return null;
  if (!snapshot) return <p className="muted" role="status">正在读取余额…</p>;
  if ("error" in snapshot) return <p className="error-line" role="alert">{snapshot.error}</p>;
  const preview = projectManualBalances(rows, fundingAccount, accounts, snapshot.ledger.balances, requireCnySettlement);
  const recentExpenses = snapshot.ledger.recentExpenses[fundingAccount] ?? [];

  return <section className="manual-batch-balances" aria-label="资金账户余额">
    <section className="manual-balance-total" aria-label="开始余额">
      <div className="manual-balance-step-meta"><h3>开始余额</h3><time dateTime={snapshot.date}>{snapshot.date}</time></div>
      <div className="manual-balance-values">
        {preview.opening.map((value) => <BalanceAmount key={value.currency} value={value} />)}
      </div>
    </section>
    <ol key={fundingAccount} className="manual-balance-steps" role="list" tabIndex={recentExpenses.length || rows.length ? 0 : undefined} aria-label="逐笔余额">
      {recentExpenses.map(({ date, amounts }, index) => <li key={date + "-" + index} className="manual-balance-history">
        <div className="manual-balance-step-meta">
          <time dateTime={date}>{date}</time><small>已入账</small>
        </div>
        <div className="manual-balance-history-amounts">
          {amounts.map((value) => <BalanceAmount key={value.currency} value={value} />)}
        </div>
      </li>)}
      {preview.steps.map((value, index) => <li key={rows[index].id}>
        <div className="manual-balance-step-label">
          <div className="manual-balance-step-meta">
            <span>第 {index + 1} 笔</span><time dateTime={rows[index].date}>{rows[index].date}</time>
          </div>
          {value.account !== fundingAccount && <small>{value.account}</small>}
        </div>
        <BalanceAmount value={value} />
      </li>)}
    </ol>
    <section className="manual-balance-total" aria-label="最后余额">
      <h3>最后余额</h3>
      <div className="manual-balance-values">
        {preview.closing.map((value) => <BalanceAmount key={value.currency} value={value} />)}
      </div>
    </section>
  </section>;
}
