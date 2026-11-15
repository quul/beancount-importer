import type { DraftPosting, ParsedAccount, ParsedTx, TxDecision } from "../../src/shared/types.js";

export interface ReviewDraft {
  tags: string;
  flag: "*" | "!";
  reviewNote: string;
  split: boolean;
  postings: Array<{ account: string; amount: string; currency: string }>;
}

export function parseTags(value: string): string[] {
  return [...new Set(value.split(/[\s,，]+/).map((tag) => tag.replace(/^#+/, "")).filter(Boolean))];
}

export function invalidTags(value: string): string[] {
  return parseTags(value).filter((tag) => !/^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(tag));
}

export function makeDraft(tx: ParsedTx): ReviewDraft {
  const amount = tx.direction === "in" ? -tx.amount : tx.amount;
  const postings: DraftPosting[] = tx.postings ?? [
    { account: tx.finalAccount || tx.suggestedAccount, amount, currency: tx.currency },
    { account: tx.fundingAccount, amount: -amount, currency: tx.currency },
  ];
  return {
    tags: (tx.tags ?? []).join(" "), flag: tx.flag ?? "*", reviewNote: tx.reviewNote ?? "", split: Boolean(tx.postings),
    postings: postings.map((posting) => ({ ...posting, amount: String(posting.amount) })),
  };
}

export function draftDecision(tx: ParsedTx, draft: ReviewDraft): TxDecision {
  return {
    id: tx.id, tags: parseTags(draft.tags), flag: draft.flag, reviewNote: draft.reviewNote,
    postings: draft.split ? draft.postings.map((posting) => ({ ...posting, amount: Number(posting.amount), currency: posting.currency.trim().toUpperCase() })) : null,
  };
}

export function AccountSelect({ value, accounts, onChange, disabled, funding = false, label }: {
  value: string; accounts: ParsedAccount[]; onChange: (value: string) => void; disabled?: boolean; funding?: boolean; label: string;
}) {
  const candidates = accounts.filter((account) => !funding || /^(Assets|Liabilities):/.test(account.account));
  return <select className="account-select" aria-label={label} value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled}>
    {!candidates.some((account) => account.account === value) && <option value={value} disabled>{value ? `${value}（未在账本定义）` : "请选择账本账户"}</option>}
    {candidates.map((account) => <option value={account.account} key={account.account}>{account.account}{account.closedAt ? `（关闭于 ${account.closedAt}）` : ""}</option>)}
  </select>;
}

export default function ReviewEditor({ tx, draft, dirty, accounts, disabled, onChange, onSave, onDiscard }: {
  tx: ParsedTx; draft: ReviewDraft; dirty: boolean; accounts: ParsedAccount[]; disabled: boolean;
  onChange: (draft: ReviewDraft) => void; onSave: () => void; onDiscard: () => void;
}) {
  const totals = new Map<string, number>();
  let invalid = false;
  for (const posting of draft.postings) {
    const amount = Number(posting.amount);
    if (!posting.account || !posting.currency.trim() || posting.amount.trim() === "" || !Number.isFinite(amount)) invalid = true;
    const currency = posting.currency.trim().toUpperCase();
    totals.set(currency, (totals.get(currency) ?? 0) + amount);
  }
  const imbalances = [...totals].filter(([, amount]) => Math.abs(amount) > 0.000001);
  const splitError = draft.split && (invalid || draft.postings.length < 2 || imbalances.length > 0);
  const badTags = invalidTags(draft.tags);
  const setPosting = (index: number, patch: Partial<ReviewDraft["postings"][number]>) => onChange({ ...draft, postings: draft.postings.map((posting, i) => i === index ? { ...posting, ...patch } : posting) });

  return <div className="review-editor">
    <fieldset disabled={disabled}>
      <div className="editor-grid">
        <label>标签<input value={draft.tags} placeholder="trip2026 reimbursement" onChange={(event) => onChange({ ...draft, tags: event.target.value })} /><small>空格分隔；中文写审阅备注。</small>{badTags.length > 0 && <small className="error-line">标签格式无效：{badTags.join("、")}</small>}</label>
        <label>账本标记<select value={draft.flag} onChange={(event) => onChange({ ...draft, flag: event.target.value as "*" | "!" })}><option value="*">* 正常</option><option value="!">! 待核实</option></select></label>
        <label className="wide">审阅备注<textarea rows={2} value={draft.reviewNote} onChange={(event) => onChange({ ...draft, reviewNote: event.target.value })} placeholder="记录优惠、代付或需要核实的原因" /></label>
      </div>
      <label className="check-label"><input type="checkbox" checked={draft.split} onChange={(event) => onChange({ ...draft, split: event.target.checked })} />手动编辑多条 posting（拆分优惠、代付、混合支付）</label>
      {draft.split && <div className="posting-editor">
        <p className="muted">金额带正负号，每个币种合计为 0。</p>
        {draft.postings.map((posting, index) => <div className="posting-row" key={index}>
          <AccountSelect value={posting.account} accounts={accounts} label={`第 ${index + 1} 条 posting 账户`} onChange={(account) => setPosting(index, { account })} />
          <input inputMode="decimal" aria-label={`第 ${index + 1} 条 posting 金额`} value={posting.amount} onChange={(event) => setPosting(index, { amount: event.target.value })} placeholder="带正负号的金额" />
          <input aria-label={`第 ${index + 1} 条 posting 币种`} value={posting.currency} onChange={(event) => setPosting(index, { currency: event.target.value })} placeholder="CNY" />
          <button className="btn small" onClick={() => onChange({ ...draft, postings: draft.postings.filter((_, i) => i !== index) })}>移除</button>
        </div>)}
        <button className="btn small" onClick={() => onChange({ ...draft, postings: [...draft.postings, { account: "", amount: "0", currency: tx.currency }] })}>＋ 添加 posting</button>
        {splitError && <p className="error-line" role="alert">{invalid ? "请补全账户、金额和币种。" : draft.postings.length < 2 ? "至少保留两条 posting。" : `尚未平衡：${imbalances.map(([currency, amount]) => `${amount.toFixed(2)} ${currency}`).join("；")}`}</p>}
      </div>}
      <div className="toolbar editor-actions"><button className="btn primary small" disabled={!dirty || Boolean(splitError) || badTags.length > 0} onClick={onSave}>保存此笔编辑</button><button className="btn small" disabled={!dirty} onClick={onDiscard}>放弃这些改动</button>{dirty && <span className="muted">未保存，预览已失效。</span>}</div>
    </fieldset>
    <div className="source-details"><b>原始来源</b> {tx.sourceFile} · 第 {tx.row} 行 · {tx.source}<br />支付方式：{tx.rawAccount || "未提供"} · 状态：{tx.sourceStatus || "未提供"} · 原始收支：{tx.originalDirection || tx.direction}{tx.sourceTxId && <><br />交易号：<code>{tx.sourceTxId}</code></>}{tx.excludedReason && <p className="error-line">排除原因：{tx.excludedReason}</p>}{tx.issues?.map((issue, index) => <p className="error-line" key={index}>{issue}</p>)}</div>
  </div>;
}
