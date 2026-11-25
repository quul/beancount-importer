import { useState } from "react";
import { readExchangeQuantity } from "../../src/shared/currency-exchange.js";
import { accountIsActive } from "../../src/shared/funding.js";
import { amountText, isExchangeAssetAccount, isExchangeCurrency, isExchangeFundingAccount } from "../../src/shared/postings.js";
import type { CurrencyExchangeInput, ParsedAccount, ParsedTx } from "../../src/shared/types.js";
import SearchSelect from "./SearchSelect";

export default function CurrencyExchange({ tx, accounts, ledgerCurrencies, editable, disabled, problem, onSave }: {
  tx: ParsedTx;
  accounts: ParsedAccount[];
  ledgerCurrencies: string[];
  editable: boolean;
  disabled: boolean;
  problem?: string;
  onSave: (value: CurrencyExchangeInput | null) => void;
}) {
  const saved = tx.currencyExchange;
  const [receipt, setReceipt] = useState(saved?.account ?? "");
  const [currency, setCurrency] = useState(saved?.currency ?? "");
  const [quantity, setQuantity] = useState(saved ? amountText(saved.amount) : "");
  const account = receipt.trim();
  const amount = readExchangeQuantity(quantity);
  const payment = accounts.find(({ account }) => account === tx.fundingAccount);
  const paymentAvailable = Boolean(payment && isExchangeFundingAccount(payment.account) && accountIsActive(payment, tx.date, "CNY"));
  const target = accounts.find((entry) => entry.account === account);
  const accountError = account && (account.length > 256 || !isExchangeAssetAccount(account) || account === tx.fundingAccount
    ? "请输入不同于付款账户的有效资产账户"
    : target && isExchangeCurrency(currency) && !accountIsActive(target, tx.date, currency)
      ? "到账账户在交易日期尚未生效或不支持到账币种" : "");
  const quantityError = quantity.trim() && amount === undefined;
  const id = `review-exchange-${tx.id}`;
  const changed = tx.status !== "ready" || !saved || saved.account !== account || saved.currency !== currency || saved.amount !== amount;
  const canSave = Boolean(changed && account && !accountError && isExchangeCurrency(currency) && amount !== undefined && paymentAvailable);

  return <details className="detail-section currency-exchange" open={saved ? true : undefined}>
    <summary>货币兑换</summary>
    <dl className="tx-meta settlement-summary">
      <div><dt>实付金额</dt><dd>{amountText(tx.amount)} CNY</dd></div>
      <div><dt>付款账户</dt><dd>{tx.fundingAccount || "待选择"}</dd></div>
      {!editable && saved && <>
        <div><dt>到账账户</dt><dd>{saved.account}</dd></div>
        <div><dt>到账数量</dt><dd>{amountText(saved.amount)} {saved.currency}</dd></div>
      </>}
    </dl>
    {problem && <p className="review-field-error" role="alert">{problem}</p>}
    {editable && <fieldset className="exchange-fields" disabled={disabled}>
      {!paymentAvailable && <p className="review-field-error">请先在交易列表中选择可用的人民币资金账户。</p>}
      <label htmlFor={id}>到账账户</label>
      <input id={id} list={`${id}-accounts`} value={receipt} placeholder="Assets:Crypto:USDC" spellCheck={false} maxLength={256}
        aria-invalid={Boolean(accountError) || undefined} aria-describedby={accountError ? `${id}-account-error` : undefined}
        onChange={(event) => setReceipt(event.target.value)} />
      <datalist id={`${id}-accounts`}>
        {accounts.filter((entry) => isExchangeAssetAccount(entry.account) && entry.account !== tx.fundingAccount
          && accountIsActive(entry, tx.date, isExchangeCurrency(currency) ? currency : undefined))
          .map(({ account }) => <option key={account} value={account} />)}
      </datalist>
      {accountError && <small className="review-field-error" id={`${id}-account-error`}>{accountError}</small>}
      {account && !accountError && !target && <small>新账户会在入账预览中显示开户指令。</small>}
      <div className="exchange-amount-fields">
        <div className="exchange-currency-field">
          <label htmlFor={`${id}-currency`}>到账币种</label>
          <SearchSelect inputId={`${id}-currency`} label="到账币种" value={currency} onChange={setCurrency} disabled={disabled}
            placeholder="搜索币种" emptyMessage="没有匹配的币种" autoHighlight
            options={ledgerCurrencies.filter(isExchangeCurrency).map((value) => ({ value }))}
            createOption={(query) => {
              const value = query.trim().normalize("NFKC").toUpperCase();
              if (isExchangeCurrency(value)) return { value, label: `使用 ${value}` };
            }} />
        </div>
        <label>到账数量<input inputMode="decimal" value={quantity} placeholder="150"
          aria-invalid={Boolean(quantityError) || undefined} onChange={(event) => setQuantity(event.target.value)} />
          {quantityError && <small className="review-field-error">请输入正数，最多八位小数。</small>}
        </label>
      </div>
      <div className="toolbar">
        <button type="button" className="btn small primary" disabled={!canSave}
          onClick={() => onSave({ account, currency, quantity: quantity.trim() })}>
          保存为待入账
        </button>
        {saved && <button type="button" className="btn small" onClick={() => onSave(null)}>恢复普通交易</button>}
      </div>
    </fieldset>}
  </details>;
}
