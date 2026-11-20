import { useLayoutEffect, useRef, useState } from "react";
import type { FundingMappingChoice, FundingMappingGroup, SourceType } from "../../src/shared/types.js";
import AccountSelect from "./AccountSelect";

const sourceNames: Partial<Record<SourceType, string>> = { alipay: "支付宝", wechat: "微信", yunshanfu: "云闪付", "bank-cmb": "招商银行" };

export default function FundingDialog({ groups, busy, error, mapping = false, initialChoices = {}, onCancel, onConfirm }: {
  groups: FundingMappingGroup[];
  busy: boolean;
  error: string;
  mapping?: boolean;
  initialChoices?: Record<string, string>;
  onCancel: () => void;
  onConfirm: (mappings: FundingMappingChoice[]) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const actions = useRef<HTMLDivElement>(null);
  const [choices, setChoices] = useState(initialChoices);
  const complete = groups.every(({ id, accounts }) => accounts.includes(choices[id]));

  useLayoutEffect(() => {
    const element = dialog.current!;
    element.showModal();
    if (mapping) heading.current?.focus();
    return () => element.close();
  }, [mapping]);

  return <dialog className="funding-dialog" ref={dialog} aria-labelledby="funding-title" onCancel={(event) => {
    event.preventDefault();
    if (!busy) onCancel();
  }}>
    <form onSubmit={(event) => {
      event.preventDefault();
      if (!busy && complete) onConfirm(groups.map(({ id }) => ({ id, account: choices[id] })));
    }}>
      <h2 id="funding-title" ref={heading} tabIndex={mapping ? -1 : undefined}>{mapping ? "设置资金映射" : "映射资金账户"}</h2>
      <fieldset className="funding-fields" disabled={busy}>
        {groups.map(({ id, label, source, count, accounts, statementOnly }) => <div className="funding-field" key={id}>
          <span>{label}{mapping ? sourceNames[source] && <small>{sourceNames[source]}</small>
            : <small>{sourceNames[source] && `${sourceNames[source]} · `}{count} 笔{statementOnly && " · 仅此账单"}</small>}</span>
          <AccountSelect optionsBottomBoundary={actions} value={choices[id] ?? ""} accounts={accounts.map((account) => ({ account }))} label={`${label}的资金账户`} disabled={busy || !accounts.length}
            onChange={(account) => setChoices((previous) => ({ ...previous, [id]: account }))} />
          {!accounts.length && <small role="status">没有可用账户</small>}
        </div>)}
      </fieldset>
      {mapping && <p className="funding-scope muted">映射会用于后续导入，也会更新本批适用的未确认账户。</p>}
      {error && <p className="error-line" role="alert">{error}</p>}
      <div className="toolbar" ref={actions}>
        <button type="button" className="btn" disabled={busy} onClick={onCancel}>取消</button>
        <button type="submit" className="btn primary" disabled={busy || !complete}>{busy ? "保存中…" : mapping ? "保存映射" : "保存并开始审批"}</button>
      </div>
    </form>
  </dialog>;
}
