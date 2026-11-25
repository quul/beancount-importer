import { useEffect, useMemo, useState } from "react";
import { amountText } from "../../src/shared/postings.js";
import { mayHaveSplitCharges, splitChargeKind, splitChargeMemberIds } from "../../src/shared/split-charges.js";
import { activeTransactions } from "../../src/shared/transactionMerge.js";
import type { ImportPreview, SplitChargeLine, SplitChargeMatch, SplitChargeReview } from "../../src/shared/types.js";
import { api, ApiError } from "./api";

type Action = "confirm" | "exclude" | "clear";
export type SplitChargeRowHints = { batchId: string; ids: ReadonlySet<string> };

const refundEvidence = { reference: "退款引用原交易号", order: "退款与原扣款的订单号一致", amount: "原扣款与退款等额，时间相近" };
const splitEvidence = { order: "拆单明细的订单号一致", merchant: "拆单明细与原扣款的商家一致", amount: "拆单金额合计吻合，时间相近" };

export function revealSplitChargeReview(rowId: string) {
  const panel = document.querySelector<HTMLDetailsElement>("#split-charge-review");
  if (!panel) return;
  const row = panel.querySelector(`[data-split-charge-row="${CSS.escape(rowId)}"]`);
  const group = row?.closest<HTMLDetailsElement>(".split-charge-group");
  panel.open = true;
  if (group) group.open = true;
  const target = group ?? panel;
  target.querySelector("summary")?.focus({ preventScroll: true });
  target.scrollIntoView({ block: "start" });
}

function MatchLine({ role, value, currency }: { role: string; value: SplitChargeLine; currency: string }) {
  return <li className="split-charge-line" data-split-charge-row={value.id}>
    <span className="split-charge-role">{role}{value.posted && <small>已入账</small>}</span>
    <span><time dateTime={value.time ? value.date + "T" + value.time : value.date}>{value.date}{value.time && " " + value.time}</time>
      {value.payee && <small>{value.payee}</small>}</span>
    <span className="split-charge-source">
      {value.orderId && <small>订单号 {value.orderId}</small>}
      {value.sourceTxId && <small>流水号 {value.sourceTxId}</small>}
      {value.file && <small title={value.file}>{value.file}{value.line ? " · 第 " + value.line + " 行" : ""}</small>}
    </span>
    <strong>{amountText(value.amount)} {currency}</strong>
  </li>;
}

function MatchDetails({ match }: { match: SplitChargeMatch }) {
  return <>
    <ul className="split-charge-lines">
      <MatchLine role={match.refund ? "原扣款" : "合计候选"} value={match.original} currency={match.currency} />
      {match.refund && <MatchLine role="等额退款" value={match.refund} currency={match.currency} />}
      {match.parts.map((part, index) => <MatchLine key={part.id} role={`${match.refund ? "拆单" : "明细"} ${index + 1}`} value={part} currency={match.currency} />)}
    </ul>
    <p className="split-charge-equation">{match.parts.map(({ amount }) => amountText(amount)).join(" + ")} = {amountText(match.original.amount)} {match.currency}</p>
    <p className="muted">{match.refundEvidence && <>{refundEvidence[match.refundEvidence]} · </>}{splitEvidence[match.splitEvidence]}</p>
  </>;
}

export default function SplitChargeReviewPanel({ batchId, batch, disabled, readOnly, onAction, onRows }: {
  batchId: string;
  batch: ImportPreview;
  disabled: boolean;
  readOnly: boolean;
  onAction: (id: string, action: Action) => void;
  onRows: (matches: SplitChargeRowHints) => void;
}) {
  const [result, setResult] = useState<{ key: string; review?: SplitChargeReview; error?: string }>();
  const [retry, setRetry] = useState(0);
  const key = useMemo(() => {
    const rows = activeTransactions(batch.txs);
    const saved = batch.splitChargeMatches;
    if (!saved?.length && (readOnly || !mayHaveSplitCharges(rows))) return "";
    return JSON.stringify([readOnly, saved?.map(({ id }) => id), rows.flatMap((tx) => {
      const kind = splitChargeKind(tx);
      return kind ? [[tx.id, kind, tx.date, tx.time, tx.amount, tx.currency, tx.fundingAccount, tx.orderId]] : [];
    })]);
  }, [batch.txs, batch.splitChargeMatches, readOnly]);
  useEffect(() => {
    if (!key) return;
    const request = new AbortController();
    void api.splitChargeReview(batchId, request.signal).then((review) => {
      if (!request.signal.aborted) setResult({ key, review });
    }).catch((failure) => {
      if (!request.signal.aborted) setResult({ key, error: failure instanceof ApiError ? failure.message : "无法查找拆单扣款" });
    });
    return () => request.abort();
  }, [batchId, key, retry]);
  useEffect(() => {
    const review = result?.key === key ? result.review : undefined;
    const matches = review ? [...review.candidates, ...review.confirmed] : [];
    onRows({ batchId, ids: new Set(matches.flatMap(splitChargeMemberIds)) });
  }, [batchId, key, onRows, result]);

  if (!key) return null;
  if (result?.key === key && result.error) return <div className="split-charge-review toolbar" role="alert">
    <span>{result.error}</span><button type="button" className="btn small" disabled={disabled} onClick={() => { setResult(undefined); setRetry(retry + 1); }}>重试</button>
  </div>;
  const review = result?.review;
  if (!review || (!review.candidates.length && !review.confirmed.length && !review.limited)) return null;
  const locked = disabled || readOnly || result.key !== key;
  const candidateGroups = new Map<string, SplitChargeReview["candidates"]>();
  for (const match of review.candidates) {
    const group = candidateGroups.get(match.original.id) ?? [];
    group.push(match);
    candidateGroups.set(match.original.id, group);
  }
  const title = review.candidates.length && review.candidates.every((match) => match.refund)
    ? "疑似全额冲回后拆单扣款" : "拆单金额匹配";
  return <details id="split-charge-review" className="split-charge-review" aria-busy={result.key !== key}>
    <summary>{review.candidates.length ? `${title}（${review.candidates.length} 个候选）` : "拆单扣款匹配"}
      {review.confirmed.length > 0 && <small>已确认 {review.confirmed.length} 组</small>}
    </summary>
    {review.limited && <p className="muted">候选较多，当前显示部分组合。</p>}
    {review.confirmed.map((match) => <details className="split-charge-group" key={match.id}>
      <summary>已确认 · {match.original.date} · {amountText(match.original.amount)} {match.currency} · {match.fundingAccount}</summary>
      <MatchDetails match={match} />
      <div className="toolbar">
        {match.original.posted && <small>原扣款已入账，退款继续审批。</small>}
        {match.offsetsExcluded && <small>相抵两笔已排除</small>}
        {!readOnly && match.refund && !match.original.posted && !match.offsetsExcluded && !match.canExcludeOffsets && <small>请逐笔核对相抵流水。</small>}
        {!readOnly && match.canExcludeOffsets && <button type="button" className="btn small" disabled={locked}
          onClick={() => onAction(match.id, "exclude")}>排除相抵两笔</button>}
        {!readOnly && <button type="button" className="btn small quiet" disabled={locked} onClick={() => onAction(match.id, "clear")}>取消匹配</button>}
      </div>
    </details>)}
    {[...candidateGroups.values()].map((group) => {
      const { original, currency, fundingAccount } = group[0];
      return <details className="split-charge-group" key={original.id}>
        <summary>{group[0].refund ? "原扣款" : "合计候选"} · {original.date} · {amountText(original.amount)} {currency} · {fundingAccount}
          {group.length > 1 && <small>{group.length} 个候选</small>}
        </summary>
        {group.map((match, index) => <article className="split-charge-candidate" key={match.id}>
          {(group.length > 1 || match.overlaps) && <h3>{group.length > 1 ? `候选 ${index + 1}` : "候选匹配"}
            {match.overlaps && <small>与其他候选共用流水</small>}
          </h3>}
          <MatchDetails match={match} />
          <button type="button" className="btn small" disabled={locked} onClick={() => onAction(match.id, "confirm")}>确认这组匹配</button>
        </article>)}
      </details>;
    })}
  </details>;
}
