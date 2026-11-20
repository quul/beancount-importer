import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ParsedTx } from "../../src/shared/types.js";
import { api, ApiError, type PdfPreview } from "./api";

export default function PdfPreviewDialog({ batchId, tx, onClose }: {
  batchId: string;
  tx: ParsedTx;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [preview, setPreview] = useState<PdfPreview>();
  const [error, setError] = useState("");

  useLayoutEffect(() => {
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void api.pdfPreview(batchId, tx.id, controller.signal).then((value) => {
      if (!controller.signal.aborted) setPreview(value);
    }).catch((failure: unknown) => {
      if (!controller.signal.aborted) setError(failure instanceof ApiError ? failure.message : "暂时无法显示 PDF 原文截图。请重试。");
    });
    return () => controller.abort();
  }, [batchId, tx.id]);

  return <dialog ref={dialog} className="pdf-preview-dialog" aria-labelledby="pdf-preview-title" onClose={onClose}
    onClick={(event) => { if (event.target === dialog.current) dialog.current.close(); }}>
    <div className="toolbar pdf-preview-header">
      <div>
        <h2 id="pdf-preview-title">PDF 原文</h2>
        <p className="pdf-preview-file" title={preview?.file ?? tx.sourceFile}>{preview?.file ?? tx.sourceFile}</p>
      </div>
      <form method="dialog"><button className="btn" autoFocus>关闭</button></form>
    </div>
    <div className="pdf-preview-content">
      {error ? <p className="error-line" role="alert">{error}</p> : preview
        ? preview.screenshots.map(({ page, image }, index) => <figure key={page}>
          <figcaption>第 {page} 页{index > 0 ? " · 续行" : ""}</figcaption>
          <img src={image} alt={`第 ${page} 页的${tx.payee || "该笔交易"}${index > 0 ? "描述续行" : "原文截图"}`} />
        </figure>)
        : <p className="muted" role="status">正在读取 PDF 原文…</p>}
    </div>
  </dialog>;
}
