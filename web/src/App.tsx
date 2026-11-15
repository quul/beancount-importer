import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { AppConfig, ImportPreview, LedgerMatch, ParsedTx, TxDecision, TxStatus } from "../../src/shared/types.js";
import { api, ApiError, type BatchSummary, type GeneratedPreview, type LedgerSummary } from "./api";
import ReviewEditor, { AccountSelect, draftDecision, invalidTags, makeDraft, parseTags, type ReviewDraft } from "./ReviewEditor";
import ConfigPanel from "./ConfigPanel";

const STATUS_TABS: Array<{ key: "all" | TxStatus; label: string }> = [
  { key: "all", label: "全部" }, { key: "pending", label: "待确认" }, { key: "ready", label: "入账" }, { key: "duplicate", label: "重复" }, { key: "excluded", label: "排除" },
];
const PAGE_SIZE = 50;
const fmt = (amount: number) => amount.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function HistoryMatch({ match, disabled, onApply, onAdopt, onExclude, counterpart, hasPostings }: {
  match: LedgerMatch; disabled: boolean; onApply: (account: string) => void;
  onAdopt: () => void; onExclude: () => void; counterpart?: ParsedTx; hasPostings: boolean;
}) {
  const category = match.postings.find((posting) => /^(Expenses|Income):/.test(posting.account))?.account;
  const transfer = match.reason.startsWith("转账配对建议");
  return <article className="history-match">
    <div className="toolbar"><b>{match.date} · {match.payee || "（无商户）"}</b>{category && <button className="btn small" disabled={disabled || hasPostings} onClick={() => onApply(category)}>沿用分类</button>}</div>
    <div>{match.narration}</div><p className="reason">匹配依据：{match.reason}</p>
    <div className="history-postings">{match.postings.map((posting, index) => <div key={index}><code>{posting.account}</code><span>{fmt(posting.amount)} {posting.currency}</span></div>)}</div>
    {transfer && <><p className="reason">采用分录会保留当前流水；请另行核对并排除对应流水，避免同笔转账入账两次。</p><div className="toolbar"><button className="btn primary small" disabled={disabled} onClick={onAdopt}>采用双腿分录</button>{counterpart && <button className="btn small" disabled={disabled || counterpart.status === "excluded"} onClick={onExclude}>{counterpart.status === "excluded" ? "对应流水已排除" : "排除对应流水"}</button>}</div></>}
    <div className="source-details">{match.file ? `${match.file}${match.line ? `:${match.line}` : ""}` : "历史账本"}<br />ID：{match.id}</div>
  </article>;
}

export default function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [ledger, setLedger] = useState<LedgerSummary | null>(null);
  const [batches, setBatches] = useState<BatchSummary[]>([]);
  const [batch, setBatch] = useState<ImportPreview | null>(null);
  const [batchId, setBatchId] = useState("");
  const [preview, setPreview] = useState<GeneratedPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [filter, setFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | TxStatus>("all");
  const [sort, setSort] = useState<"date" | "amount" | "payee">("date");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [drafts, setDrafts] = useState<Record<string, ReviewDraft>>({});
  const [bulkTags, setBulkTags] = useState("");
  const [bulkScope, setBulkScope] = useState<"selected" | "filtered">("selected");
  const [page, setPage] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const [help, setHelp] = useState(false);
  const [validation, setValidation] = useState("");
  const [favaMessage, setFavaMessage] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const locked = useRef(false);
  const batchRef = useRef<ImportPreview | null>(null);
  const batchIdRef = useRef("");

  const replaceBatch = (value: ImportPreview | null, id = batchIdRef.current) => {
    batchRef.current = value;
    batchIdRef.current = id;
    setBatch(value);
    setBatchId(id);
  };

  const invalidate = () => { setPreview(null); setValidation(""); };

  const handleError = async (failure: unknown) => {
    const message = failure instanceof Error ? failure.message : String(failure);
    if (failure instanceof ApiError && failure.status === 409) {
      invalidate();
      if (batchIdRef.current) {
        try { replaceBatch(await api.batch(batchIdRef.current)); } catch { /* keep the conflict visible */ }
      }
      setError(`批次已发生变化，已尝试重新载入。请核对当前结果后重新生成。${message}`);
    } else setError(message);
  };

  const perform = async (work: () => Promise<void>) => {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    try { await work(); } catch (failure) { await handleError(failure); }
    finally { locked.current = false; setBusy(false); }
  };

  useEffect(() => {
    void perform(async () => {
      const results = await Promise.allSettled([api.config(), api.ledger(), api.batches()]);
      if (results[0].status === "fulfilled") setConfig(results[0].value);
      if (results[1].status === "fulfilled") setLedger(results[1].value);
      if (results[2].status === "fulfilled") setBatches(results[2].value);
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failures.length) throw new Error(failures.map((result) => String(result.reason)).join("；"));
    });
  }, []);

  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      const tag = document.activeElement?.tagName;
      if (event.key === "/" && !["INPUT", "TEXTAREA", "SELECT"].includes(tag ?? "")) { event.preventDefault(); searchInput.current?.focus(); }
      if (event.key === "Escape" && document.activeElement === searchInput.current) setFilter("");
    };
    window.addEventListener("keydown", keyboard);
    return () => window.removeEventListener("keydown", keyboard);
  }, []);

  useEffect(() => { setPage(0); }, [filter, statusFilter, sort, batchId]);

  const txs = batch?.txs ?? [];
  const accounts = ledger?.accounts ?? [];
  const readOnly = Boolean(batch?.committed);
  const editingDisabled = busy || readOnly;
  const dirtyCount = Object.keys(drafts).length;
  const visible = useMemo(() => {
    const query = filter.trim().toLowerCase();
    return txs.filter((tx) => {
      if (statusFilter !== "all" && tx.status !== statusFilter) return false;
      return !query || [tx.payee, tx.note, tx.rawAccount, tx.finalAccount, tx.reviewNote, tx.sourceStatus, tx.sourceTxId, tx.amount.toFixed(2), ...(tx.tags ?? [])].join(" ").toLowerCase().includes(query);
    }).sort((a, b) => sort === "amount" ? a.amount - b.amount : sort === "payee" ? a.payee.localeCompare(b.payee, "zh-CN") : `${a.date} ${a.time ?? ""}`.localeCompare(`${b.date} ${b.time ?? ""}`));
  }, [txs, filter, statusFilter, sort]);
  const totalPages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages - 1);
  const rows = visible.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const count = (status: TxStatus) => txs.filter((tx) => tx.status === status).length;
  const targets = bulkScope === "filtered" ? visible : txs.filter((tx) => selected.has(tx.id));
  const pendingHigh = txs.filter((tx) => tx.status === "pending" && tx.confidence >= 0.9 && (tx.fundingConfidence ?? 1) >= 0.9 && !tx.issues?.length);

  const openBatch = (id: string) => void perform(async () => {
    const value = await api.batch(id);
    replaceBatch(value, id);
    setDrafts({}); setSelected(new Set()); setExpanded(new Set()); setFilter(""); setStatusFilter("all");
    invalidate(); setNotice(value.committed ? "此批次已提交，只读展示。" : "已恢复已保存的审阅结果。");
  });

  const upload = (files: FileList | null) => {
    if (!files?.length || busy) return;
    void perform(async () => {
      const result = await api.upload([...files]);
      replaceBatch(await api.batch(result.batchId), result.batchId);
      setDrafts({}); setSelected(new Set()); setExpanded(new Set()); setFilter(""); setStatusFilter("all");
      invalidate(); setNotice("");
      setBatches(await api.batches());
      if (fileInput.current) fileInput.current.value = "";
    });
  };

  const saveDecisions = async (decisions: TxDecision[], savedDraftIds: string[] = []) => {
    if (!decisions.length || !batchRef.current || batchRef.current.committed) return;
    invalidate();
    await perform(async () => {
      const current = batchRef.current!;
      await api.decide(batchIdRef.current, current.revision ?? 0, decisions);
      replaceBatch(await api.batch(batchIdRef.current));
      setDrafts((previous) => Object.fromEntries(Object.entries(previous).filter(([id]) => !savedDraftIds.includes(id))));
      setNotice(`已保存 ${decisions.length} 笔审阅结果。`);
    });
  };

  const changeDraft = (tx: ParsedTx, draft: ReviewDraft) => { invalidate(); setDrafts((previous) => ({ ...previous, [tx.id]: draft })); };
  const bulkFlag = (flag: "*" | "!") => void saveDecisions(targets.map((tx) => ({ id: tx.id, flag })));
  const applyTags = (mode: "add" | "remove") => {
    const tags = parseTags(bulkTags);
    if (!tags.length || invalidTags(bulkTags).length) return;
    void saveDecisions(targets.map((tx) => ({ id: tx.id, tags: mode === "add" ? [...new Set([...(tx.tags ?? []), ...tags])] : (tx.tags ?? []).filter((tag) => !tags.includes(tag)) })));
  };

  const generate = () => void perform(async () => {
    if (!batchRef.current || batchRef.current.committed || dirtyCount) return;
    const result = await api.generate(batchIdRef.current, batchRef.current.revision ?? 0);
    setPreview(result);
    if (result.errors?.length) setError(result.errors.join("；"));
    else setNotice("预览已生成。写入前会校验当前版本与账本。");
  });

  const commit = () => void perform(async () => {
    if (!preview || preview.revision !== batchRef.current?.revision || batchRef.current.committed || dirtyCount) return;
    const result = await api.commit(batchIdRef.current, preview.revision);
    replaceBatch(await api.batch(batchIdRef.current));
    setBatches(await api.batches());
    setNotice(result.alreadyCommitted ? "此批次此前已经提交。" : `已写入 ${result.written.length} 个文件。`);
  });

  const leaveBatch = () => {
    replaceBatch(null, ""); setDrafts({}); setSelected(new Set()); setExpanded(new Set()); invalidate(); setNotice("");
    void perform(async () => { setBatches(await api.batches()); });
  };

  const saveConfig = async (values: Partial<AppConfig>) => {
    await perform(async () => { setConfig(await api.saveConfig(values)); setLedger(await api.ledger()); invalidate(); setNotice("设置已保存，账户列表已更新。"); });
  };

  return <main className="container">
    <header className="masthead"><div className={`seal${readOnly ? " green" : ""}`}>{readOnly ? "讫" : "记"}</div><div className="masthead-text"><h1>Bean Import <span className="thin">· 账单过账</span></h1><div className="subtitle">保留原始流水，参考真实账本，逐笔审阅后过账</div></div><button className="help-toggle" onClick={() => setHelp(!help)}>使用说明 {help ? "收起" : "展开"}</button></header>
    {help && <div className="help-body"><p>先核对目标账本，再上传解压后的 CSV / XLSX 或银行 PDF。重复交易默认不入账，可查看历史分录后人工解除。</p><p>「选择」用于批量编辑标签与标记；「入账」决定是否生成分录。账本的 * 正常 / ! 待核实与入账状态独立。每笔展开后可记录备注、编辑多条 posting。</p><p>改动会使预览失效。保存编辑并重新生成后才能写入。批次可在重启后恢复；已提交批次只读。</p></div>}
    <div className="ledger-target"><b>当前账本：</b><code>{config ? `${config.ledgerRoot}/${config.mainFile}` : "尚未读取配置"}</code><span>{ledger ? `${ledger.accountCount} 个账户 · ${ledger.txCount} 笔历史交易` : ""}</span></div>
    {error && <div className="card alert" role="alert"><b>操作未完成</b><p>{error}</p><button className="btn small" onClick={() => setError("")}>关闭</button></div>}
    {notice && <div className="notice" role="status">{notice}</div>}
    {ledger?.errors?.length ? <details className="card ledger-errors"><summary>账本校验信息（{ledger.errors.length}）</summary>{ledger.errors.map((item, index) => <p className="error-line" key={index}>{item.file}{item.line ? `:${item.line}` : ""} {item.message}</p>)}</details> : null}
    {config && <ConfigPanel key={`${config.ledgerRoot}|${config.mainFile}`} config={config} accounts={accounts} disabled={busy || Boolean(batch && !readOnly)} onSave={saveConfig} />}

    {!batch && <>
      <section className="card"><div className={`dropzone${dragOver ? " over" : ""}`} role="button" tabIndex={0} aria-label="选择账单文件" onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") fileInput.current?.click(); }} onClick={() => { if (!busy) fileInput.current?.click(); }} onDragOver={(event) => { event.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)} onDrop={(event) => { event.preventDefault(); setDragOver(false); upload(event.dataTransfer.files); }}><div className="dz-glyph">账</div><div className="dz-main">{busy ? "正在读取账单…" : "拖入账单，或点击选择文件"}</div><div className="dz-sub">可同时选择多个 CSV / XLSX / PDF · ZIP 请先解压</div></div><input ref={fileInput} type="file" accept=".csv,.xlsx,.xls,.pdf" multiple hidden disabled={busy} onChange={(event) => upload(event.target.files)} /></section>
      <section className="card"><div className="toolbar"><strong>导入批次</strong><span className="spacer" /><button className="btn small" disabled={busy} onClick={() => void perform(async () => { setBatches(await api.batches()); })}>刷新</button></div>{!batches.length ? <p className="muted">暂无已保存批次。</p> : <div className="batch-list">{batches.map((item) => <button className="batch-item" key={item.batchId} disabled={busy} onClick={() => openBatch(item.batchId)}><span><b>{item.file}</b><small>{new Date(item.createdAt).toLocaleString("zh-CN")} · {item.txCount} 笔</small></span><span className={`badge ${item.committed ? "pair" : "dup"}`}>{item.committed ? "已提交 · 查看" : "继续审阅"}</span></button>)}</div>}</section>
    </>}

    {batch && <>
      <section className="card"><div className="toolbar"><strong className="batch-title">{batch.file}</strong><span className="revision">版本 {batch.revision ?? 0}</span><span className="spacer" /><button className="btn small" disabled={busy || dirtyCount > 0} onClick={() => openBatch(batchId)}>重新载入</button><button className="btn" disabled={busy || dirtyCount > 0} onClick={leaveBatch}>返回批次列表</button></div>
        <div className="stats review-stats">{STATUS_TABS.map(({ key, label }) => <div className={`stat${key === "ready" ? " good" : key === "duplicate" ? " warn" : ""}`} key={key}><div className="num">{key === "all" ? txs.length : count(key)}</div><div className="lbl">{label}</div></div>)}</div>
        <p className="muted">{readOnly ? `已提交${batch.committedAt ? `于 ${batch.committedAt}` : ""}，此批次不能再次写入。` : "重复与源文件中排除的交易默认不入账；核对依据后可人工勾选。"}</p>
        {batch.errors.length > 0 && <details><summary>解析信息（{batch.errors.length}）</summary>{batch.errors.map((item, index) => <p className="error-line" key={index}>第 {item.row} 行：{item.message}</p>)}</details>}
        {batch.ledgerErrors?.length ? <details><summary>载入批次时的账本校验信息（{batch.ledgerErrors.length}）</summary>{batch.ledgerErrors.map((item, index) => <p className="error-line" key={index}>{item.file}{item.line ? `:${item.line}` : ""} {item.message}</p>)}</details> : null}
      </section>

      <section className="card">
        <div className="toolbar"><strong>审阅交易</strong><span className="spacer" />{!readOnly && <><button className="btn" disabled={editingDisabled || dirtyCount > 0 || !pendingHigh.length} onClick={() => void saveDecisions(pendingHigh.map((tx) => ({ id: tx.id, account: tx.suggestedAccount, status: "ready" })))}>接受高置信度（{pendingHigh.length}）</button><button className="btn primary" disabled={busy || dirtyCount > 0 || count("ready") === 0} onClick={generate}>生成预览（{count("ready")}）</button></>}</div>
        {dirtyCount > 0 && <p className="draft-notice">{dirtyCount} 笔有未保存编辑。请展开对应交易保存或放弃，再生成预览。</p>}
        <nav className="tabs" aria-label="交易状态">{STATUS_TABS.map(({ key, label }) => <button className={`tab${statusFilter === key ? " active" : ""}`} key={key} onClick={() => setStatusFilter(key)}>{label}<span className="count">{key === "all" ? txs.length : count(key)}</span></button>)}</nav>
        <div className="filter-row"><input ref={searchInput} value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="搜索商户、金额、标签、账户、备注…" aria-label="搜索交易" /><select aria-label="排序" value={sort} onChange={(event) => setSort(event.target.value as typeof sort)}><option value="date">按日期</option><option value="amount">按金额</option><option value="payee">按商户</option></select><span className="muted">筛选到 {visible.length} 笔 · 已选择 {selected.size} 笔</span></div>
        {!readOnly && <div className="bulk-bar"><select aria-label="批量编辑范围" value={bulkScope} onChange={(event) => setBulkScope(event.target.value as typeof bulkScope)}><option value="selected">已选择（{selected.size}）</option><option value="filtered">当前筛选全部（{visible.length}）</option></select><input value={bulkTags} onChange={(event) => setBulkTags(event.target.value)} placeholder="标签，以空格分隔" aria-label="批量标签" /><button className="btn small" disabled={busy || dirtyCount > 0 || !targets.length || !parseTags(bulkTags).length || invalidTags(bulkTags).length > 0} onClick={() => applyTags("add")}>添加标签</button><button className="btn small" disabled={busy || dirtyCount > 0 || !targets.length || !parseTags(bulkTags).length || invalidTags(bulkTags).length > 0} onClick={() => applyTags("remove")}>移除标签</button><button className="btn small" disabled={busy || dirtyCount > 0 || !targets.length} onClick={() => bulkFlag("!")}>标记 ! 待核实</button><button className="btn small" disabled={busy || dirtyCount > 0 || !targets.length} onClick={() => bulkFlag("*")}>标记 * 正常</button><p className={"bulk-tag-hint" + (invalidTags(bulkTags).length ? " error-line" : " muted")}>{invalidTags(bulkTags).length ? `标签格式无效：${invalidTags(bulkTags).join("、")}` : "标签用英文字母、数字及 _ . / -；中文写在审阅备注中。"}</p></div>}

        {!rows.length ? <div className="empty">没有符合筛选的交易。</div> : <div className="table-scroll"><table className="tx"><thead><tr><th><input type="checkbox" className="checkbox" aria-label="选择当前筛选全部交易" checked={visible.length > 0 && visible.every((tx) => selected.has(tx.id))} onChange={(event) => { const checked = event.target.checked; setSelected((previous) => { const next = new Set(previous); for (const tx of visible) checked ? next.add(tx.id) : next.delete(tx.id); return next; }); }} /></th><th>入账</th><th>日期 / 商户</th><th>金额</th><th>分类 / 资金账户</th><th>标签 / 标记 / 依据</th></tr></thead><tbody>{rows.map((tx) => <Fragment key={tx.id}><tr className={`${tx.status === "duplicate" ? "dup-row" : ""} ${tx.status === "excluded" ? "excluded-row" : ""}`}>
          <td><input type="checkbox" className="checkbox" aria-label={`选择 ${tx.payee}`} checked={selected.has(tx.id)} onChange={(event) => { const checked = event.target.checked; setSelected((previous) => { const next = new Set(previous); checked ? next.add(tx.id) : next.delete(tx.id); return next; }); }} /></td>
          <td><input type="checkbox" className="checkbox" aria-label={`${tx.payee} 是否入账`} disabled={editingDisabled || Boolean(drafts[tx.id])} checked={tx.status === "ready"} onChange={(event) => void saveDecisions([{ id: tx.id, status: event.target.checked ? "ready" : "excluded" }])} /><span className="status-label">{STATUS_TABS.find((item) => item.key === tx.status)?.label}</span>{tx.status === "ready" && tx.duplicateOf && <span className="reason">人工解除重复</span>}</td>
          <td><div className="tx-date">{tx.date} <span className="time">{tx.time}</span></div><div className="payee">{tx.payee || "（无商户）"}</div><div className="tx-note">{tx.note}</div>{tx.sourceStatus && <div className="source-status">源状态：{tx.sourceStatus}</div>}{tx.excludedReason && <div className="error-line">{tx.excludedReason}</div>}{tx.duplicateOf && <div className="duplicate-reason"><span className="badge dup">重复依据</span> {tx.duplicateOf.label}<small>{tx.duplicateOf.where} · {tx.duplicateOf.id}</small></div>}{tx.issues?.map((issue, index) => <div className="error-line" key={index}>{issue}</div>)}<button className="detail-toggle" onClick={() => setExpanded((previous) => { const next = new Set(previous); next.has(tx.id) ? next.delete(tx.id) : next.add(tx.id); return next; })}>{expanded.has(tx.id) ? "收起" : `标签 / 拆分 / 历史参考（${tx.matches?.length ?? 0}）`}{drafts[tx.id] ? " · 未保存" : ""}</button></td>
          <td className={`amt ${tx.direction}`}><span className="dir">{tx.direction === "in" ? "收" : "支"}</span>{fmt(tx.amount)}<small>{tx.currency}</small>{tx.eventType && <span className="badge">{{ expense: "支出", income: "收入", refund: "退款", transfer: "转账", unknown: "待识别" }[tx.eventType]}</span>}</td>
          <td><label className="sr-only" htmlFor={`category-${tx.id}`}>分类账户</label><AccountSelect value={tx.finalAccount || tx.suggestedAccount} accounts={accounts} label={`${tx.payee} 分类账户`} disabled={editingDisabled || Boolean(tx.postings) || Boolean(drafts[tx.id])} onChange={(account) => void saveDecisions([{ id: tx.id, account, status: tx.status === "pending" ? "ready" : tx.status }])} /><div className="account-caption">资金账户{tx.fundingConfidence !== undefined ? ` · ${Math.round(tx.fundingConfidence * 100)}%` : ""}</div><AccountSelect value={tx.fundingAccount} accounts={accounts} funding label={`${tx.payee} 资金账户`} disabled={editingDisabled || Boolean(tx.postings) || Boolean(drafts[tx.id])} onChange={(funding) => void saveDecisions([{ id: tx.id, funding }])} />{tx.postings && <div className="reason">已使用手动多条 posting（{tx.postings.length} 条）</div>}{tx.fundingAccount2 && <div className="reason">转入：{tx.fundingAccount2}</div>}</td>
          <td><div className="tag-list">{tx.tags?.map((tag) => <button className="tag-chip" key={tag} onClick={() => setFilter(tag)}>#{tag}</button>)}</div><select aria-label={`${tx.payee} 账本标记`} className="flag-select" value={tx.flag ?? "*"} disabled={editingDisabled || Boolean(drafts[tx.id])} onChange={(event) => void saveDecisions([{ id: tx.id, flag: event.target.value as "*" | "!" }])}><option value="*">* 正常</option><option value="!">! 待核实</option></select><div className="reason">分类置信度 {Math.round(tx.confidence * 100)}%<br />{tx.reason}</div>{tx.reviewNote && <p className="tx-note">审阅：{tx.reviewNote}</p>}</td>
        </tr>{expanded.has(tx.id) && <tr className="expanded-row"><td colSpan={6}><div className="expanded-grid"><ReviewEditor tx={tx} draft={drafts[tx.id] ?? makeDraft(tx)} dirty={Boolean(drafts[tx.id])} accounts={accounts} disabled={editingDisabled} onChange={(draft) => changeDraft(tx, draft)} onSave={() => void saveDecisions([draftDecision(tx, drafts[tx.id]!)], [tx.id])} onDiscard={() => setDrafts((previous) => Object.fromEntries(Object.entries(previous).filter(([id]) => id !== tx.id)))} /><section className="history-panel"><h3>历史账本参考（{tx.matches?.length ?? 0}）</h3>{!tx.matches?.length ? <p className="muted">未找到可参考的历史交易。</p> : tx.matches.map((match) => <HistoryMatch key={match.id} match={match} disabled={editingDisabled || Boolean(drafts[tx.id])} hasPostings={Boolean(tx.postings)} onApply={(account) => void saveDecisions([{ id: tx.id, account, status: tx.status === "pending" ? "ready" : tx.status }])} counterpart={txs.find((other) => other.id === match.id)} onAdopt={() => void saveDecisions([{ id: tx.id, postings: match.postings, status: "ready" }])} onExclude={() => void saveDecisions([{ id: match.id, status: "excluded" }])} />)}</section></div></td></tr>}</Fragment>)}</tbody></table></div>}
        <div className="toolbar pagination"><button className="btn small" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>上一页</button><span>第 {currentPage + 1} / {totalPages} 页，每页 {PAGE_SIZE} 笔</span><button className="btn small" disabled={currentPage >= totalPages - 1} onClick={() => setPage(currentPage + 1)}>下一页</button><span className="spacer" /><button className="btn small" disabled={!selected.size} onClick={() => setSelected(new Set())}>清空选择</button></div>
      </section>

      {preview && <section className="card"><div className="toolbar"><strong>分录预览 · 版本 {preview.revision}</strong><span>共 {preview.generated} 笔</span><span className="spacer" />{!readOnly && <button className="btn primary" disabled={busy || dirtyCount > 0 || Boolean(preview.errors?.length) || preview.revision !== batch.revision} onClick={commit}>校验并写入账本</button>}</div><p className="muted">{Object.keys(preview.monthFiles).join(" · ")}</p>{preview.opens.length > 0 && <p className="error-line">账户指令建议：{preview.opens.join("；")}</p>}{preview.errors?.map((message, index) => <p role="alert" className="error-line" key={index}>{message}</p>)}<pre className="code">{preview.entries}</pre></section>}
      {readOnly && <section className="card done-banner"><div className="seal green">讫</div><div className="msg"><div className="big">此批次已过账</div><div className="sub">{batch.written?.join(" · ")}</div></div></section>}
      <section className="card"><div className="toolbar"><button className="btn" disabled={busy} onClick={() => void perform(async () => { const result = await api.validate(); setValidation(`${result.ok ? "校验通过" : "校验未通过"}\n${result.output}`); })}>校验当前账本</button><button className="btn" disabled={busy} onClick={() => void perform(async () => { const result = await api.fava(); setFavaMessage(result.running ? `http://localhost:${result.port}` : result.error ?? "Fava 启动失败"); })}>打开 Fava 报表</button></div>{validation && <pre className="code">{validation}</pre>}{favaMessage && <p>{favaMessage.startsWith("http") ? <a href={favaMessage} target="_blank" rel="noreferrer">在新窗口查看 Fava</a> : favaMessage}</p>}</section>
    </>}
  </main>;
}
