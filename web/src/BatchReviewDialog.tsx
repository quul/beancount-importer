import { useId, useLayoutEffect, useRef, useState } from "react";
import type { StatementName, StatementSource } from "../../src/shared/types.js";
import type { BatchSummary } from "./api";

export default function BatchReviewDialog({ batches, sources, busy, error, onClose, onConfirm }: {
  batches?: BatchSummary[];
  sources: StatementSource[];
  busy: boolean;
  error: string;
  onClose: () => void;
  onConfirm: (keepProgress: string[], names: StatementName[]) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const headingId = useId();
  const [keep, setKeep] = useState(() => new Set(batches?.map(({ batchId }) => batchId)));
  const [names, setNames] = useState(() => new Map(sources.map(({ id, name }) => [id, name])));
  useLayoutEffect(() => {
    if (!dialog.current?.open) dialog.current?.showModal();
  }, []);

  return <dialog ref={dialog} className="merge-dialog batch-review-dialog" aria-labelledby={headingId}
    onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <form onSubmit={(event) => {
      event.preventDefault();
      if (!busy) onConfirm([...keep], sources.map(({ id }) => ({ id, name: names.get(id) ?? "" })));
    }}>
      <h2 id={headingId}>{batches ? "合并审批" : "账单显示名"}</h2>
      <div className="batch-review-dialog-fields">
        {batches && <fieldset disabled={busy}>
          <legend>保留审批进度</legend>
          {batches.map(({ batchId, file, txCount }) => <label className="check-label batch-keep" key={batchId}>
            <input type="checkbox" checked={keep.has(batchId)} onChange={(event) => {
              const next = new Set(keep);
              if (event.target.checked) next.add(batchId);
              else next.delete(batchId);
              setKeep(next);
            }} />
            <span title={file}>{file}</span><small>{txCount} 笔</small>
          </label>)}
        </fieldset>}
        <fieldset disabled={busy}>
          {batches && <legend>账单显示名</legend>}
          {sources.map(({ id, file }) => <label className="batch-statement-name" key={id}>
            <small title={file}>{file}</small>
            <input type="text" aria-label={"显示名 · " + file} maxLength={500} value={names.get(id) ?? ""}
              onChange={(event) => setNames(new Map(names).set(id, event.target.value))} />
          </label>)}
        </fieldset>
      </div>
      {batches && <p className="batch-merge-warning">原批次将归档为只读。合并不可撤销。</p>}
      {error && <p className="error-line" role="alert">{error}</p>}
      <div className="toolbar batch-review-dialog-actions">
        <button type="button" className="btn" disabled={busy} onClick={onClose}>取消</button>
        <button type="submit" className="btn primary" disabled={busy}>{batches ? "合并并进入审批" : "保存显示名"}</button>
      </div>
    </form>
  </dialog>;
}
