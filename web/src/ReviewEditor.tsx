import { useState } from "react";
import type { DraftPosting, ParsedAccount, ParsedTx, TxDecision } from "../../src/shared/types.js";
import { accountPattern, amountText, currencyPattern, fundingPostingSign, transactionPostings } from "../../src/shared/postings.js";
import AccountSelect from "./AccountSelect";
import { calculatePostingAmount } from "./postingCalculator";

type PostingInput = Omit<DraftPosting, "amount"> & { amount: string };

export interface ReviewDraft {
  tags: string;
  flag: "*" | "!";
  reviewNote: string;
  split: boolean;
  postings?: PostingInput[];
}

export function parseTags(value: string): string[] {
  return [...new Set(value.split(/[\s,，]+/).map((tag) => tag.replace(/^#+/, "")).filter(Boolean))];
}

export function invalidTags(value: string): string[] {
  return parseTags(value).filter((tag) => !/^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(tag));
}

export function draftPostings(tx: ParsedTx, draft: ReviewDraft): PostingInput[] {
  if (draft.postings) return draft.postings;
  const amount = -fundingPostingSign(tx) * tx.amount;
  const postings: DraftPosting[] = tx.postings || tx.fundingAccount2 ? transactionPostings(tx) : [
    { account: tx.finalAccount || tx.suggestedAccount, amount, currency: tx.currency },
    { account: tx.fundingAccount, amount: -amount, currency: tx.currency },
  ];
  return postings.map((posting) => ({ ...posting, amount: String(posting.amount) }));
}

export function makeDraft(tx: ParsedTx): ReviewDraft {
  return {
    tags: (tx.tags ?? []).join(" "), flag: tx.flag ?? "*", reviewNote: tx.reviewNote ?? "", split: Boolean(tx.postings),
  };
}

export function draftDecision(tx: ParsedTx, draft: ReviewDraft, original?: ReviewDraft, postings?: DraftPosting[]): TxDecision {
  const decision: TxDecision = { id: tx.id };
  if (draft.tags !== original?.tags) decision.tags = parseTags(draft.tags);
  if (draft.flag !== original?.flag) decision.flag = draft.flag;
  if (draft.reviewNote !== original?.reviewNote) decision.reviewNote = draft.reviewNote;
  if (postings) {
    const previous = tx.postings;
    if (!previous || postings.length !== previous.length || postings.some((posting, index) => (
      posting.account !== previous[index].account || posting.amount !== previous[index].amount || posting.currency !== previous[index].currency
    ))) decision.postings = postings;
  } else if (!draft.split && tx.postings) {
    decision.postings = null;
  }
  return decision;
}

const postingCurrency = (value: string) => value.normalize("NFKC").trim().toUpperCase();

export function shakeInvalidFields(fields: readonly HTMLElement[]) {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const animations = fields.map((field) => (field.closest(".account-select-field") ?? field).animate(
    [0, -3, 3, -2, 0].map((offset) => ({ transform: `translateX(${offset}px)` })),
    { duration: 240, easing: "ease-out" },
  ));
  return () => { for (const animation of animations) animation.cancel(); };
}

export function validatePostingDraft(inputs: PostingInput[], accounts: Pick<ParsedAccount, "account">[]) {
  const names = new Set(accounts.map(({ account }) => account));
  const postings: DraftPosting[] = [];
  const totals = new Map<string, number>();
  const errors = inputs.map(({ account, amount, currency: rawCurrency }) => {
    const calculation = calculatePostingAmount(amount);
    const currency = postingCurrency(rawCurrency);
    const error: Partial<Record<keyof PostingInput, string>> = {};
    if (!account) error.account = "请选择账户";
    else if (!accountPattern.test(account) || !names.has(account)) error.account = "请选择有效的账本账户";
    if (!currency) error.currency = "请输入币种";
    else if (!currencyPattern.test(currency) || currency.length > 24) error.currency = "币种代码无效";
    if (calculation.error !== undefined) error.amount = calculation.error;
    else {
      const value = Number(calculation.value);
      postings.push({ account, amount: value, currency });
      totals.set(currency, (totals.get(currency) ?? 0) + Number(value.toFixed(8)));
    }
    return error;
  });
  const tooFew = inputs.length < 2;
  if (!tooFew && !errors.some(({ account }) => account) && inputs.every(({ account }) => account === inputs[0].account)) {
    errors[1].account = "请选择不同的账户";
  }
  const imbalances = new Map(errors.some(({ amount, currency }) => amount || currency) || tooFew
    ? [] : [...totals].filter(([, total]) => Math.abs(total) > 0.0000001));
  const valid = !tooFew && !imbalances.size && !errors.some(({ account, amount, currency }) => account || amount || currency);
  return { postings: valid ? postings : undefined, errors, imbalances, tooFew };
}

export function ReviewMetadataFields({ tx, draft, disabled, tagError, onChange }: {
  tx: ParsedTx; draft: ReviewDraft; disabled: boolean; tagError?: string;
  onChange: (draft: ReviewDraft) => void;
}) {
  const badTags = invalidTags(draft.tags);
  const tagMessage = badTags.length > 0 ? `标签格式无效：${badTags.join("、")}` : tagError;
  const tagsId = `review-tags-${tx.id}`;

  return <fieldset className="review-editor" disabled={disabled}>
    <div className="editor-grid">
      <label className="wide">审批备注<textarea rows={3} maxLength={2000} value={draft.reviewNote} onChange={(event) => onChange({ ...draft, reviewNote: event.target.value })} /></label>
      <label>标签<input id={tagsId} value={draft.tags} placeholder="trip2026 reimbursement" aria-invalid={Boolean(tagMessage) || undefined}
        aria-describedby={`${tagsId}-hint`} onChange={(event) => onChange({ ...draft, tags: event.target.value })} />
        <small id={`${tagsId}-hint`} className={tagMessage ? "review-field-error" : undefined}>{tagMessage || "英文标签，空格分隔。"}</small></label>
    </div>
  </fieldset>;
}

export function ReviewPostingFields({ tx, draft, accounts, disabled, postingError, showValidation, onChange }: {
  tx: ParsedTx; draft: ReviewDraft; accounts: ParsedAccount[]; disabled: boolean; postingError?: string;
  showValidation: boolean;
  onChange: (draft: ReviewDraft) => void;
}) {
  const [calculationError, setCalculationError] = useState<{ index: number; input: string; message: string }>();
  const showPostings = !tx.merge && draft.split;
  const postings = showPostings ? draftPostings(tx, draft) : [];
  const validation = showPostings && showValidation ? validatePostingDraft(postings, accounts) : undefined;
  const postingsId = `review-postings-${tx.id}`;
  const setPosting = (index: number, patch: Partial<PostingInput>) => {
    if (patch.amount !== undefined && calculationError?.index === index) setCalculationError(undefined);
    onChange({ ...draft, postings: postings.map((posting, i) => i === index ? { ...posting, ...patch } : posting) });
  };

  return <fieldset disabled={disabled}>
    {!tx.merge && <label className="split-postings-toggle">
      <span>拆分分录</span>
      <input id={postingsId} className="checkbox" type="checkbox" checked={draft.split} aria-describedby={postingError ? `${postingsId}-error` : undefined}
        onChange={(event) => { setCalculationError(undefined); onChange({ ...draft, split: event.target.checked }); }} />
    </label>}
    {postingError && <p className="review-field-error" id={`${postingsId}-error`}>{postingError}{tx.merge && "。请先撤销合并，再修正原交易。"}</p>}
    {showPostings && <div className="posting-editor">
      {postings.map((posting, index) => {
        const errors = validation?.errors[index];
        const calculatorMessage = calculationError?.index === index && calculationError.input === posting.amount ? calculationError.message : undefined;
        const amountMessage = calculatorMessage || errors?.amount;
        const currency = postingCurrency(posting.currency);
        const unbalanced = validation?.imbalances.has(currency);
        const amountErrorId = `${postingsId}-${index}-amount-error`;
        const currencyErrorId = `${postingsId}-${index}-currency-error`;
        return <div className="posting-row" key={index}>
          <AccountSelect value={posting.account} accounts={accounts} label={`第 ${index + 1} 条分录的账户`}
            validationMessage={errors?.account} onChange={(account) => setPosting(index, { account })} />
          <div className="posting-input-group">
            <input inputMode="decimal" aria-label={`第 ${index + 1} 条分录的金额`} value={posting.amount} placeholder="金额"
              title="支持四则运算，按 Enter 计算"
              aria-invalid={Boolean(amountMessage || unbalanced) || undefined}
              aria-describedby={amountMessage ? amountErrorId : unbalanced ? `${postingsId}-balance` : undefined}
              onChange={(event) => setPosting(index, { amount: event.target.value })}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
                event.preventDefault();
                if (event.repeat) return;
                const result = calculatePostingAmount(posting.amount);
                if (result.error !== undefined) {
                  setCalculationError({ index, input: posting.amount, message: result.error });
                  shakeInvalidFields([event.currentTarget]);
                } else if (result.value !== posting.amount) setPosting(index, { amount: result.value });
              }} />
            {amountMessage && <small id={amountErrorId} className="review-field-error" role={calculatorMessage ? "alert" : undefined}>{amountMessage}</small>}
          </div>
          <div className="posting-input-group">
            <input aria-label={`第 ${index + 1} 条分录的币种`} value={posting.currency} placeholder="币种"
              aria-invalid={Boolean(errors?.currency) || undefined} aria-describedby={errors?.currency ? currencyErrorId : undefined}
              onChange={(event) => setPosting(index, { currency: event.target.value })} />
            {errors?.currency && <small id={currencyErrorId} className="review-field-error">{errors.currency}</small>}
          </div>
          <button type="button" className="btn small posting-remove" aria-label={`移除第 ${index + 1} 条分录`} title="移除分录"
            onClick={() => { setCalculationError(undefined); onChange({ ...draft, postings: postings.filter((_, i) => i !== index) }); }}>−</button>
        </div>;
      })}
      <button type="button" className="btn small posting-add" disabled={postings.length >= 40}
        aria-invalid={validation?.tooFew || undefined} aria-describedby={validation?.tooFew ? `${postingsId}-minimum` : undefined}
        onClick={() => onChange({ ...draft, postings: [...postings, { account: "", amount: "", currency: tx.currency }] })}>＋ 添加一行</button>
      {validation?.tooFew && <small id={`${postingsId}-minimum`} className="review-field-error">至少需要两条分录</small>}
      {validation && validation.imbalances.size > 0 && <ul id={`${postingsId}-balance`} className="posting-balance review-field-error">
        {[...validation.imbalances].map(([currency, total]) => <li key={currency}>{currency} 未平衡，差额 {total > 0 ? "+" : ""}{amountText(total)}</li>)}
      </ul>}
    </div>}
  </fieldset>;
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
