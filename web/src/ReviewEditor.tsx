import type { DraftPosting, ParsedAccount, ParsedTx, TxDecision } from "../../src/shared/types.js";
import { amountText } from "../../src/shared/postings.js";
import AccountSelect from "./AccountSelect";
import TransactionFlag from "./TransactionFlag";

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

export function draftDecision(tx: ParsedTx, draft: ReviewDraft, original?: ReviewDraft): TxDecision {
  const decision: TxDecision = { id: tx.id };
  if (draft.tags !== original?.tags) decision.tags = parseTags(draft.tags);
  if (draft.flag !== original?.flag) decision.flag = draft.flag;
  if (draft.reviewNote !== original?.reviewNote) decision.reviewNote = draft.reviewNote;
  if (draft.split) {
    const postings = draft.postings.map((posting) => ({ ...posting, amount: Number(posting.amount), currency: posting.currency.trim().toUpperCase() }));
    const previous = tx.postings;
    if (!previous || postings.length !== previous.length || postings.some((posting, index) => (
      posting.account !== previous[index].account || posting.amount !== previous[index].amount || posting.currency !== previous[index].currency
    ))) decision.postings = postings;
  } else if (tx.postings) {
    decision.postings = null;
  }
  return decision;
}

export default function ReviewEditor({ tx, draft, dirty, accounts, disabled, editFlag, onChange, onSave, onDiscard }: {
  tx: ParsedTx; draft: ReviewDraft; dirty: boolean; accounts: ParsedAccount[]; disabled: boolean;
  editFlag?: boolean;
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
  const splitError = !tx.merge && draft.split && (invalid || draft.postings.length < 2 || imbalances.length > 0);
  const badTags = invalidTags(draft.tags);
  const setPosting = (index: number, patch: Partial<ReviewDraft["postings"][number]>) => onChange({ ...draft, postings: draft.postings.map((posting, i) => i === index ? { ...posting, ...patch } : posting) });

  return <div className="review-editor">
    <fieldset disabled={disabled}>
      <div className="editor-grid">
        <label className="wide">审批备注<textarea rows={3} maxLength={2000} value={draft.reviewNote} onChange={(event) => onChange({ ...draft, reviewNote: event.target.value })} /></label>
        <label>标签<input value={draft.tags} placeholder="trip2026 reimbursement" onChange={(event) => onChange({ ...draft, tags: event.target.value })} /><small>英文标签，空格分隔。</small>{badTags.length > 0 && <small className="error-line">标签格式无效：{badTags.join("、")}</small>}</label>
        {editFlag && <div className="editor-flag"><span>账本标记</span>
          <TransactionFlag label="单笔账本标记" value={draft.flag} onChange={(flag) => onChange({ ...draft, flag })} />
        </div>}
      </div>
      {!tx.merge && <label className="check-label"><input type="checkbox" checked={draft.split} onChange={(event) => onChange({ ...draft, split: event.target.checked })} />拆分分录</label>}
      {!tx.merge && draft.split && <div className="posting-editor">
        <p className="muted">每种币种合计须为 0。</p>
        {draft.postings.map((posting, index) => <div className="posting-row" key={index}>
          <AccountSelect value={posting.account} accounts={accounts} label={`第 ${index + 1} 条分录的账户`} onChange={(account) => setPosting(index, { account })} />
          <input inputMode="decimal" aria-label={`第 ${index + 1} 条 posting 金额`} value={posting.amount} onChange={(event) => setPosting(index, { amount: event.target.value })} placeholder="带正负号的金额" />
          <input aria-label={`第 ${index + 1} 条 posting 币种`} value={posting.currency} onChange={(event) => setPosting(index, { currency: event.target.value })} placeholder="CNY" />
          <button className="btn small" onClick={() => onChange({ ...draft, postings: draft.postings.filter((_, i) => i !== index) })}>移除</button>
        </div>)}
        <button className="btn small" onClick={() => onChange({ ...draft, postings: [...draft.postings, { account: "", amount: "0", currency: tx.currency }] })}>＋ 添加分录</button>
        {splitError && <p className="error-line" role="alert">{invalid ? "请补全账户、金额和币种。" : draft.postings.length < 2 ? "至少两条分录。" : `尚未平衡：${imbalances.map(([currency, amount]) => `${amount.toFixed(2)} ${currency}`).join("；")}`}</p>}
      </div>}
      <div className="toolbar editor-actions"><button className="btn primary small" disabled={!dirty || Boolean(splitError) || badTags.length > 0} onClick={onSave}>保存编辑</button><button className="btn small" disabled={!dirty} onClick={onDiscard}>放弃编辑</button>{dirty && <span className="muted">未保存</span>}</div>
    </fieldset>
  </div>;
}

export function TransactionSourceDetails({ tx, counterpart }: { tx: ParsedTx; counterpart?: ParsedTx }) {
  return <dl className="tx-meta source-details">
    <div><dt>原始来源</dt><dd>{tx.sourceFile} · 第 {tx.row} 行 · {tx.source}</dd></div>
    {tx.sourceStatus && <div><dt>账单状态</dt><dd>{tx.sourceStatus}</dd></div>}
    {tx.note && <div><dt>账单备注</dt><dd>{tx.note}</dd></div>}
    {tx.rawAccount && <div><dt>支付方式</dt><dd>{tx.rawAccount}</dd></div>}
    {tx.recognition?.fundingMethod && <div><dt>推断资金方式</dt><dd>{tx.recognition.fundingMethod}</dd></div>}
    {tx.originalDirection && <div><dt>原始收支</dt><dd>{tx.originalDirection}</dd></div>}
    {tx.sourceTxId && <div><dt>交易号</dt><dd><code>{tx.sourceTxId}</code></dd></div>}
    {counterpart && <div><dt>{tx.eventType === "refund" ? "原消费" : "对应退款"}</dt>
      <dd>{amountText(counterpart.amount)} {counterpart.currency} · {counterpart.date}{counterpart.time && ` ${counterpart.time}`}
        {counterpart.sourceTxId && <><br /><code>{counterpart.sourceTxId}</code></>}
      </dd></div>}
    {tx.duplicateOf && <div><dt>重复依据</dt><dd>{tx.duplicateOf.label}<br />{tx.duplicateOf.where} · <code>{tx.duplicateOf.id}</code></dd></div>}
    {tx.refundReviewMode === "follow-purchase" ? <div><dt>分类依据</dt><dd>沿用原消费分类</dd></div>
      : (tx.suggestedAccount || tx.reason) && <div><dt>分类依据</dt><dd>置信度 {Math.round(tx.confidence * 100)}%{tx.reason && <><br />{tx.reason}</>}</dd></div>}
  </dl>;
}
