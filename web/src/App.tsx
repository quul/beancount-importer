import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import type { AppConfig, EventType, FundingMappingChoice, FundingMappingGroup, ImportPreview, LedgerMatch, ParsedTx, ReviewProblem, StatementName, TxDecision, TxStatus } from "../../src/shared/types.js";
import { isClosedAlipayPurchase } from "../../src/shared/alipay.js";
import {
  canExcludeSuspectedDuplicate, canFollowPurchaseRefund, CROSS_SOURCE_ISSUE, defaultNarration, hasPdfSource, isSuspectedDuplicate,
  LEDGER_DUPLICATE_ISSUE, MAX_NARRATION_LENGTH, PDF_REVIEW_ISSUE,
} from "../../src/shared/types.js";
import { savedCategoryAllocations } from "../../src/shared/categoryAllocations.js";
import { amountText, missingPostingAccount, missingPostingAccountMessage } from "../../src/shared/postings.js";
import { accountIsActive, hasFundingPosting, isCombinedPayment, isFundingAccount, reusablePaymentMethod } from "../../src/shared/funding.js";
import { activeTransactions } from "../../src/shared/transactionMerge.js";
import { api, ApiError, IncompleteReviewError, type BatchMergeOptions, type BatchSummary, type ConfigResponse, type GeneratedPreview, type LedgerSummary, type MergeDraft } from "./api";
import { draftDecision, draftPostings, invalidTags, makeDraft, parseTags, ReviewMetadataFields, ReviewPostingFields, shakeInvalidFields, TransactionSourceDetails, validatePostingDraft, type ReviewDraft } from "./ReviewEditor";
import AccountSelect from "./AccountSelect";
import BatchReviewDialog from "./BatchReviewDialog";
import BeancountCode from "./BeancountCode";
import ConfigPanel, { SETTINGS_LINKS, type SettingsSection } from "./ConfigPanel";
import DateRangeFilter from "./DateRangeFilter";
import EntryPreview from "./EntryPreview";
import FundingDialog from "./FundingDialog";
import MergeDialog from "./MergeDialog";
import PdfPreviewDialog from "./PdfPreviewDialog";
import ReviewMenu from "./ReviewMenu";
import ReviewConflictPanel from "./ReviewConflictPanel";
import StatementSources from "./StatementSources";
import TransactionFlag from "./TransactionFlag";
import { applyPendingReviewPatches, reviewPatches, type ReviewPatches } from "./reviewChanges";
import {
  buildBulkCategoryPlan, buildBulkPostingPlan, buildReviewRows, EMPTY_REVIEW_DATE_RANGE, isEditablePostingStatus, matchesReviewDateRange,
  matchesReviewFilter, matchesReviewSearch, refundFollowsCategory, remainingReviewProblems, type ReviewFilter, type ReviewRow, type ReviewTarget,
} from "./reviewRows";

const STATUS_TABS: Array<{ key: ReviewFilter; label: string }> = [
  { key: "all", label: "全部" }, { key: "pending", label: "待确认" }, { key: "ready", label: "待入账" }, { key: "duplicate", label: "重复" },
  { key: "suspectedDuplicate", label: LEDGER_DUPLICATE_ISSUE }, { key: "excluded", label: "排除" },
];

function settingsRoute(): SettingsSection | null {
  if (window.location.hash === SETTINGS_LINKS.funding) return "funding";
  return window.location.hash === SETTINGS_LINKS.ledger ? "ledger" : null;
}

const batchIdFromUrl = () => new URLSearchParams(window.location.search).get("batch") ?? "";

function batchUrl(id: string, hash = window.location.hash): string {
  const url = new URL(window.location.href);
  if (id) url.searchParams.set("batch", id);
  else url.searchParams.delete("batch");
  url.hash = hash;
  return `${url.pathname}${url.search}${url.hash}`;
}

const DECISION_LABELS: Record<TxStatus, string> = { pending: "待确认", ready: "待入账", duplicate: "重复", excluded: "已排除" };
const operationMessage = (failure: unknown) => failure instanceof ApiError ? failure.message : "暂时无法完成操作。请重试。";
const EVENT_LABELS: Record<EventType, string> = { expense: "支出", income: "收入", refund: "退款", transfer: "转账", familyCard: "亲情卡", unknown: "待识别" };
const PAGE_SIZE = 50;
const DETAIL_DRAWER_QUERY = "(max-width: 1360px)";
const FUNDING_ALLOCATION_ISSUE = "组合支付，分摊待确认";
const COMBINED_PAYMENT_ISSUE = "组合支付，核对分录";
const DIRECTION_REVIEW_ISSUE = "收支待确认";
const legacyDirectionIssue = /^(不计收支流水|交易收支方向不明确|按金额正负推断方向)/;
const fmt = (amount: number) => amount.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const batchTime = (createdAt: number) => new Date(createdAt).toLocaleString("zh-CN");
const postingStatusLabel = (tx: ParsedTx, readOnly: boolean) => readOnly && tx.status === "ready" ? "已入账" : DECISION_LABELS[tx.status];
const categoryInputId = (id: string, detail = false) => `${detail ? "detail" : "row"}-category-${id}`;
const fundingInputId = (id: string, detail = false) => `${detail ? "detail" : "row"}-funding-${id}`;
type CategoryAdvance = { rowIds: ReadonlySet<string>; origin: Element | null };
type TransactionDraft = { value: ReviewDraft; original: ReviewDraft };
type DeleteTarget = Pick<BatchSummary, "batchId" | "file" | "revision"> & { createdAt?: number };
type ReviewOpening = "import" | "resume" | "reload";
type FundingTarget = { id: string; batch: ImportPreview; opening: ReviewOpening; groups: FundingMappingGroup[] };
type PreviewCheck = { message: string; problems: ReviewProblem[] };

const reviewIcons = {
  info: <><circle cx="10" cy="10" r="7.6" /><path d="M10 9.5v4" /><circle cx="10" cy="6.8" r=".9" fill="currentColor" stroke="none" /></>,
  check: <path d="M2.8 10.5 7.6 16.5 17.2 3.5" />,
  cross: <path d="M3.2 3.2 16.8 16.8M16.8 3.2 3.2 16.8" />,
  question: <>
    <circle cx="10" cy="10" r="8.6" fill="currentColor" stroke="none" />
    <path d="M7.6 7.6a2.5 2.5 0 1 1 3.9 2.1c-1 .7-1.5.9-1.5 2" stroke="var(--surface)" />
    <circle cx="10" cy="14.4" r=".95" fill="var(--surface)" stroke="none" />
  </>,
  settings: <>
    <path d="M8.3 2.5h3.4l.4 2 1.5.87 1.95-.67 1.7 2.94-1.55 1.33v1.74l1.55 1.33-1.7 2.94-1.95-.67-1.5.87-.4 2H8.3l-.4-2-1.5-.87-1.95.67-1.7-2.94 1.55-1.33V8.97L2.75 7.64l1.7-2.94 1.95.67 1.5-.87z" />
    <circle cx="10" cy="9.84" r="2.55" />
  </>,
};

function ReviewIcon({ name }: { name: keyof typeof reviewIcons }) {
  return <svg aria-hidden="true" viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{reviewIcons[name]}</svg>;
}

function pendingCategory(row: ReviewRow) {
  const canClassify = (tx: ParsedTx) => tx.status === "pending" && !tx.postings && !tx.excludedReason && !tx.reviewConflictId;
  if (canClassify(row.tx) && !row.refund?.postings) return { id: row.tx.id, detail: false };
  const entry = row.refund && row.entries.find(canClassify);
  return entry ? { id: entry.id, detail: true } : undefined;
}

function fundingMatchReason(tx: ParsedTx): string | undefined {
  if (tx.fundingConfidence === undefined) return !tx.fundingAccount && !tx.postings && !tx.merge && !tx.excludedReason ? "资金账户尚未匹配" : undefined;
  if (tx.fundingConfidence >= 1) return undefined;
  if (tx.fundingReason) return tx.fundingReason;
  if (!tx.fundingAccount) return "资金账户尚未匹配";
  const raw = tx.recognition?.fundingMethod || tx.rawAccount;
  return raw ? `此前根据账单付款方式「${raw}」自动匹配` : "此前自动匹配";
}

const oldIssueLabels: Array<[RegExp, string]> = [
  [/^资金转移，请确认双方账户/, "转账"],
  [/未绑定账本账户/, "账户未映射"],
  [/^支付方式对应 \d+ 个账户/, "账户映射冲突"],
  [/^账单未注明支付方式/, "支付方式缺失"],
  [/^组合付款含优惠/, FUNDING_ALLOCATION_ISSUE],
  [/^(组合支付，请|混合支付，请)/, COMBINED_PAYMENT_ISSUE],
  [/亲[情属]卡.*(对方|资金出自)/, "对方付款"],
  [legacyDirectionIssue, DIRECTION_REVIEW_ISSUE],
  [/^退款应冲回/, "冲回原费用"],
  [/^原(消费|交易)已退款/, "已退款，核对退款流水"],
  [/^可能和账本中的/, LEDGER_DUPLICATE_ISSUE],
  [/^不同来源的流水可能是/, CROSS_SOURCE_ISSUE],
  [/^这可能是同一笔转账的两条流水/, "疑似转账配对"],
  [/^这笔交易已在另一个未提交批次中/, "另一个未提交批次已有此交易"],
  [/^通用PDF解析结果/, PDF_REVIEW_ISSUE],
];

function reviewIssues(tx: ParsedTx): string[] {
  const issues = new Set(tx.issues?.map((issue) => oldIssueLabels.find(([pattern]) => pattern.test(issue))?.[1] ?? issue));
  if (issues.has(FUNDING_ALLOCATION_ISSUE) || issues.has(COMBINED_PAYMENT_ISSUE)) issues.delete("组合支付");
  if (tx.eventType === "transfer" || tx.fundingAccount || tx.postings?.length) {
    for (const issue of ["账户未映射", "账户映射冲突", "支付方式缺失"]) issues.delete(issue);
  }
  if (tx.eventType === "transfer") issues.delete("转账");
  return [...issues];
}

function combinedPaymentIssue(tx: ParsedTx): string | undefined {
  const issues = reviewIssues(tx);
  if (issues.includes(FUNDING_ALLOCATION_ISSUE) || tx.fundingParts?.some(({ amount }) => amount == null)) return FUNDING_ALLOCATION_ISSUE;
  if (isCombinedPayment(tx) || issues.includes(COMBINED_PAYMENT_ISSUE) || issues.includes("组合支付")) return COMBINED_PAYMENT_ISSUE;
}

function directionReviewReason(tx: ParsedTx): string | undefined {
  const issue = tx.issues?.find((item) => item === DIRECTION_REVIEW_ISSUE || legacyDirectionIssue.test(item));
  if (!issue) return;
  if (issue !== DIRECTION_REVIEW_ISSUE) return issue;
  const direction = tx.originalDirection?.trim();
  if (direction && !/^[\/—-]+$/.test(direction)) return `账单的收支字段标为「${direction}」。请核对实际收支方向。`;
  if (tx.source.startsWith("bank-")) return "账单缺少明确的收支列，当前方向按金额正负推断。";
  return `账单未提供明确的收支方向，列表暂按${tx.direction === "in" ? "收入" : "支出"}显示。`;
}

function batchDisplayName(batch: ImportPreview): string {
  const range = batch.source === "wechat" && /^微信支付账单流水文件\s*[(（](\d{8})\s*[-–至]\s*(\d{8})[)）]/.exec(batch.file);
  if (!range) return batch.file;
  const date = (value: string) => `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  return `微信支付账单 · ${date(range[1])} 至 ${date(range[2])}`;
}

function HeaderDetails({ config, ledger, batch }: { config: ConfigResponse | null; ledger: LedgerSummary | null; batch: ImportPreview | null }) {
  const disclosure = useRef<HTMLDetailsElement>(null);
  const ledgerPath = config?.ledgerRoot ? `${config.ledgerRoot}/${config.mainFile}` : config ? "未选择账本目录" : "尚未读取配置";
  const ledgerName = config?.ledgerRoot.split(/[/\\]/).filter(Boolean).at(-1) ?? ledgerPath;

  useEffect(() => {
    const dismiss = (event: Event) => {
      const details = disclosure.current;
      if (details?.open && event.target instanceof Node && !details.contains(event.target)) details.open = false;
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("focusin", dismiss);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("focusin", dismiss);
    };
  }, []);

  return <details className="header-details" ref={disclosure} onKeyDown={(event) => {
    if (event.key !== "Escape" || !event.currentTarget.open) return;
    event.preventDefault();
    event.currentTarget.open = false;
    event.currentTarget.querySelector("summary")?.focus();
  }}>
    <summary title="查看完整信息">
      <span className="context-ledger"><span>账本</span><strong>{ledgerName}</strong></span>
      {batch && <span className="context-batch">{batchDisplayName(batch)}</span>}
    </summary>
    <dl className="header-details-panel">
      <div><dt>当前账本</dt><dd><code>{ledgerPath}</code></dd></div>
      {config?.ledgerRoot && ledger && <div><dt>账本统计</dt><dd>{ledger.accountCount} 个账户 · {ledger.txCount} 笔历史交易</dd></div>}
      {batch && <div><dt>原始文件名</dt><dd>{batch.file}</dd></div>}
    </dl>
  </details>;
}

function duplicateEvidence(tx: ParsedTx): LedgerMatch | undefined {
  return isSuspectedDuplicate(tx) ? tx.matches?.find(({ reason }) => !/^(历史分类参考|转账配对建议|未提交批次已有此交易)/.test(reason)) : undefined;
}

function FundingAllocationDetails({ tx, issue, leg, readOnly }: { tx: ParsedTx; issue: string; leg?: string; readOnly: boolean }) {
  const heading = `funding-allocation-${tx.id}`;
  return <section className="detail-review-warning" aria-labelledby={heading}>
    <h4 id={heading}>{leg && `${leg} · `}{issue}</h4>
    <p>{issue === FUNDING_ALLOCATION_ISSUE ? "账单列出了多种支付方式，部分分摊金额无法从账单确定。" : "账单列出了多种支付方式。"}</p>
    {tx.fundingParts?.length ? <dl>
      {tx.fundingParts.map(({ rawAccount, amount }, index) => <div key={index}>
        <dt>{rawAccount}</dt>
        <dd>{amount == null ? "金额待确认" : `${amountText(amount)} ${tx.currency}`}</dd>
      </div>)}
    </dl> : tx.rawAccount && <p>{tx.rawAccount}</p>}
    {tx.fundingAccount && tx.fundingConfidence !== undefined && tx.fundingConfidence < 1 &&
      <p>已预填资金账户 <code>{tx.fundingAccount}</code></p>}
    {!readOnly && !tx.postings && !tx.excludedReason && !tx.reviewConflictId &&
      <p>核对后可在「拆分分录」中录入实际金额。</p>}
  </section>;
}

function HistoryMatch({ match, disabled, onApply, onAdopt, onExclude, counterpart, hasPostings, duplicate }: {
  match: LedgerMatch; disabled: boolean; onApply: (account: string) => void;
  onAdopt: () => void; onExclude: () => void; counterpart?: ParsedTx; hasPostings: boolean;
  duplicate?: { tx: ParsedTx; label: string };
}) {
  const category = match.postings.find((posting) => /^(Expenses|Income):/.test(posting.account))?.account;
  const transfer = match.reason.startsWith("转账配对建议");
  const matchedPayment = duplicate && match.postings.find(({ account, currency }) =>
    account === duplicate.tx.fundingAccount && currency === duplicate.tx.currency);
  const postings = <>
    <div className="history-postings">{match.postings.map((posting, index) => <div key={index}><code>{posting.account}</code><span>{fmt(posting.amount)} {posting.currency}</span></div>)}</div>
    <div className="source-details">{match.file ? `${match.file}${match.line ? `:${match.line}` : ""}` : "历史账本"}<br />ID：{match.id}</div>
  </>;
  return <article className={duplicate ? "history-match duplicate-evidence" : "history-match"}>
    {duplicate && <div className="duplicate-evidence-label">{duplicate.label}</div>}
    <div className="toolbar"><b>{match.date} · {match.payee || "（无商户）"}</b>{category && <button className="btn small" disabled={disabled || hasPostings} onClick={() => onApply(category)}>沿用分类</button>}</div>
    {matchedPayment && <strong className="duplicate-evidence-amount">{fmt(Math.abs(matchedPayment.amount))} {matchedPayment.currency}</strong>}
    {match.narration && match.narration !== match.payee && <div>{match.narration}</div>}<p className="reason">{match.reason}</p>
    {duplicate ? <details><summary>查看对照分录</summary>{postings}</details> : postings}
    {transfer && <><p className="reason">采用后排除另一笔。</p><div className="toolbar"><button className="btn primary small" disabled={disabled} onClick={onAdopt}>采用分录</button>{counterpart && <button className="btn small" disabled={disabled || counterpart.status === "excluded"} onClick={onExclude}>{counterpart.status === "excluded" ? "已排除另一笔" : "排除另一笔"}</button>}</div></>}
  </article>;
}

export default function App() {
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [ledger, setLedger] = useState<LedgerSummary | null>(null);
  const [batches, setBatches] = useState<BatchSummary[]>([]);
  const [selectedBatchIds, setSelectedBatchIds] = useState(new Set<string>());
  const [batchMergeOptions, setBatchMergeOptions] = useState<BatchMergeOptions | null>(null);
  const [renameStatementsOpen, setRenameStatementsOpen] = useState(false);
  const [batchesRefreshing, setBatchesRefreshing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [fundingTarget, setFundingTarget] = useState<FundingTarget | null>(null);
  const [mappingTarget, setMappingTarget] = useState<ParsedTx | null>(null);
  const [batch, setBatch] = useState<ImportPreview | null>(null);
  const [batchId, setBatchId] = useState("");
  const [routedBatchId, setRoutedBatchId] = useState(batchIdFromUrl);
  const [preview, setPreview] = useState<GeneratedPreview | null>(null);
  const [previewCheck, setPreviewCheck] = useState<PreviewCheck | null>(null);
  const [busy, setBusy] = useState(true);
  const [pendingSaves, setPendingSaves] = useState<ReviewPatches[]>([]);
  const [rowFocusedDuringSave, setRowFocusedDuringSave] = useState<string>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [settings, setSettings] = useState(settingsRoute);
  const [filter, setFilter] = useState("");
  const [dateRange, setDateRange] = useState(EMPTY_REVIEW_DATE_RANGE);
  const [statusFilter, setStatusFilter] = useState<ReviewFilter>("pending");
  const [sort, setSort] = useState<"date" | "amount" | "payee">("date");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [detailTxId, setDetailTxId] = useState<string | null>(null);
  const [detailAsDrawer, setDetailAsDrawer] = useState(() => window.matchMedia(DETAIL_DRAWER_QUERY).matches);
  const [reviewFocus, setReviewFocus] = useState<ReviewTarget | null>(null);
  const [categoryAdvance, setCategoryAdvance] = useState<CategoryAdvance | null>(null);
  const [drafts, setDrafts] = useState<Record<string, TransactionDraft>>({});
  const [detailSaveAttempt, setDetailSaveAttempt] = useState<{ id: string }>();
  const [narrationDrafts, setNarrationDrafts] = useState<Record<string, string>>({});
  const [bulkTags, setBulkTags] = useState("");
  const [bulkCategoryAccount, setBulkCategoryAccount] = useState("");
  const [bulkScope, setBulkScope] = useState<"selected" | "filtered">("selected");
  const [mergeIds, setMergeIds] = useState<string[] | null>(null);
  const [pdfPreviewTx, setPdfPreviewTx] = useState<ParsedTx | null>(null);
  const [page, setPage] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const [validation, setValidation] = useState("");
  const [favaMessage, setFavaMessage] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const tableScroll = useRef<HTMLDivElement>(null);
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const detailPanel = useRef<HTMLElement>(null);
  const detailDialog = useRef<HTMLDialogElement>(null);
  const focusDetailHeading = useRef(false);
  const previewHeading = useRef<HTMLHeadingElement>(null);
  const previewRepairButton = useRef<HTMLButtonElement>(null);
  const focusPreviewRepair = useRef(false);
  const deleteDialog = useRef<HTMLDialogElement>(null);
  const locked = useRef(false);
  const batchListRequest = useRef<AbortController | null>(null);
  const decisionQueue = useRef(Promise.resolve());
  const batchRef = useRef<ImportPreview | null>(null);
  const batchIdRef = useRef("");

  const navigateBatch = (id: string, { replace = false, hash = window.location.hash } = {}) => {
    const target = batchUrl(id, hash);
    if (target !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
      if (replace) window.history.replaceState(null, "", target);
      else window.history.pushState(null, "", target);
    }
    setRoutedBatchId(id);
    setSettings(settingsRoute());
  };

  const replaceBatch = (value: ImportPreview | null, id = batchIdRef.current) => {
    const previous = batchRef.current;
    if (value && previous && batchIdRef.current === id && !value.committed) {
      setPreviewCheck((check) => {
        if (!check) return null;
        const problems = remainingReviewProblems(check.problems, previous.txs, value.txs);
        return !problems.length ? null : problems.length === check.problems.length ? check : { ...check, problems };
      });
    } else setPreviewCheck(null);
    batchRef.current = value;
    batchIdRef.current = id;
    setBatch(value);
    setBatchId(id);
  };

  const invalidate = () => { setPreview(null); setValidation(""); };

  const preserveEditingRow = () => {
    const focused = document.activeElement;
    const id = focused?.matches("input, textarea, select") ? focused.closest<HTMLElement>("[data-review-id]")?.dataset.reviewId : undefined;
    if (id) setRowFocusedDuringSave(id);
  };

  const handleError = async (failure: unknown, refreshUncertain = false) => {
    const message = operationMessage(failure);
    const conflict = failure instanceof ApiError && failure.status === 409;
    const uncertain = failure instanceof ApiError && (failure.temporary || failure.status >= 500);
    if (conflict || (refreshUncertain && uncertain)) {
      invalidate();
      const id = batchIdRef.current;
      if (id) {
        try {
          const current = await api.batch(id);
          if (batchIdRef.current === id) {
            preserveEditingRow();
            replaceBatch(current, id);
          }
        } catch { /* Keep the save error visible. */ }
      }
    }
    setError(conflict && batchIdRef.current ? `请检查批次并重新生成预览。\n${message}` : message);
  };

  const perform = async (work: () => Promise<void>) => {
    if (locked.current) return;
    locked.current = true;
    if (batchListRequest.current) {
      batchListRequest.current.abort();
      batchListRequest.current = null;
      setBatchesRefreshing(false);
    }
    setBusy(true);
    setError("");
    try { await work(); } catch (failure) { await handleError(failure); }
    finally { locked.current = false; setBusy(false); }
  };

  const refreshBatchList = async () => {
    if (locked.current || batchListRequest.current) return;
    const request = new AbortController();
    batchListRequest.current = request;
    setBatchesRefreshing(true);
    setError("");
    try {
      const current = await api.batches(request.signal);
      if (!request.signal.aborted) setBatches(current);
    } catch (failure) {
      if (!request.signal.aborted) setError(operationMessage(failure));
    } finally {
      if (batchListRequest.current === request) {
        batchListRequest.current = null;
        setBatchesRefreshing(false);
      }
    }
  };

  useEffect(() => {
    void perform(async () => {
      const results = await Promise.allSettled([api.config(), api.ledger(), api.batches()]);
      if (results[0].status === "fulfilled") setConfig(results[0].value);
      if (results[1].status === "fulfilled") setLedger(results[1].value);
      if (results[2].status === "fulfilled") setBatches(results[2].value);
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failures.length) setError([...new Set(failures.map(({ reason }) => operationMessage(reason)))].join("\n"));
    });
  }, []);

  useEffect(() => {
    const navigate = () => {
      setRoutedBatchId(batchIdFromUrl());
      setSettings(settingsRoute());
    };
    window.addEventListener("hashchange", navigate);
    window.addEventListener("popstate", navigate);
    return () => {
      window.removeEventListener("hashchange", navigate);
      window.removeEventListener("popstate", navigate);
    };
  }, []);

  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      const active = document.activeElement;
      const search = searchInput.current;
      if (!search || event.defaultPrevented || active?.closest("dialog[open]")) return;
      const tag = active?.tagName;
      if (event.key === "/" && !["INPUT", "TEXTAREA", "SELECT"].includes(tag ?? "")) { event.preventDefault(); search.focus(); }
      if (event.key === "Escape" && active === search) setFilter("");
    };
    window.addEventListener("keydown", keyboard);
    return () => window.removeEventListener("keydown", keyboard);
  }, []);

  useEffect(() => {
    const query = window.matchMedia(DETAIL_DRAWER_QUERY);
    const resize = () => setDetailAsDrawer(query.matches);
    query.addEventListener("change", resize);
    return () => query.removeEventListener("change", resize);
  }, []);

  useEffect(() => {
    const dialog = deleteDialog.current;
    if (deleteTarget && dialog && !dialog.open) {
      dialog.returnValue = "";
      dialog.showModal();
    }
  }, [deleteTarget]);

  const txs = useMemo(() => applyPendingReviewPatches(batch?.txs ?? [], pendingSaves), [batch?.txs, pendingSaves]);
  const reviewRows = useMemo(() => buildReviewRows(txs), [txs]);
  const detailRow = detailTxId ? reviewRows.find(({ tx }) => tx.id === detailTxId) : undefined;
  const previewProblems = useMemo(() => {
    const byId = new Map<string, ReviewProblem[]>();
    for (const problem of previewCheck?.problems ?? []) {
      const problems = byId.get(problem.id) ?? [];
      problems.push(problem);
      byId.set(problem.id, problems);
    }
    return byId;
  }, [previewCheck]);
  const previewTargets = useMemo(() => previewProblems.size ? reviewRows.flatMap(({ entries }) => {
    const problems = entries.flatMap(({ id }) => previewProblems.get(id) ?? []);
    const target = problems.find(({ field }) => field) ?? problems[0];
    return target ? [target] : [];
  }) : [], [previewProblems, reviewRows]);
  const fieldProblem = (id: string, field: ReviewProblem["field"]) =>
    previewProblems.get(id)?.find((problem) => problem.field === field)?.message;
  const active = useMemo(() => activeTransactions(txs), [txs]);
  const accounts = ledger?.accounts ?? [];
  const posted = Boolean(batch?.committed);
  const readOnly = posted || Boolean(batch?.mergedInto);
  const statementSources = useMemo(() => new Map(batch?.statementSources?.map((source) => [source.id, source])), [batch?.statementSources]);
  const sourcesFor = (entries: readonly ParsedTx[]) => [...new Set(entries.flatMap((tx) => tx.statementSourceIds ?? []))]
    .flatMap((id) => statementSources.get(id) ?? []);
  const selectedBatches = batches.filter((item) => !item.committed && !item.mergedInto && selectedBatchIds.has(item.batchId));
  const archivedBatches = batches.filter((item) => item.mergedInto);
  const fileErrors = batch?.errors.filter(({ row }) => row === 0) ?? [];
  const rowErrors = batch?.errors.filter(({ row }) => row > 0) ?? [];
  const emptyImportFailed = !!batch?.errors.length && batch.txs.length === 0;
  const editingDisabled = busy || readOnly;
  const detailDraftIds = Object.keys(drafts);
  const hasReviewDrafts = detailDraftIds.length > 0 || Object.keys(narrationDrafts).length > 0;
  const reviewIsSaving = pendingSaves.length > 0;
  const blockBatchChanges = hasReviewDrafts || reviewIsSaving;
  const dateScopedRows = useMemo(() => dateRange.start || dateRange.end
    ? reviewRows.filter((row) => matchesReviewDateRange(row, dateRange)) : reviewRows, [dateRange, reviewRows]);
  const visible = useMemo(() => {
    const query = filter.trim().toLowerCase();
    return dateScopedRows.filter((row) => matchesReviewFilter(row, statusFilter) && matchesReviewSearch(row, query))
      .sort((a, b) => sort === "amount" ? a.amount - b.amount : sort === "payee" ? a.tx.payee.localeCompare(b.tx.payee, "zh-CN")
        : `${a.tx.date} ${a.tx.time ?? ""}`.localeCompare(`${b.tx.date} ${b.tx.time ?? ""}`));
  }, [dateScopedRows, filter, statusFilter, sort]);
  const totalPages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const focusedRowIndex = rowFocusedDuringSave ? visible.findIndex(({ tx }) => tx.id === rowFocusedDuringSave) : -1;
  const currentPage = focusedRowIndex < 0 ? Math.min(page, totalPages - 1) : Math.floor(focusedRowIndex / PAGE_SIZE);
  const rows = visible.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const visibleEntries = visible.flatMap((row) => row.entries).filter((tx) => !tx.reviewConflictId);
  const selectableRows = visible.filter((row) => row.entries.some((tx) => !tx.reviewConflictId)).length;
  const selectedVisible = visibleEntries.filter((tx) => selected.has(tx.id)).length;
  const selectedRows = reviewRows.filter((row) => row.entries.some((tx) => selected.has(tx.id))).length;
  const hiddenSelection = selectedRows - visible.filter((row) => row.entries.some((tx) => selected.has(tx.id))).length;
  const count = (filter: ReviewFilter) => dateScopedRows.filter((row) => matchesReviewFilter(row, filter)).length;
  const targets = bulkScope === "filtered" ? visibleEntries : active.filter((tx) => selected.has(tx.id));
  const bulkPosting = useMemo(() => {
    if (readOnly || !selectedRows) return null;
    const accountNames = new Set(accounts.map(({ account }) => account));
    return bulkScope === "filtered" ? buildBulkPostingPlan(visible, accountNames) : buildBulkPostingPlan(reviewRows, accountNames, selected);
  }, [accounts, bulkScope, readOnly, reviewRows, selected, selectedRows, visible]);
  const bulkCategory = useMemo(() => {
    if (readOnly || !selectedRows || (bulkScope === "filtered" ? selectableRows : selectedRows) < 2) return null;
    return bulkScope === "filtered" ? buildBulkCategoryPlan(visible, accounts) : buildBulkCategoryPlan(reviewRows, accounts, selected);
  }, [accounts, bulkScope, readOnly, reviewRows, selectableRows, selected, selectedRows, visible]);
  const bulkTagErrors = invalidTags(bulkTags);
  const bulkEditDisabled = editingDisabled || detailDraftIds.length > 0 || !targets.length;
  const bulkTagDisabled = bulkEditDisabled || !parseTags(bulkTags).length || Boolean(bulkTagErrors.length);
  const canApplyBulkCategory = !bulkEditDisabled && !reviewIsSaving && bulkCategory?.options.some(({ account }) => account === bulkCategoryAccount);
  const pendingHigh = active.filter((tx) => tx.status === "pending" && !tx.reviewConflictId && tx.confidence >= 0.9 && (tx.fundingConfidence ?? 1) >= 0.9
    && !tx.issues?.length && tx.suggestedAccount && !missingPostingAccount({ ...tx, finalAccount: tx.suggestedAccount }));
  const readyCount = active.filter((tx) => tx.status === "ready").length;
  const showDecisionStatus = statusFilter === "all";

  useEffect(() => {
    setBulkCategoryAccount("");
  }, [batchId, bulkScope, dateRange, filter, selected, statusFilter]);

  const closeDetails = useCallback(() => {
    detailDialog.current?.close();
    setDetailTxId(null);
    const trigger = document.getElementById(`detail-toggle-${detailTxId}`) ?? searchInput.current;
    trigger?.focus({ preventScroll: true });
  }, [detailTxId]);

  useLayoutEffect(() => {
    // A repair request chooses its own page after any filters change.
    if (!reviewFocus) setPage(0);
  }, [filter, dateRange, statusFilter, sort, batchId]);

  useLayoutEffect(() => {
    if (!rowFocusedDuringSave) return;
    if (focusedRowIndex >= 0 && page !== currentPage) {
      setPage(currentPage);
      document.activeElement?.scrollIntoView({ block: "nearest" });
    }
    setRowFocusedDuringSave(undefined);
  }, [currentPage, focusedRowIndex, page, rowFocusedDuringSave]);

  useLayoutEffect(() => {
    if (!rowFocusedDuringSave && tableScroll.current) tableScroll.current.scrollTop = 0;
  }, [batchId, currentPage, dateRange, filter, sort, statusFilter]);

  useLayoutEffect(() => {
    if (settings || !detailRow) return;
    const dialog = detailDialog.current;
    const openingDrawer = Boolean(dialog && !dialog.open);
    if (openingDrawer) dialog?.showModal();
    if (openingDrawer || focusDetailHeading.current) {
      focusDetailHeading.current = false;
      detailHeading.current?.focus({ preventScroll: true });
    }
  }, [detailAsDrawer, detailRow, settings]);

  useLayoutEffect(() => {
    const panel = detailPanel.current;
    if (!detailSaveAttempt || !panel || panel.dataset.reviewId !== detailSaveAttempt.id) return;
    const fields = [...panel.querySelectorAll<HTMLElement>('.posting-editor [aria-invalid="true"], .review-editor input[aria-invalid="true"]')];
    const first = fields[0];
    const disclosure = first?.closest("details");
    if (disclosure) disclosure.open = true;
    first?.focus();
    return shakeInvalidFields(fields);
  }, [detailSaveAttempt]);

  useEffect(() => {
    if (!detailTxId || settings) return;

    const isOutside = (event: Event) => {
      const panel = detailPanel.current;
      if (!panel) return false;
      const dialog = detailDialog.current;
      if (dialog?.open) return event.target === dialog;
      return !event.composedPath().some((node) => node === panel
        || (node instanceof Element && node.matches("[data-detail-trigger], dialog")));
    };
    let startedOutside = false;
    const trackPointer = (event: PointerEvent) => {
      startedOutside = event.button === 0 && isOutside(event);
    };
    const dismiss = (event: globalThis.MouseEvent) => {
      if ((event.detail !== 0 && !startedOutside) || !isOutside(event)) return;
      if (detailDialog.current?.open) closeDetails();
      else setDetailTxId((id) => id === detailTxId ? null : id);
    };
    document.addEventListener("pointerdown", trackPointer, true);
    document.addEventListener("click", dismiss);
    return () => {
      document.removeEventListener("pointerdown", trackPointer, true);
      document.removeEventListener("click", dismiss);
    };
  }, [closeDetails, detailTxId, settings]);

  useLayoutEffect(() => {
    if (preview) previewHeading.current?.focus();
  }, [preview]);

  useLayoutEffect(() => {
    if (previewCheck && focusPreviewRepair.current && previewRepairButton.current) {
      focusPreviewRepair.current = false;
      previewRepairButton.current.focus();
    }
  }, [previewCheck]);

  useLayoutEffect(() => {
    if (!reviewFocus || busy || settings) return;
    const index = visible.findIndex(({ entries }) => entries.some(({ id }) => id === reviewFocus.id));
    if (index < 0) { setReviewFocus(null); return; }
    const targetPage = Math.floor(index / PAGE_SIZE);
    if (currentPage !== targetPage) { setPage(targetPage); return; }
    const row = visible[index];
    const { id, field } = reviewFocus;
    const tableRow = document.getElementById(`review-row-${row.tx.id}`);
    const inRefundDetail = id !== row.tx.id || Boolean(row.refund?.postings && (field === "category" || field === "funding"));
    const inDetail = inRefundDetail || field === "postings" || field === "tags";
    if (inDetail && detailTxId !== row.tx.id) {
      tableRow?.scrollIntoView({ block: "nearest" });
      setDetailTxId(row.tx.id);
      return;
    }
    if (!inDetail && detailAsDrawer && detailTxId) {
      detailDialog.current?.close();
      setDetailTxId(null);
    }
    let input: HTMLElement | null = null;
    if (field === "category") input = document.getElementById(categoryInputId(id, inRefundDetail));
    if (field === "funding") input = document.getElementById(fundingInputId(id, inRefundDetail));
    if (field === "tags" || field === "postings") input = document.getElementById(`review-${field}-${id}`);
    const leg = inRefundDetail || row.refund ? document.getElementById(`refund-leg-${id}`) : null;
    if (inDetail && leg) leg.querySelector("details.refund-leg-actions")?.setAttribute("open", "");
    const target = input ?? (inDetail ? leg ?? detailHeading.current : tableRow);
    target?.scrollIntoView({ block: "nearest" });
    target?.focus({ preventScroll: true });
    setReviewFocus(null);
  }, [busy, currentPage, detailAsDrawer, detailTxId, reviewFocus, settings, visible]);

  useLayoutEffect(() => {
    if (!categoryAdvance || busy) return;
    const active = document.activeElement;
    if (!settings && !readOnly && (active === document.body || active === categoryAdvance.origin || active === detailHeading.current)) {
      for (const [index, row] of visible.entries()) {
        if (!categoryAdvance.rowIds.has(row.tx.id) || row.entries.some((entry) => drafts[entry.id])) continue;
        const target = pendingCategory(row);
        if (!target) continue;
        const targetPage = Math.floor(index / PAGE_SIZE);
        if (currentPage !== targetPage) { setPage(targetPage); return; }
        if (target.detail && detailTxId !== row.tx.id) {
          setDetailTxId(row.tx.id);
          return;
        }
        if (!target.detail && detailAsDrawer && detailTxId) {
          detailDialog.current?.close();
          setDetailTxId(null);
        }
        const input = document.getElementById(categoryInputId(target.id, target.detail));
        input?.closest("details.refund-leg-actions")?.setAttribute("open", "");
        input?.focus();
        break;
      }
    }
    setCategoryAdvance(null);
  }, [busy, categoryAdvance, currentPage, detailAsDrawer, detailTxId, drafts, readOnly, settings, visible]);
  const suspectedEntries = active.filter(canExcludeSuspectedDuplicate);

  const selectTransactions = (transactions: ParsedTx[], checked: boolean) => {
    if (!selected.size) setBulkScope("selected");
    setSelected((previous) => {
      const next = new Set(previous);
      for (const tx of transactions) checked ? next.add(tx.id) : next.delete(tx.id);
      return next;
    });
  };

  const revealReviewTarget = (targets: ReviewTarget[]) => {
    const byId = new Map(targets.map((target) => [target.id, target]));
    const row = visible.find(({ entries }) => entries.some(({ id }) => byId.has(id)))
      ?? reviewRows.find(({ entries }) => entries.some(({ id }) => byId.has(id)));
    const entry = row?.entries.find(({ id }) => byId.has(id));
    if (!row || !entry) return;
    if (!matchesReviewFilter(row, statusFilter)) setStatusFilter(entry.status);
    if (!matchesReviewDateRange(row, dateRange)) setDateRange(EMPTY_REVIEW_DATE_RANGE);
    if (!matchesReviewSearch(row, filter.trim().toLowerCase())) setFilter("");
    setReviewFocus(byId.get(entry.id)!);
  };

  const startReview = (id: string, value: ImportPreview, resumed: boolean) => {
    setFundingTarget(null);
    setMappingTarget(null);
    setMergeIds(null);
    setBatchMergeOptions(null);
    setRenameStatementsOpen(false);
    setPdfPreviewTx(null);
    replaceBatch(value, id);
    setPreviewCheck(null);
    setReviewFocus(null);
    setDrafts({}); setNarrationDrafts({}); setSelected(new Set()); setDetailTxId(null);
    setFilter(""); setDateRange(EMPTY_REVIEW_DATE_RANGE); setStatusFilter(value.committed || value.mergedInto ? "all" : "pending");
    setBulkScope("selected"); setBulkTags("");
    invalidate(); setNotice(value.mergedInto ? "已合并" : value.committed ? "已提交" : resumed && value.txs.length > 0 ? "已恢复审批进度" : "");
  };

  const prepareReview = async (id: string, value: ImportPreview, opening: ReviewOpening, mappings?: FundingMappingChoice[]) => {
    if (batchIdFromUrl() !== id) return;
    const editable = !value.committed && !value.mergedInto;
    const restoringRefund = editable && value.txs.some((tx) => tx.refundCounterpartId && isClosedAlipayPurchase(tx));
    if (restoringRefund) {
      const result = await api.recheckLedger(id, value.revision ?? 0);
      if (batchIdFromUrl() !== id) return;
      value = result.batch;
    }
    if (editable && !value.statementSources?.length && activeTransactions(value.txs).some((tx) => !tx.merge
      && (tx.source === "wechat" || (!tx.fundingAccount && tx.status !== "excluded" && tx.status !== "duplicate")))) {
      const result = await api.funding(id, value.revision ?? 0, mappings);
      if (batchIdFromUrl() !== id) return;
      if (result.groups.length) {
        setFundingTarget({ id, batch: value, opening, groups: result.groups });
        return;
      }
      if (result.config) setConfig(result.config);
      if (result.batch) value = result.batch;
    }
    startReview(id, value, opening !== "import");
    if (opening === "reload" && editable) {
      if (!restoringRefund) {
        const result = await api.recheckLedger(id, value.revision ?? 0);
        if (batchIdFromUrl() !== id) return;
        replaceBatch(result.batch, id);
      }
      setNotice("已重新载入并复查疑似重复");
    }
  };

  const loadReview = async (id: string, opening: ReviewOpening) => {
    try {
      await prepareReview(id, await api.batch(id), opening);
    } catch (failure) {
      if (!(failure instanceof ApiError) || !failure.temporary) throw failure;
      await new Promise((resolve) => setTimeout(resolve, 1000));
      if (batchIdFromUrl() === id) await prepareReview(id, await api.batch(id), opening);
    }
  };

  const reloadBatch = () => void perform(async () => {
    await decisionQueue.current;
    await loadReview(batchId, "reload");
  });

  const confirmFunding = (target: FundingTarget, mappings: FundingMappingChoice[]) => void perform(async () => {
    try {
      await prepareReview(target.id, target.batch, target.opening, mappings);
    } catch (failure) {
      if (!(failure instanceof ApiError) || failure.status !== 409) throw failure;
      await prepareReview(target.id, await api.batch(target.id), target.opening);
      setError(failure.message);
    }
  });

  const confirmMapping = (target: ParsedTx, account: string) => void perform(async () => {
    await decisionQueue.current;
    const current = batchRef.current;
    if (!current) return;
    const result = await api.saveFundingMapping(batchIdRef.current, current.revision ?? 0, target.id, account);
    invalidate();
    replaceBatch(result.batch);
    setConfig(result.config);
    setMappingTarget(null);
    setNotice(`已保存资金映射 · 更新 ${result.updated} 笔`);
  });

  const upload = (files: FileList | null) => {
    if (!files?.length || busy) return;
    const selectedFiles = [...files];
    if (fileInput.current) fileInput.current.value = "";
    void perform(async () => {
      setUploading(true);
      const result = await api.upload(selectedFiles).finally(() => setUploading(false));
      const { file, createdAt, revision, committed, txCount } = result.preview;
      const saved = { batchId: result.batchId, file, createdAt, revision, committed, txCount };
      setBatches((previous) => [saved, ...previous.filter((item) => item.batchId !== saved.batchId)]);
      navigateBatch(saved.batchId);
      try {
        await loadReview(saved.batchId, "import");
      } catch (failure) {
        if (batchIdFromUrl() !== saved.batchId) return;
        navigateBatch("", { replace: true });
        setError(failure instanceof ApiError && failure.temporary
          ? "账单已保存，请点「继续审批」重试。"
          : `账单已保存。\n${operationMessage(failure)}`);
      }
    });
  };

  const discardNarrationDraft = (id: string, savedValue?: string) => setNarrationDrafts((previous) => {
    if (savedValue !== undefined && previous[id] !== savedValue) return previous;
    const next = { ...previous };
    delete next[id];
    return next;
  });

  const enqueueReviewSave = (
    save: (id: string, current: ImportPreview) => Promise<{ batch: ImportPreview; notice: string } | undefined>,
    { patches, blocking = false, saveOnBlur = false, onSaved }: {
      patches?: ReviewPatches; blocking?: boolean; saveOnBlur?: boolean; onSaved?: () => void;
    } = {},
  ) => {
    if (!batchRef.current || batchRef.current.committed || (locked.current && !saveOnBlur)) return false;
    const id = batchIdRef.current;
    const enqueue = () => {
      invalidate();
      if (patches) setPendingSaves((previous) => [...previous, patches]);
      const pending = decisionQueue.current.then(async () => {
        const current = batchRef.current;
        if (!current || current.committed || batchIdRef.current !== id) return;
        try {
          const result = await save(id, current);
          if (result && batchIdRef.current === id) {
            preserveEditingRow();
            replaceBatch(result.batch, id);
            setNotice(result.notice);
            onSaved?.();
          }
        } catch (failure) {
          if (batchIdRef.current === id) await handleError(failure, true);
        }
      }).finally(() => {
        if (patches) {
          preserveEditingRow();
          setPendingSaves((previous) => previous.filter((item) => item !== patches));
        }
      });
      decisionQueue.current = pending;
      return pending;
    };
    if (blocking) void perform(enqueue);
    else { setError(""); void enqueue(); }
    return true;
  };

  const saveDecisions = (
    decisions: TxDecision[] | ((current: ImportPreview) => TxDecision[]),
    { patches, savedNarration, blocking = !patches && !savedNarration, onSaved }: {
      patches?: ReviewPatches; savedNarration?: { id: string; value: string }; blocking?: boolean; onSaved?: () => void;
    } = {},
  ) => {
    if (Array.isArray(decisions) && !decisions.length) return false;
    return enqueueReviewSave(async (id, current) => {
      const changes = typeof decisions === "function" ? decisions(current) : decisions;
      if (!changes.length) return;
      if (savedNarration && (current.txs.find((tx) => tx.id === savedNarration.id)?.narration ?? null) === changes[0].narration) {
        discardNarrationDraft(savedNarration.id, savedNarration.value);
        return;
      }
      const saved = await api.decide(id, current.revision ?? 0, changes, true);
      let next = saved.batch;
      if (!next && saved.changes) {
        const updated = new Map(saved.changes.txs.map((tx) => [tx.id, tx]));
        next = {
          ...current, revision: saved.revision, parseStats: saved.changes.parseStats,
          txs: current.txs.map((tx) => updated.get(tx.id) ?? tx),
        };
      }
      return { batch: next ?? await api.batch(id), notice: `已保存 ${changes.length} 笔` };
    }, {
      patches, blocking, saveOnBlur: Boolean(savedNarration),
      onSaved: () => {
        if (savedNarration) discardNarrationDraft(savedNarration.id, savedNarration.value);
        onSaved?.();
      },
    });
  };

  const saveReviewDecisions = (decisions: TxDecision[]) =>
    saveDecisions(decisions, { patches: reviewPatches(decisions) });

  const saveFlags = (entries: ParsedTx[], flag: "*" | "!") =>
    saveReviewDecisions(entries.filter((tx) => (tx.flag ?? "*") !== flag).map(({ id }) => ({ id, flag })));

  const savePostingDecisions = (decisions: TxDecision[], {
    followedRefundIds = [], advanceAfter, blocking = false, onSaved,
  }: { followedRefundIds?: readonly string[]; advanceAfter?: string; blocking?: boolean; onSaved?: () => void } = {}) => {
    if (!decisions.length) return;
    const currentIndex = advanceAfter ? visible.findIndex((row) => row.entries.some((entry) => entry.id === advanceAfter)) : -1;
    const advance = currentIndex >= 0 && currentIndex + 1 < visible.length
      ? { rowIds: new Set(visible.slice(currentIndex + 1).map(({ tx }) => tx.id)), origin: document.activeElement } : undefined;
    const patches = blocking ? undefined : reviewPatches(decisions);
    if (patches && followedRefundIds.length) {
      for (const id of followedRefundIds) {
        patches.set(id, (refund, rows) => {
          const purchase = refund.refundCounterpartId ? rows.get(refund.refundCounterpartId) : undefined;
          if (purchase?.status !== "ready" || !canFollowPurchaseRefund(refund) || isSuspectedDuplicate(refund)) return {};
          const account = purchase.finalAccount;
          if (!account.startsWith("Expenses:") || missingPostingAccount({ ...refund, finalAccount: account })) return {};
          return { finalAccount: account, status: "ready", refundReviewMode: "follow-purchase", duplicateOf: undefined };
        });
      }
    }
    const queued = saveDecisions(decisions, {
      patches, blocking,
      onSaved: () => {
        onSaved?.();
        if (blocking && advance) setCategoryAdvance(advance);
      },
    });
    if (queued && !blocking && advance) setCategoryAdvance(advance);
  };

  const savePostingStatus = (ids: string[], status: "ready" | "excluded") =>
    saveReviewDecisions(ids.map((id) => ({ id, status })));

  const createMerge = (draft: MergeDraft) => void perform(async () => {
    await decisionQueue.current;
    const current = batchRef.current;
    if (!current || !mergeIds) return;
    const result = await api.merge(batchIdRef.current, current.revision ?? 0, mergeIds, draft);
    const row = buildReviewRows(result.batch.txs).find(({ tx }) => tx.id === result.mergedId);
    if (row) {
      if (!matchesReviewFilter(row, statusFilter)) setStatusFilter("pending");
      if (!matchesReviewDateRange(row, dateRange)) setDateRange(EMPTY_REVIEW_DATE_RANGE);
      if (!matchesReviewSearch(row, filter.trim().toLowerCase())) setFilter("");
    }
    invalidate();
    replaceBatch(result.batch);
    setMergeIds(null);
    setSelected(new Set());
    setNotice(`已合并 ${mergeIds.length} 笔交易`);
  });

  const undoMerge = (tx: ParsedTx) => void perform(async () => {
    await decisionQueue.current;
    const current = batchRef.current;
    if (!current || !tx.merge) return;
    const result = await api.undoMerge(batchIdRef.current, current.revision ?? 0, tx.id);
    const originalIds = new Set(tx.merge.originals.map(({ id }) => id));
    const restored = buildReviewRows(result.batch.txs).filter(({ tx }) => originalIds.has(tx.id));
    if (!restored.some((row) => matchesReviewFilter(row, statusFilter))) setStatusFilter("all");
    if (!restored.some((row) => matchesReviewDateRange(row, dateRange))) setDateRange(EMPTY_REVIEW_DATE_RANGE);
    if (!restored.some((row) => matchesReviewSearch(row, filter.trim().toLowerCase()))) setFilter("");
    invalidate();
    replaceBatch(result.batch);
    setSelected(new Set());
    setNotice(`已恢复 ${originalIds.size} 笔原交易`);
  });

  const changeDraft = (tx: ParsedTx, value: ReviewDraft) => {
    invalidate();
    setDrafts((previous) => ({ ...previous, [tx.id]: { value, original: previous[tx.id]?.original ?? makeDraft(tx) } }));
  };

  const discardDetailEdits = (entries: ParsedTx[]) => {
    setDetailSaveAttempt((attempt) => attempt?.id === detailTxId ? undefined : attempt);
    setDrafts((previous) => {
      const next = { ...previous };
      for (const { id } of entries) if (previous[id] === drafts[id]) delete next[id];
      return next;
    });
  };

  const saveDetailEdits = (entries: ParsedTx[], detailId: string) => {
    const decisions: TxDecision[] = [];
    for (const tx of entries) {
      const draft = drafts[tx.id];
      if (!draft) continue;
      const validation = draft.value.split && !tx.merge ? validatePostingDraft(draftPostings(tx, draft.value), accounts) : undefined;
      if (invalidTags(draft.value.tags).length || (validation && !validation.postings)) {
        setDetailSaveAttempt({ id: detailId });
        return;
      }
      const decision = draftDecision(tx, draft.value, draft.original, validation?.postings);
      if (Object.keys(decision).length > 1) decisions.push(decision);
    }
    const discard = () => discardDetailEdits(entries);
    if (decisions.some(({ postings }) => postings !== undefined)) {
      saveDecisions(decisions, { onSaved: discard });
    } else if (!decisions.length || saveReviewDecisions(decisions)) discard();
  };

  const applyBulkCategory = () => {
    if (!bulkCategory || !canApplyBulkCategory) return;
    const account = bulkCategoryAccount;
    const decisions = bulkCategory.eligible.map(({ tx }) => ({ id: tx.id, account }));
    const followedRefundIds = bulkCategory.eligible.flatMap(({ refund }) => refundFollowsCategory(refund, account) ? [refund.id] : []);
    savePostingDecisions(decisions, {
      followedRefundIds,
      onSaved: () => setBulkCategoryAccount((current) => current === account ? "" : current),
    });
  };

  const bulkFlag = (flag: "*" | "!") => saveFlags(targets, flag);
  const applyTags = (mode: "add" | "remove") => {
    const tags = parseTags(bulkTags);
    if (!tags.length || invalidTags(bulkTags).length) return;
    const changeTags = (tx: ParsedTx) => ({
      tags: mode === "add" ? [...new Set([...(tx.tags ?? []), ...tags])] : (tx.tags ?? []).filter((tag) => !tags.includes(tag)),
    });
    const patches: ReviewPatches = new Map(targets.map(({ id }) => [id, changeTags]));
    saveDecisions((current) => {
      const txById = new Map(current.txs.map((tx) => [tx.id, tx]));
      return targets.map((tx) => ({ id: tx.id, ...changeTags(txById.get(tx.id) ?? tx) }));
    }, { patches });
  };

  const excludeSuspected = () => {
    if (blockBatchChanges || !suspectedEntries.length) return;
    const patches: ReviewPatches = new Map(suspectedEntries.map(({ id }) => [id, () => ({ status: "excluded", duplicateOf: undefined })]));
    enqueueReviewSave(async (id, current) => {
      const result = await api.excludeSuspected(id, current.revision ?? 0);
      return { batch: result.batch, notice: `已剔除 ${result.excluded} 笔疑似重复` };
    }, { patches });
  };

  const generate = () => void perform(async () => {
    if (blockBatchChanges) return;
    await decisionQueue.current;
    const current = batchRef.current;
    if (!current || current.committed) return;
    setPreview(null);
    setPreviewCheck(null);
    try {
      const result = await api.generate(batchIdRef.current, current.revision ?? 0);
      setPreview(result);
      if (result.errors?.length) setError(result.errors.join("；"));
      else setNotice("");
    } catch (failure) {
      if (!(failure instanceof IncompleteReviewError) || !failure.problems.length) throw failure;
      focusPreviewRepair.current = true;
      setPreviewCheck({ message: failure.message, problems: failure.problems });
    }
  });

  const commit = () => void perform(async () => {
    if (blockBatchChanges) return;
    await decisionQueue.current;
    const current = batchRef.current;
    if (!current || current.committed || !preview || preview.revision !== current.revision) return;
    const result = await api.commit(batchIdRef.current, preview.revision);
    replaceBatch(await api.batch(batchIdRef.current));
    setBatches(await api.batches());
    setNotice(result.alreadyCommitted ? "已提交" : `已写入 ${result.written.length} 个文件`);
  });

  const clearReview = () => {
    replaceBatch(null, ""); setDrafts({}); setNarrationDrafts({}); setSelected(new Set()); setDetailTxId(null); setMergeIds(null); invalidate();
    setFundingTarget(null);
    setPdfPreviewTx(null);
    setMappingTarget(null);
    setReviewFocus(null);
    setBatchMergeOptions(null);
    setRenameStatementsOpen(false);
  };

  useEffect(() => {
    if (busy || (settings && routedBatchId) || routedBatchId === (fundingTarget?.id ?? batchId)) return;
    if (!routedBatchId) {
      void decisionQueue.current.then(() => {
        if (batchIdFromUrl() || locked.current) return;
        const id = batchIdRef.current;
        const current = batchRef.current;
        if (id && current?.revision !== undefined) {
          const { revision, committed } = current;
          setBatches((previous) => previous.map((item) => item.batchId === id ? { ...item, revision, committed: Boolean(committed) } : item));
        }
        clearReview();
        setNotice("");
        void refreshBatchList();
      });
      return;
    }
    void perform(async () => {
      await decisionQueue.current;
      if (batchIdFromUrl() !== routedBatchId) return;
      clearReview();
      setNotice("");
      try {
        await loadReview(routedBatchId, "resume");
      } catch (failure) {
        if (batchIdFromUrl() !== routedBatchId) return;
        navigateBatch("", { replace: true });
        throw failure;
      }
    });
  }, [busy, settings, routedBatchId, fundingTarget?.id, batchId]);

  const goHome = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (!locked.current && !blockBatchChanges) navigateBatch("", { hash: "" });
  };

  const deleteBatch = (target: DeleteTarget) => void perform(async () => {
    try {
      await api.deleteBatch(target.batchId, target.revision);
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      if (error.status === 409) {
        setBatches(await api.batches());
        if (batchIdRef.current === target.batchId) replaceBatch(await api.batch(target.batchId));
        setError(error.message);
        return;
      }
      if (error.status !== 404) throw error;
    }
    if (batchIdFromUrl() === target.batchId) navigateBatch("", { replace: true });
    setBatches((previous) => previous.filter((item) => item.batchId !== target.batchId));
    setNotice("已删除批次");
  });

  const closeBatchDialog = () => {
    setBatchMergeOptions(null);
    setRenameStatementsOpen(false);
    setError("");
  };

  const openBatchMerge = () => void perform(async () => {
    if (selectedBatches.length < 2) return;
    const plan = await api.batchMergeOptions(selectedBatches.map(({ batchId, revision }) => ({ batchId, revision })));
    if (!batchIdFromUrl() && !settingsRoute()) setBatchMergeOptions(plan);
  });

  const mergeBatches = (keepProgress: string[], names: StatementName[]) => void perform(async () => {
    if (!batchMergeOptions) return;
    const selection = batchMergeOptions.batches.map(({ batchId, revision }) => ({ batchId, revision }));
    const result = await api.mergeBatches(selection, keepProgress, names);
    setBatches(result.batches);
    setSelectedBatchIds(new Set());
    closeBatchDialog();
    navigateBatch(result.batch.batchId, { hash: "" });
    startReview(result.batch.batchId, result.batch, false);
    setNotice(`已合并 ${selection.length} 个批次`);
  });

  const renameStatements = (names: StatementName[]) => void perform(async () => {
    if (blockBatchChanges || !batchRef.current) return;
    const result = await api.renameStatements(batchIdRef.current, batchRef.current.revision ?? 0, names);
    invalidate();
    replaceBatch(result.batch);
    closeBatchDialog();
    setNotice("已保存账单显示名");
  });

  const resolveConflict = (conflictId: string, sourceBatchId: string | null) => void perform(async () => {
    const current = batchRef.current;
    if (blockBatchChanges || !current || current.committed || current.mergedInto) return;
    const result = await api.resolveReviewConflict(batchIdRef.current, current.revision ?? 0, conflictId, sourceBatchId);
    invalidate();
    replaceBatch(result.batch);
    setNotice(sourceBatchId ? "已沿用所选批次的审批进度" : "已恢复为待确认");
  });

  const saveConfig = async (values: Partial<AppConfig>) => {
    if (blockBatchChanges) return;
    let saved: ConfigResponse | undefined;
    await perform(async () => {
      saved = await api.saveConfig(values);
      setConfig(saved);
      const switched = saved.ledgerRoot !== config?.ledgerRoot || saved.mainFile !== config?.mainFile;
      if (switched) {
        clearReview();
        navigateBatch("", { replace: true });
        setLedger(null);
        setBatches([]);
        setSelectedBatchIds(new Set());
      } else invalidate();
      setNotice("已保存设置");
      await Promise.all([
        api.ledger().then(setLedger),
        switched ? api.batches().then(setBatches) : Promise.resolve(),
      ]);
    });
    return saved;
  };

  const renderFundingAccount = (tx: ParsedTx, disabled: boolean, detail: boolean, refund?: ParsedTx) => {
    const fundingError = fieldProblem(tx.id, "funding");
    const matchReason = fundingMatchReason(tx);
    const fundingRows = refund ? [tx, refund] : [tx];
    return <AccountSelect value={tx.fundingAccount} accounts={fundingError ? accounts.filter((account) => accountIsActive(account, tx.date, tx.currency)) : accounts}
      funding label={`${tx.payee || "（无商户）"} · 资金账户`} inputId={fundingInputId(tx.id, detail)} placeholder="选择资金账户" validationMessage={fundingError}
      matchReason={matchReason} confirmCurrent={Boolean(matchReason && tx.fundingAccount)} autoHighlight={Boolean(fundingError)}
      disabled={disabled} onChange={(funding) => saveReviewDecisions(fundingRows.map(({ id }) => ({ id, funding })))} />;
  };

  const renderAccountFields = (tx: ParsedTx, disabled: boolean, refund?: ParsedTx, detail = false) => {
    const payee = tx.payee || "（无商户）";
    const accountDisabled = disabled || Boolean(tx.postings || refund?.postings);
    const isTransfer = tx.eventType === "transfer" && !tx.fundingAccount2;
    const categoryLabel = isTransfer ? "对方账户" : "分类账户";
    const categoryError = fieldProblem(tx.id, "category");
    const category = tx.finalAccount || (categoryError ? "" : tx.suggestedAccount);
    const categoryOptions = refund || isTransfer || categoryError ? accounts.filter((option) =>
      (!refund || option.account.startsWith("Expenses:") || option.account === tx.finalAccount)
      && (!isTransfer || /^(Assets|Liabilities):/.test(option.account))
      && (!categoryError || (option.account !== tx.fundingAccount && accountIsActive(option, tx.date, tx.currency)))) : accounts;
    const allocations = savedCategoryAllocations(tx);
    return <>
      <div className={detail ? "account-fields" : "account-fields account-fields-compact"}>
        <div className={allocations ? "account-field has-allocations" : "account-field"}>
          <div className="account-caption">{detail || allocations ? categoryLabel : isTransfer ? "对方" : "分类"}{detail && tx.refundReviewMode === "follow-purchase" && <small>沿用原消费</small>}</div>
          {allocations ? <ul className="category-allocation-summary">
            {allocations.map(({ account, amount }, index) => <li key={index}>
              <code title={account}>{account}</code><span>{amount} {tx.currency}</span>
            </li>)}
          </ul> :
            <AccountSelect value={category} inputId={categoryInputId(tx.id, detail)}
              accounts={categoryOptions} placeholder={isTransfer ? "选择对方账户" : "选择分类"} validationMessage={categoryError}
              label={`${payee} · ${categoryLabel}`} disabled={accountDisabled} autoHighlight={tx.status === "pending" || Boolean(categoryError)}
              confirmCurrent={tx.status === "pending" || Boolean(categoryError)}
              onChange={(account) => {
                const decision = { id: tx.id, account, status: isEditablePostingStatus(tx) ? undefined : tx.status };
                if (decision.status || missingPostingAccount({ ...tx, finalAccount: account })) { saveReviewDecisions([decision]); return; }
                savePostingDecisions([decision], {
                  followedRefundIds: refundFollowsCategory(refund, account) ? [refund.id] : [], advanceAfter: tx.status === "pending" ? tx.id : undefined,
                });
              }} />
          }
        </div>
        <div className="account-field">
          <div className="account-caption">{detail ? "资金账户" : "资金"}</div>
          <div className="funding-control-row">{renderFundingAccount(tx, accountDisabled, detail, refund)}</div>
        </div>
      </div>
      {tx.postings && !allocations && <div className="account-hint">{tx.postings.length} 条分录</div>}
      {tx.fundingAccount2 && <div className="account-hint">转入账户 <code>{tx.fundingAccount2}</code></div>}
      {refund && (tx.postings && refund.status === "pending" ? <div className="account-hint">退款待确认，可在详情中分配</div>
        : refund.finalAccount && refund.finalAccount !== tx.finalAccount && <div className="account-hint">退款分类见详情</div>)}
    </>;
  };

  const renderPostingActions = (tx: ParsedTx, disabled: boolean, refund?: ParsedTx, compact = false) => {
    if (readOnly || tx.reviewConflictId) return null;
    const payee = tx.payee || "（无商户）";
    const entries = refund ? [tx, refund] : [tx];
    const exclude = entries.filter(isEditablePostingStatus);
    const excludeLabel = tx.merge && tx.excludedReason ? "确认不入账" : refund || tx.merge ? "排除此组" : "排除此笔";
    const emphasizeExclude = !compact || Boolean(tx.excludedReason) || entries.some(isSuspectedDuplicate);
    const canInclude = tx.status !== "ready" && !tx.excludedReason && (!refund || (tx.status === "pending"
      && !tx.postings && refund.status === "pending" && canFollowPurchaseRefund(refund) && !isSuspectedDuplicate(refund)));
    const category = tx.finalAccount || tx.suggestedAccount || "";
    const needsExpenseCategory = Boolean(refund) && !category.startsWith("Expenses:");
    const needsCounterpart = tx.eventType === "transfer" && !tx.postings && !/^(Assets|Liabilities):/.test(tx.fundingAccount2 || category);
    const missing = missingPostingAccount({ ...tx, finalAccount: category })
      ?? (needsCounterpart && tx.fundingAccount2 ? "postings" : needsExpenseCategory || needsCounterpart ? "category" : undefined);
    const includeHint = missing === "category" && needsExpenseCategory ? "请先选择费用分类账户"
      : missing === "category" && needsCounterpart ? "请选择转账对方账户" : missing ? missingPostingAccountMessage[missing] : undefined;
    const include = () => {
      if (missing === "postings") { revealReviewTarget([{ id: tx.id, field: missing }]); return; }
      if (missing) {
        const inputId = missing === "funding" ? fundingInputId(tx.id, !compact) : categoryInputId(tx.id, !compact);
        document.getElementById(inputId)?.focus();
        return;
      }
      const decision: TxDecision = {
        id: tx.id, status: "ready", ...(!tx.postings && !tx.fundingAccount2 && !tx.finalAccount ? { account: category } : {}),
      };
      savePostingDecisions([decision], { followedRefundIds: refund ? [refund.id] : [], advanceAfter: tx.id });
    };
    const excludeEntries = () => void savePostingStatus(exclude.map(({ id }) => id), "excluded");
    if (!canInclude && !exclude.length && !tx.merge) return null;
    const iconButton = compact ? " review-icon-button" : "";
    return <div className={compact ? "decision-actions icon-actions" : "decision-actions"}>
      {canInclude && <button type="button" className={`btn small decision-include${iconButton}${missing ? " needs-account" : ""}`} disabled={disabled} aria-label={`标记入账 · ${payee}`}
        title={includeHint ? `标记入账\n${includeHint}` : "标记入账"} onClick={include}>{compact ? <ReviewIcon name="check" /> : "标记入账"}</button>}
      {exclude.length > 0 && <button type="button" className={`btn small quiet decision-exclude${iconButton}${emphasizeExclude ? " is-urgent" : ""}`} disabled={disabled}
        aria-label={`${excludeLabel} · ${payee}`} title={excludeLabel} onClick={excludeEntries}>{compact ? <ReviewIcon name="cross" /> : excludeLabel}</button>}
      {compact && tx.merge && <ReviewMenu label={`更多操作 · ${payee}`} title="⋯">{(close) =>
        <button type="button" className="menu-action" disabled={disabled || narrationDrafts[tx.id] !== undefined}
          aria-label={`撤销合并 · ${payee}`} onClick={() => { close(); undoMerge(tx); }}>撤销合并</button>
      }</ReviewMenu>}
    </div>;
  };

  const renderNarration = (tx: ParsedTx, payee: string) => {
    const automatic = defaultNarration(tx);
    const draft = narrationDrafts[tx.id];
    const value = draft ?? tx.narration ?? "";
    const lockedNarration = readOnly || Boolean(tx.reviewConflictId);
    const canComplete = !value && automatic.length > 0 && automatic.length <= MAX_NARRATION_LENGTH;
    const edit = (next: string) => {
      invalidate();
      setNarrationDrafts((previous) => ({ ...previous, [tx.id]: next }));
    };
    return <div className="tx-narration"><input type="text" aria-label={`账本摘要 · ${payee}`} value={value}
      maxLength={MAX_NARRATION_LENGTH} placeholder={automatic || "输入账本摘要"}
      title={!lockedNarration && canComplete ? "Tab 填入账单摘要" : value || "账本摘要"}
      readOnly={lockedNarration} disabled={busy} onChange={(event) => edit(event.target.value)}
      onBlur={() => {
        if (lockedNarration || draft === undefined) return;
        void saveDecisions([{ id: tx.id, narration: draft.trim() ? draft : null }], {
          savedNarration: { id: tx.id, value: draft },
        });
      }} onKeyDown={(event) => {
        if (busy || lockedNarration || event.nativeEvent.isComposing) return;
        if (event.key === "Tab" && canComplete && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
          event.preventDefault();
          edit(automatic);
        } else if (event.key === "Enter") {
          event.preventDefault();
          event.currentTarget.blur();
        } else if (event.key === "Escape" && draft !== undefined) {
          event.preventDefault();
          discardNarrationDraft(tx.id);
        }
      }} /></div>;
  };

  const renderPostingEditor = (tx: ParsedTx, showValidation: boolean, leg?: string) => {
    const error = fieldProblem(tx.id, "postings");
    if (tx.reviewConflictId || (tx.merge && !error)) return null;
    return <div className="detail-posting-editor" key={tx.id}>
      {leg && <h4>{leg}</h4>}
      <ReviewPostingFields tx={tx} accounts={accounts} draft={drafts[tx.id]?.value ?? makeDraft(tx)}
        disabled={editingDisabled} postingError={error} showValidation={showValidation && Boolean(drafts[tx.id])} onChange={(next) => changeDraft(tx, next)} />
    </div>;
  };

  const renderDetailFlag = (entries: ParsedTx[], label: string, disabled: boolean) => <TransactionFlag label={label}
    value={entries.some((entry) => (drafts[entry.id]?.value.flag ?? entry.flag) === "!") ? "!" : "*"}
    disabled={disabled} onChange={(flag) => {
      for (const entry of entries) {
        const draft = drafts[entry.id]?.value ?? makeDraft(entry);
        if (draft.flag !== flag) changeDraft(entry, { ...draft, flag });
      }
    }} />;

  const renderMetadataEditor = (tx: ParsedTx) => <ReviewMetadataFields tx={tx}
    draft={drafts[tx.id]?.value ?? makeDraft(tx)} disabled={editingDisabled || Boolean(tx.reviewConflictId)}
    tagError={fieldProblem(tx.id, "tags")} onChange={(next) => changeDraft(tx, next)} />;

  const renderFundingReview = (tx: ParsedTx, disabled: boolean, leg?: string) => {
    const combined = combinedPaymentIssue(tx);
    const reason = fundingMatchReason(tx);
    if (combined) return <FundingAllocationDetails key={tx.id} tx={tx} issue={combined} readOnly={readOnly} leg={leg} />;
    if (!reason) return null;
    return <section key={tx.id} className="detail-review-warning" aria-label={`${leg ? `${leg} · ` : ""}资金账户待核对`}>
      <h4>{leg && `${leg} · `}资金账户待核对</h4>
      <p>{reason}</p>
      {!readOnly && !leg && !tx.postings && renderFundingAccount(tx, disabled, true)}
      {!readOnly && reusablePaymentMethod(tx) && hasFundingPosting(tx) && <div>
        <button type="button" className="btn small" aria-haspopup="dialog" disabled={disabled}
          onClick={() => { setError(""); setMappingTarget(tx); }}>添加映射</button>
      </div>}
    </section>;
  };

  const renderPdfSource = (tx: ParsedTx) => {
    const needsCheck = reviewIssues(tx).includes(PDF_REVIEW_ISSUE);
    const available = hasPdfSource(tx);
    if (!needsCheck && !available) return null;
    return <div className="detail-pdf-source">
      {needsCheck && <span>{PDF_REVIEW_ISSUE}</span>}
      {available && <button type="button" className="pdf-preview-button" aria-haspopup="dialog"
        aria-label={`查看 PDF 原文 · ${tx.payee || "无商户"}`} onClick={() => setPdfPreviewTx(tx)}>查看 PDF 原文</button>}
    </div>;
  };

  const renderDirectionReview = (tx: ParsedTx) => {
    const reason = directionReviewReason(tx);
    if (!reason) return null;
    return <section className="detail-review-warning" aria-label={DIRECTION_REVIEW_ISSUE}>
      <h4>{DIRECTION_REVIEW_ISSUE}</h4>
      <p>{reason}</p>
    </section>;
  };

  const renderStatementSource = (tx: ParsedTx, counterpart?: ParsedTx) => <>
    {renderDirectionReview(tx)}
    {renderPdfSource(tx)}
    <TransactionSourceDetails tx={tx} counterpart={counterpart} sources={sourcesFor([tx])} />
  </>;

  const renderMergedOriginals = (originals: ParsedTx[]) => <div className="merge-originals">
    {originals.map((tx) => <article className="refund-leg" key={tx.id}>
      <div className="refund-leg-heading"><h4>{tx.payee || "（无商户）"}</h4>
        <strong className={`amt ${tx.direction}`}>{tx.direction === "in" ? "+" : "−"}{amountText(tx.amount)} {tx.currency}</strong>
        {showDecisionStatus && <span className={`decision-status ${tx.status}`}>{DECISION_LABELS[tx.status]}</span>}
      </div>
      <time className="tx-date" dateTime={tx.date}>{tx.date}{tx.time && ` ${tx.time}`}</time>
      <dl className="tx-meta">
        <div><dt>来源</dt><dd>{tx.sourceFile} · 第 {tx.row} 行</dd></div>
        {tx.sourceTxId && <div><dt>交易号</dt><dd><code>{tx.sourceTxId}</code></dd></div>}
        {tx.fundingAccount && <div><dt>资金账户</dt><dd><code>{tx.fundingAccount}</code></dd></div>}
        {tx.postings ? <div><dt>分录</dt><dd><code>{tx.postings.map(({ account, amount, currency }) => `${account} ${amountText(amount)} ${currency}`).join("\n")}</code></dd></div>
          : tx.finalAccount && <div><dt>分类账户</dt><dd><code>{tx.finalAccount}</code></dd></div>}
        <div><dt>账本摘要</dt><dd>{tx.narration ?? defaultNarration(tx)}</dd></div>
        {tx.reviewNote && <div><dt>审批备注</dt><dd>{tx.reviewNote}</dd></div>}
      </dl>
      {renderDirectionReview(tx)}
      {renderPdfSource(tx)}
    </article>)}
  </div>;

  const renderHistoryMatch = (tx: ParsedTx, match: LedgerMatch, disabled: boolean, label?: string) =>
    <HistoryMatch key={match.id} match={match} disabled={disabled} hasPostings={Boolean(tx.postings)}
      onApply={(account) => saveReviewDecisions([{ id: tx.id, account, status: isEditablePostingStatus(tx) ? undefined : tx.status }])}
      counterpart={active.find((other) => other.id === match.id)}
      onAdopt={() => void saveDecisions([{ id: tx.id, postings: match.postings, status: "ready" }])}
      onExclude={() => savePostingStatus([match.id], "excluded")} duplicate={label ? { tx, label } : undefined} />;

  const renderHistory = (tx: ParsedTx, disabled: boolean) => {
    const promoted = duplicateEvidence(tx);
    const matches = tx.matches?.filter((match) => match !== promoted);
    if (!matches?.length) return null;
    return <details className="detail-section">
      <summary>历史账本参考（{matches.length}）</summary>
      {matches.map((match) => renderHistoryMatch(tx, match, disabled))}
    </details>;
  };

  const renderTransactionDetails = ({ tx, entries, refund, originals, amount }: ReviewRow) => {
    const fieldsDisabled = editingDisabled || entries.some(({ id }) => Boolean(drafts[id]));
    const rowDisabled = editingDisabled || entries.some((entry) => Boolean(entry.reviewConflictId || drafts[entry.id]));
    const editableEntries = entries.filter((entry) => !entry.reviewConflictId);
    const hasEdits = editableEntries.some(({ id }) => Boolean(drafts[id]));
    const status = refund && refund.status !== tx.status ? "分别核对" : postingStatusLabel(tx, posted);
    const conflict = tx.reviewConflictId ? batch?.reviewConflicts?.find(({ id }) => id === tx.reviewConflictId) : undefined;
    const counterpart = tx.refundCounterpartId ? txs.find(({ id }) => id === tx.refundCounterpartId) : undefined;
    const timestamp = tx.time ? `${tx.date} ${tx.time}` : tx.date;
    const panel = <aside key={tx.id} ref={detailPanel} className="transaction-detail" id="transaction-detail" data-review-id={tx.id} aria-labelledby="transaction-detail-heading"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented) {
          event.preventDefault();
          closeDetails();
        }
      }}>
      <header className="transaction-detail-head">
        <div className="detail-heading">
          <div className="detail-payee-line">
            {renderDetailFlag(editableEntries.length ? editableEntries : entries, refund ? "整组账本标记" : "账本标记", editingDisabled || !editableEntries.length)}
            <h3 id="transaction-detail-heading" ref={detailHeading} tabIndex={-1}>{tx.payee || "（无商户）"}</h3>
          </div>
          <div className="detail-meta">
            <time dateTime={tx.time ? `${tx.date}T${tx.time}` : tx.date}>{timestamp}</time>
            {!tx.merge && <span>{refund ? "净支出" : tx.direction === "in" ? "收入" : "支出"} {fmt(amount)} {tx.currency}</span>}
            {showDecisionStatus && <span>{status}</span>}
          </div>
        </div>
        {!readOnly && editableEntries.length > 0 && <div className="toolbar detail-edit-actions" role="group" aria-label="审批编辑">
          <button type="button" className="btn small" disabled={busy || !hasEdits} onClick={() => discardDetailEdits(editableEntries)}>放弃</button>
          <button type="button" className="btn primary small" disabled={busy || !hasEdits}
            onClick={() => saveDetailEdits(editableEntries, tx.id)}>保存</button>
        </div>}
      </header>
      <div className="transaction-detail-body">
        {entries.map((entry) => renderPostingEditor(entry, detailSaveAttempt?.id === tx.id, refund ? entry === refund ? "退款" : "原消费" : undefined))}
        {entries.map((entry) => renderFundingReview(entry, fieldsDisabled || Boolean(entry.reviewConflictId), refund ? entry === refund ? "退款" : "原消费" : undefined))}
        {entries.map((entry) => {
          const match = duplicateEvidence(entry);
          const label = refund ? `${entry === refund ? "退款" : "原消费"} · 疑似重复` : "疑似重复核对";
          return match ? renderHistoryMatch(entry, match, rowDisabled, label) : null;
        })}
        {originals ? <details className="detail-section" open>
          <summary>原交易（{originals.length}）</summary>
          {renderMergedOriginals(originals)}
        </details> : <details className="detail-section" open>
          <summary>账单原始信息</summary>
          {refund ? <div className="refund-sources">
            {entries.map((entry) => <section key={entry.id}>
              <h4>{entry === refund ? "退款" : "原消费"}</h4>
              {renderStatementSource(entry)}
            </section>)}
          </div> : renderStatementSource(tx, counterpart)}
        </details>}
        <EntryPreview entries={entries} batchId={batchId} />
        {conflict && <ReviewConflictPanel conflict={conflict} disabled={editingDisabled || blockBatchChanges} readOnly={readOnly}
          onResolve={(sourceBatchId) => resolveConflict(conflict.id, sourceBatchId)} />}
        {refund ? entries.map((entry) => {
          const label = entry === refund ? "退款" : "原消费";
          return <section className="refund-leg" id={`refund-leg-${entry.id}`} tabIndex={-1} aria-label={label} key={entry.id}>
            <div className="refund-leg-heading"><h3>{label}</h3>
              <strong className={`amt ${entry.direction}`}>{fmt(entry.amount)} {entry.currency}</strong>
              {showDecisionStatus && <span className={`decision-status ${entry.status}`}>{postingStatusLabel(entry, posted)}</span>}</div>
            <time className="tx-date" dateTime={entry.time ? `${entry.date}T${entry.time}` : entry.date}>{entry.date}{entry.time && ` ${entry.time}`}</time>
            {entry.reviewNote && <dl className="tx-meta"><div><dt>审批备注</dt><dd>{entry.reviewNote}</dd></div></dl>}
            <details className="refund-leg-actions">
              <summary>{readOnly ? "单笔详情" : "单笔审批与备注"}</summary>
              <div className="refund-leg-review">
                {renderDetailFlag([entry], `${label}账本标记`, editingDisabled || Boolean(entry.reviewConflictId))}
                {renderAccountFields(entry, fieldsDisabled, undefined, true)}
                {renderPostingActions(entry, rowDisabled)}
                {renderMetadataEditor(entry)}
                {renderHistory(entry, rowDisabled)}
              </div>
            </details>
          </section>;
        }) : <>
          {!originals && renderHistory(tx, rowDisabled)}
          {!conflict && renderMetadataEditor(tx)}
        </>}
      </div>
    </aside>;
    return detailAsDrawer ? <dialog ref={detailDialog} className="transaction-detail-drawer" aria-labelledby="transaction-detail-heading"
      onCancel={(event) => { event.preventDefault(); closeDetails(); }}>{panel}</dialog> : panel;
  };

  const renderBatchRow = (item: BatchSummary) => {
    const selectable = !item.committed && !item.mergedInto;
    const label = item.mergedInto ? "查看原批次" : item.committed ? "查看批次" : "继续审批";
    return <div className={`batch-row${selectable && selectedBatchIds.has(item.batchId) ? " is-selected" : ""}`} key={item.batchId}>
      {selectable && <label className="batch-select">
        <input type="checkbox" className="checkbox" aria-label={`选择批次 · ${item.file}`} disabled={busy}
          checked={selectedBatchIds.has(item.batchId)} onChange={(event) => {
            const next = new Set(selectedBatchIds);
            if (event.target.checked) next.add(item.batchId);
            else next.delete(item.batchId);
            setSelectedBatchIds(next);
          }} />
      </label>}
      <div className="batch-info"><b title={item.file}>{item.file}</b>
        <small>{batchTime(item.createdAt)} · {item.txCount} 笔{item.committed && " · 已提交"}{item.mergedInto && " · 已合并"}</small></div>
      <div className="batch-actions">
        <button type="button" className={`btn${selectable ? " primary" : ""}`} disabled={busy}
          aria-label={`${label} · ${item.file}`} onClick={() => navigateBatch(item.batchId)}>{label}</button>
        {selectable && <button type="button" className="btn batch-delete" disabled={busy}
          aria-label={`删除批次 ${item.file}（${batchTime(item.createdAt)}）`} onClick={() => setDeleteTarget(item)}>删除</button>}
      </div>
    </div>;
  };

  const renderReviewRow = ({ tx, refund, entries, amount, originals }: ReviewRow) => {
    const payee = tx.payee || "（无商户）";
    const ready = tx.status === "ready";
    const isSelected = entries.every((entry) => selected.has(entry.id));
    const partlySelected = !isSelected && entries.some((entry) => selected.has(entry.id));
    const mixedStatus = refund && refund.status !== tx.status;
    const statusLabel = mixedStatus ? "分别核对" : postingStatusLabel(tx, posted);
    const conflicted = Boolean(tx.reviewConflictId);
    const fieldsDisabled = editingDisabled || conflicted || entries.some(({ id }) => Boolean(drafts[id]));
    const hasDraft = entries.some((entry) => Boolean(drafts[entry.id]));
    const rowDisabled = editingDisabled || conflicted || hasDraft;
    const detailsOpen = detailTxId === tx.id;
    const issues = entries.flatMap(reviewIssues).filter((issue) => issue !== PDF_REVIEW_ISSUE);
    const needsDetails = issues.includes(DIRECTION_REVIEW_ISSUE) || entries.some((entry) =>
      combinedPaymentIssue(entry) || fundingMatchReason(entry) || isSuspectedDuplicate(entry) || entry.status === "duplicate" || entry.duplicateOf);
    const detailsLabel = detailsOpen ? "收起详情" : needsDetails ? "核对交易详情" : readOnly ? "查看详情" : "详情与备注";
    const tags = [...new Set(entries.flatMap((entry) => entry.tags ?? []))];
    const shownTags = detailRow && !detailAsDrawer ? 1 : 2;
    const remainingTags = tags.slice(shownTags);
    const directionLabel = tx.direction === "in" ? "收入" : "支出";
    const eventLabel = EVENT_LABELS[tx.eventType ?? (tx.direction === "in" ? "income" : "expense")];
    const sourceType = tx.recognition?.label || (tx.source === "wechat" || tx.source === "yunshanfu" ? tx.rawCategory?.trim() : "");
    let typeLabel = eventLabel;
    if (sourceType && sourceType !== eventLabel) {
      typeLabel = eventLabel === directionLabel ? sourceType : `${eventLabel} · ${sourceType}`;
    }
    const eventText = tx.merge ? `合并 ${tx.merge.originals.length} 笔`
      : refund ? amount === 0 ? "全额退款" : "含退款" : typeLabel === directionLabel ? "" : typeLabel;
    const hasPreviewProblem = entries.some(({ id }) => previewProblems.has(id));
    const rowProblem = [...new Set(entries.flatMap(({ id }) => {
      const message = fieldProblem(id, undefined);
      return message ? [message] : [];
    }))].join(" · ");
    const warnings = new Set([...issues.filter((issue) => issue === LEDGER_DUPLICATE_ISSUE || issue === CROSS_SOURCE_ISSUE), ...issues]);
    const refundCounterpart = tx.refundCounterpartId ? txs.find((row) => row.id === tx.refundCounterpartId) : undefined;
    if (refundCounterpart) warnings.delete("已退款，核对退款流水");
    if (refund) warnings.delete("冲回原费用");
    for (const entry of entries) {
      if (entry.excludedReason) warnings.add(entry.excludedReason);
      if (entry.duplicateOf && entry.status !== "ready") warnings.add(entry.duplicateOf.label);
    }

    return <tr key={tx.id} id={`review-row-${tx.id}`} role="row" tabIndex={-1} data-review-id={tx.id}
      aria-describedby={rowProblem ? `review-row-error-${tx.id}` : undefined}
      className={`tx-row${detailsOpen ? " details-open" : ""}${isSelected ? " is-selected" : ""}${hasPreviewProblem ? " has-review-problem" : ""}`}>
      {!readOnly && <td role="cell" className="tx-select-cell">
        <label className="row-selection">
          <input type="checkbox" className="checkbox" aria-label={`批量选择 ${payee}`} checked={isSelected} disabled={conflicted}
            ref={(input) => { if (input) input.indeterminate = partlySelected; }}
            onChange={(event) => selectTransactions(entries, event.target.checked)} />
          <span>批量选择</span>
        </label>
      </td>}
      <td role="cell" className="tx-summary-cell">
        <div className="tx-summary-content">
            <div className="payee" title={payee}>{payee}</div>
            <div className="tx-secondary">
              <time className="tx-date" dateTime={tx.time ? `${tx.date}T${tx.time}` : tx.date}
                title={tx.time ? `${tx.date} ${tx.time}` : tx.date}>
                <span>{tx.date}</span>{tx.time && <>{" "}<span className="tx-time">{tx.time}</span></>}
              </time>
              {tags.length > 0 && <div className="tag-list">
                {tags.slice(0, shownTags).map((tag) => <button type="button" className="tag-chip" title={`#${tag}`} key={tag} onClick={() => setFilter(tag)}>#{tag}</button>)}
                {remainingTags.length > 0 && <ReviewMenu label={`其余标签 · ${payee}`} title={`+${remainingTags.length}`}>{(close) =>
                  remainingTags.map((tag) => <button className="menu-action" key={tag} type="button"
                    onClick={() => { close(); setFilter(tag); }}>#{tag}</button>)
                }</ReviewMenu>}
              </div>}
            </div>
            {warnings.size > 0 && <ul role="list" aria-label="审批提示" className="tx-warnings">
              {[...warnings].map((warning) => <li key={warning}>{warning}</li>)}
            </ul>}
            {rowProblem && <p id={`review-row-error-${tx.id}`} className="review-field-error">{rowProblem}</p>}
            {renderNarration(tx, payee)}
            {statementSources.size > 0 && <StatementSources sources={sourcesFor(originals ?? entries)} />}
        </div>
      </td>
      <td role="cell" className="tx-type-cell">
        <div className="tx-event">
          <button id={`detail-toggle-${tx.id}`} type="button" className={`btn small quiet review-icon-button detail-toggle${needsDetails ? " detail-warning" : ""}`} data-detail-trigger
            aria-label={`${detailsLabel} · ${payee}`} title={detailsLabel} aria-expanded={detailsOpen}
            aria-controls={detailsOpen ? "transaction-detail" : undefined} onClick={() => {
              if (detailsOpen) { closeDetails(); return; }
              focusDetailHeading.current = true;
              setDetailTxId(tx.id);
            }}><ReviewIcon name={needsDetails ? "question" : "info"} /></button>
          {eventText && <span title={eventText}>{eventText}</span>}
        </div>
      </td>
      <td role="cell" className={`tx-amount-cell${tx.merge ? "" : ` amt ${tx.direction}`}`}>
        {tx.merge ? <div className="merge-amounts">
          {tx.merge.totals.map(({ amount, currency }) => <div className={`amount-line amt${amount === 0 ? "" : amount > 0 ? " in" : " out"}`} key={currency}>
            <span className="amount-direction">{amount === 0 ? "净额" : amount > 0 ? "收入" : "支出"}</span>{" "}
            <strong className="amount-value">{amountText(Math.abs(amount))}</strong>{" "}<span className="amount-currency">{currency}</span>
          </div>)}
        </div> : <div className="amount-line">
          <span className="amount-direction">{refund ? "净支出" : directionLabel}</span>{" "}
          <strong className="amount-value">{fmt(amount)}</strong>{" "}
          <span className="amount-currency">{tx.currency}</span>
        </div>}
      </td>
      <td role="cell" className="tx-account-cell">
        {tx.merge ? <><div className="account-caption">{tx.postings?.length ?? 0} 条分录</div>
          {tx.fundingAccount && <code className="merged-funding-account">{tx.fundingAccount}</code>}</> : renderAccountFields(tx, fieldsDisabled, refund)}
      </td>
      <td role="cell" className="tx-decision-cell">
        {showDecisionStatus && <span className={`decision-status ${mixedStatus ? "pending" : tx.status}`}>{statusLabel}</span>}
        {ready && tx.duplicateOf && <div className="account-hint">人工解除重复</div>}
        {renderPostingActions(tx, rowDisabled, refund, true)}
        {conflicted && <button type="button" className="btn small conflict-trigger" aria-label={`核对审批冲突 · ${payee}`} data-detail-trigger
          onClick={() => { focusDetailHeading.current = true; setDetailTxId(tx.id); }}>核对冲突</button>}
        {hasDraft && <span className="unsaved-edit">未保存</span>}
      </td>
    </tr>;
  };

  const mappingGroup: FundingMappingGroup | undefined = mappingTarget ? {
    id: mappingTarget.id, label: reusablePaymentMethod(mappingTarget), source: mappingTarget.source, count: 1,
    accounts: accounts.filter((item) => isFundingAccount(item.account) && item.account !== mappingTarget.fundingAccount2
      && accountIsActive(item, mappingTarget.date, mappingTarget.currency)).map(({ account }) => account),
  } : undefined;
  const reviewNotice = busy && batch ? "处理中…" : reviewIsSaving ? "保存审批中…" : notice;
  return <main className="container">
    <header className="masthead">
      <a className="masthead-brand" href={batchUrl("", "")} aria-label="Bean Import · 返回主页" aria-disabled={busy || blockBatchChanges || undefined}
        title={hasReviewDrafts ? "请先保存或放弃交易编辑" : reviewIsSaving ? "保存审批中…" : "返回主页"} onClick={goHome}>
        <img className="brand-mark" src="/bean-import.svg" width="30" height="30" alt="" /><h1>Bean Import</h1>
      </a>
      <div className="masthead-context">
        <HeaderDetails config={config} ledger={ledger} batch={batch} />
        {reviewNotice && <span className="notice" role="status">{reviewNotice}</span>}
      </div>
      <div className="masthead-actions">
        {settings ? routedBatchId && <a className="btn settings-entry" href="#">返回审批</a> :
          <a className="btn settings-entry settings-icon" href={SETTINGS_LINKS.ledger} aria-label="设置" title="设置"><ReviewIcon name="settings" /></a>}
      </div>
    </header>
    {error && !fundingTarget && !mappingTarget && !mergeIds && !batchMergeOptions && !renameStatementsOpen
      && <div className="card alert" role="alert"><b>操作未完成</b><p>{error}</p><button className="btn small" onClick={() => setError("")}>关闭</button></div>}
    {!settings && fundingTarget && fundingTarget.id === routedBatchId && <FundingDialog key={fundingTarget.id} groups={fundingTarget.groups} busy={busy} error={error}
      onCancel={() => {
        setFundingTarget(null);
        setError("");
        if (batchId !== fundingTarget.id) navigateBatch("", { replace: true });
      }} onConfirm={(mappings) => confirmFunding(fundingTarget, mappings)} />}
    {mappingTarget && mappingGroup && <FundingDialog key={mappingTarget.id} mapping groups={[mappingGroup]} busy={busy} error={error}
      initialChoices={mappingGroup.accounts.includes(mappingTarget.fundingAccount) ? { [mappingTarget.id]: mappingTarget.fundingAccount } : {}}
      onCancel={() => { setMappingTarget(null); setError(""); }} onConfirm={([{ account }]) => confirmMapping(mappingTarget, account)} />}
    {mergeIds && <MergeDialog members={active.filter((tx) => mergeIds.includes(tx.id))} accounts={new Set(accounts.map(({ account }) => account))}
      busy={busy} error={error} onClose={() => { setMergeIds(null); setError(""); }} onConfirm={createMerge} />}
    {!settings && !routedBatchId && batchMergeOptions && <BatchReviewDialog batches={batchMergeOptions.batches} sources={batchMergeOptions.sources}
      busy={busy} error={error} onClose={closeBatchDialog} onConfirm={mergeBatches} />}
    {!settings && renameStatementsOpen && batch?.statementSources && <BatchReviewDialog sources={batch.statementSources}
      busy={busy} error={error} onClose={closeBatchDialog} onConfirm={(_keep, names) => renameStatements(names)} />}
    {!settings && pdfPreviewTx && <PdfPreviewDialog key={pdfPreviewTx.id} batchId={batchId} tx={pdfPreviewTx} onClose={() => setPdfPreviewTx(null)} />}
    <dialog className="delete-dialog" ref={deleteDialog} aria-labelledby="delete-batch-title" aria-describedby="delete-batch-detail" onClose={(event) => {
      if (deleteTarget && event.currentTarget.returnValue === "delete") deleteBatch(deleteTarget);
      setDeleteTarget(null);
    }}>
      {deleteTarget && <form method="dialog">
        <h2 id="delete-batch-title">删除这个批次？</h2>
        <div id="delete-batch-detail">
          <b>{deleteTarget.file}</b>
          {deleteTarget.createdAt !== undefined && <small>{batchTime(deleteTarget.createdAt)}</small>}
          <p>审批进度将永久删除。</p>
        </div>
        <div className="toolbar"><button className="btn" value="cancel">取消</button><button className="btn danger" value="delete">删除批次</button></div>
      </form>}
    </dialog>
    {ledger?.errors?.length ? <details className="card ledger-errors"><summary>账本校验信息（{ledger.errors.length}）</summary>{ledger.errors.map((item, index) => <p className="error-line" key={index}>{item.file}{item.line ? `:${item.line}` : ""} {item.message}</p>)}</details> : null}
    {config ? <ConfigPanel key={`${config.ledgerRoot}|${config.mainFile}`} section={settings} config={config} accounts={accounts}
      busy={busy} lockedByDrafts={blockBatchChanges} onSave={saveConfig} /> :
      settings && <section className="card" aria-busy={busy}><h2>设置</h2><p className="muted">{busy ? "正在读取设置…" : "未能读取设置"}</p></section>}

    {!settings && <input ref={fileInput} type="file" accept=".csv,.xlsx,.xls,.pdf" multiple hidden disabled={busy} onChange={(event) => upload(event.target.files)} />}
    {!settings && routedBatchId && batchId !== routedBatchId && fundingTarget?.id !== routedBatchId &&
      <section className="card" role="status">正在恢复审批…</section>}
    {!settings && !routedBatchId && !batch && <>
      <section className="card"><div className={`dropzone${dragOver ? " over" : ""}`} role="button" tabIndex={0} aria-label="选择账单文件" aria-disabled={busy} onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); if (!busy) fileInput.current?.click(); }
      }} onClick={() => { if (!busy) fileInput.current?.click(); }} onDragOver={(event) => { event.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)} onDrop={(event) => { event.preventDefault(); setDragOver(false); upload(event.dataTransfer.files); }}><span className="dz-glyph" aria-hidden="true" /><div className="dz-main">{uploading ? "正在读取账单…" : "拖入账单，或点击选择文件"}</div><div className="dz-sub">可同时选择多个 CSV / XLSX / PDF · ZIP 请先解压</div></div></section>
      <section className="card" aria-busy={batchesRefreshing}>
        <div className="toolbar"><h2>导入批次</h2><span className="spacer" />
          {selectedBatches.length > 0 && <>
            <span className="muted" role="status">已选 {selectedBatches.length} 个</span>
            <button type="button" className="btn small primary" aria-haspopup="dialog" disabled={busy || selectedBatches.length < 2} onClick={openBatchMerge}>合并审批</button>
          </>}
          <button className="btn small" disabled={busy || batchesRefreshing} onClick={() => void refreshBatchList()}>刷新</button>
        </div>
        {!batches.length ? <p className="muted">{batchesRefreshing ? "正在加载导入批次…" : "暂无已保存批次。"}</p>
          : <div className="batch-list">{batches.filter((item) => !item.mergedInto).map(renderBatchRow)}</div>}
        {archivedBatches.length > 0 && <details className="archived-batches">
          <summary>已合并批次（{archivedBatches.length}）</summary>
          <div className="batch-list">{archivedBatches.map(renderBatchRow)}</div>
        </details>}
      </section>
    </>}

    {!settings && batch && batchId === routedBatchId && <>
      <section className="card review-card">
        <div className="toolbar review-header">
          <h2 id="review-heading">审批交易</h2>
          {!emptyImportFailed && <div className="toolbar review-actions" role="group" aria-label="批次操作">
            <ReviewMenu label="批次操作" title="批次操作">{(close) => <>
              <button className="menu-action" disabled={busy || blockBatchChanges} onClick={() => { close(); reloadBatch(); }}>重新载入</button>
              {Boolean(batch.statementSources?.length) && !batch.mergedInto && <button className="menu-action" disabled={busy || blockBatchChanges}
                onClick={() => { close(); setError(""); setRenameStatementsOpen(true); }}>账单显示名</button>}
              {!readOnly && <>
                <button className="menu-action" disabled={editingDisabled || blockBatchChanges || !pendingHigh.length}
                  onClick={() => { close(); saveReviewDecisions(pendingHigh.map((tx) => ({ id: tx.id, account: tx.suggestedAccount, status: "ready" }))); }}>
                  接受高置信度（{pendingHigh.length}）
                </button>
                <button className="menu-action danger-text" disabled={editingDisabled || blockBatchChanges || !suspectedEntries.length}
                  title="批量排除当前批次中仍可入账的疑似重复交易" onClick={() => { close(); excludeSuspected(); }}>剔除疑似重复（{suspectedEntries.length}）</button>
              </>}
            </>}</ReviewMenu>
            {!readOnly && <button className="btn primary" disabled={busy || blockBatchChanges || readyCount === 0} onClick={generate}>生成预览（{readyCount}）</button>}
          </div>}
        </div>
        {previewCheck && <div className="review-validation">
          <p role="alert">{previewCheck.message}</p>
          {previewTargets.length > 0 && <button ref={previewRepairButton} type="button" className="btn small"
            onClick={() => revealReviewTarget(previewTargets)}>查看需修正的 {previewTargets.length} 笔</button>}
          <button type="button" className="btn small quiet close-detail" aria-label="关闭预览提示" title="关闭预览提示"
            onClick={() => setPreviewCheck(null)}>×</button>
        </div>}
        {batch.committedAt && <p className="muted review-diagnostic">提交于 {batchTime(Date.parse(batch.committedAt))}</p>}
        {(fileErrors.length > 0 || emptyImportFailed) && <div className="review-import-alert review-diagnostic" role="alert">
          <strong>{emptyImportFailed ? "未读取到账单交易" : "部分账单未导入"}</strong>
          {fileErrors.length > 0 && <ul>{fileErrors.map(({ message }, index) => <li key={index}>{message}</li>)}</ul>}
          {emptyImportFailed && <button className="btn small" disabled={busy} onClick={() => fileInput.current?.click()}>重新上传</button>}
        </div>}
        {rowErrors.length > 0 && <details className="review-diagnostic"><summary>需要核对的账单行（{rowErrors.length}）</summary>{rowErrors.map(({ row, message }, index) => <p className="error-line" key={index}>第 {row} 行：{message}</p>)}</details>}
        {batch.ledgerErrors?.length ? <details className="review-diagnostic"><summary>载入批次时的账本校验信息（{batch.ledgerErrors.length}）</summary>{batch.ledgerErrors.map((item, index) => <p className="error-line" key={index}>{item.file}{item.line ? `:${item.line}` : ""} {item.message}</p>)}</details> : null}
        <div className="filter-row">
          <div className="review-search">
            <input ref={searchInput} type="search" value={filter} onChange={(event) => setFilter(event.target.value)}
              placeholder="搜索交易" aria-label="搜索交易" title="搜索商户、金额、标签、账户和备注" />
          </div>
          <DateRangeFilter value={dateRange} onChange={setDateRange} />
          <nav className="tabs" aria-label="筛选交易">
            {STATUS_TABS.map(({ key, label }) => <button className={`tab${statusFilter === key ? " active" : ""}`} aria-pressed={statusFilter === key}
              key={key} onClick={() => setStatusFilter(key)}>{posted && key === "ready" ? "已入账" : label}<span className="count">{count(key)}</span></button>)}
          </nav>
          <select aria-label="排序" value={sort} onChange={(event) => setSort(event.target.value as typeof sort)}><option value="date">按日期</option><option value="amount">按金额</option><option value="payee">按商户</option></select>
        </div>
        <div className={`review-workspace${detailRow && !detailAsDrawer ? " has-detail" : ""}`}>
          {!rows.length ? <div className="empty">无匹配交易</div> : <div className="table-scroll" ref={tableScroll}>
          <table className={`tx${readOnly ? " read-only" : ""}`} role="table" aria-labelledby="review-heading">
            <thead role="rowgroup">
              <tr role="row">
                {!readOnly && <th role="columnheader" scope="col" className="select-column">
                  <label className="select-filtered">
                    <input type="checkbox" className="checkbox" disabled={visibleEntries.length === 0}
                      checked={visibleEntries.length > 0 && selectedVisible === visibleEntries.length}
                      ref={(input) => { if (input) input.indeterminate = selectedVisible > 0 && selectedVisible < visibleEntries.length; }}
                      onChange={(event) => selectTransactions(visibleEntries, event.target.checked)} />
                    全选
                  </label>
                </th>}
                <th role="columnheader" scope="col">交易</th>
                <th role="columnheader" scope="col" className="type-column">交易类型</th>
                <th role="columnheader" scope="col" className="amount-column">金额</th>
                <th role="columnheader" scope="col" className="account-column">账户</th>
                <th role="columnheader" scope="col" className="decision-column">入账决定</th>
              </tr>
            </thead>
            <tbody role="rowgroup">
              {rows.map(renderReviewRow)}
            </tbody>
          </table>
          </div>}
          {detailRow && renderTransactionDetails(detailRow)}
        </div>
        <footer className="review-footer">
          {bulkPosting ? <div className="bulk-bar" role="group" aria-label="批量编辑">
            <select className="bulk-scope" aria-label="批量编辑范围" value={bulkScope} onChange={(event) => setBulkScope(event.target.value as typeof bulkScope)}>
              <option value="selected">已选 {selectedRows} 笔{hiddenSelection > 0 ? `（筛选外 ${hiddenSelection}）` : ""}</option>
              <option value="filtered">全部可选结果 · {selectableRows} 笔</option>
            </select>
            {bulkCategory && <div className="bulk-category" role="group" aria-label="批量设置分类">
              <AccountSelect value={bulkCategoryAccount} accounts={bulkCategory.options} label="批量分类账户" placeholder="设置分类" autoHighlight
                disabled={bulkEditDisabled || !bulkCategory.options.length} onChange={setBulkCategoryAccount} />
              <button type="button" className="btn small" disabled={!canApplyBulkCategory} onClick={applyBulkCategory}>
                {bulkCategory.eligible.length ? `应用到 ${bulkCategory.eligible.length} 笔` : "应用"}
              </button>
              {bulkCategory.skipped > 0 && <span className="bulk-category-hint">{bulkCategory.skipped} 笔需逐笔处理</span>}
              {bulkCategory.eligible.length > 0 && !bulkCategory.options.length && <span className="bulk-category-hint">无共同可用分类</span>}
            </div>}
            <button type="button" className="btn primary small" disabled={bulkEditDisabled || !bulkPosting.approvals.length}
              aria-describedby={bulkPosting.reviewTargets.length ? "bulk-review-hint" : undefined}
              onClick={() => savePostingDecisions(bulkPosting.approvals, { followedRefundIds: bulkPosting.followedRefundIds })}>标记 {bulkPosting.approvalCount} 笔入账</button>
            <button type="button" className="btn small" disabled={bulkEditDisabled || !bulkPosting.exclusionIds.length}
              onClick={() => void savePostingStatus(bulkPosting.exclusionIds, "excluded")}>{bulkScope === "filtered" ? "排除筛选结果" : "排除所选"}</button>
            {(bulkScope === "filtered" ? selectableRows : selectedRows) >= 2 && <button type="button" className="btn small" disabled={bulkEditDisabled || targets.length < 2}
              onClick={() => { setError(""); setMergeIds(targets.map(({ id }) => id)); }}>合并记账</button>}
            <ReviewMenu label="批量标签与标记" title="标签与标记">{(close) => <div className="bulk-edit-menu">
              <input value={bulkTags} onChange={(event) => setBulkTags(event.target.value)} placeholder="英文标签，空格分隔" aria-label="批量标签"
                aria-describedby={bulkTagErrors.length ? "bulk-tag-errors" : undefined} aria-invalid={bulkTagErrors.length > 0 || undefined} />
              {bulkTagErrors.length > 0 && <p className="error-line" id="bulk-tag-errors" role="alert">标签格式无效：{bulkTagErrors.join("、")}</p>}
              <div className="toolbar">
                <button type="button" className="btn small" disabled={bulkTagDisabled} onClick={() => { close(); applyTags("add"); }}>添加标签</button>
                <button type="button" className="btn small" disabled={bulkTagDisabled} onClick={() => { close(); applyTags("remove"); }}>移除标签</button>
              </div>
              <div className="bulk-flag-actions">
                <button type="button" className="menu-action" disabled={bulkEditDisabled} onClick={() => { close(); bulkFlag("!"); }}>标记 ! 待核实</button>
                <button type="button" className="menu-action" disabled={bulkEditDisabled} onClick={() => { close(); bulkFlag("*"); }}>标记 * 正常</button>
              </div>
            </div>}</ReviewMenu>
            <button type="button" className="btn small quiet" onClick={() => setSelected(new Set())}>清空选择</button>
            {bulkPosting.reviewTargets.length > 0 && <button id="bulk-review-hint" type="button" className="btn small quiet bulk-review-hint"
              onClick={() => revealReviewTarget(bulkPosting.reviewTargets)}>{bulkPosting.reviewTargets.length} 笔需核对</button>}
          </div> : <span className="review-count">{visible.length} 笔</span>}
          <nav className="toolbar pagination" aria-label="分页">
            <button type="button" className="btn small quiet" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>上一页</button>
            <span>第 {currentPage + 1} / {totalPages} 页</span>
            <button type="button" className="btn small quiet" disabled={currentPage >= totalPages - 1} onClick={() => setPage(currentPage + 1)}>下一页</button>
          </nav>
        </footer>
      </section>

      {preview && <section className="card"><div className="toolbar"><h2 ref={previewHeading} tabIndex={-1}>分录预览</h2><span>共 {preview.generated} 笔</span><span className="spacer" />{!readOnly && <button className="btn primary" disabled={busy || blockBatchChanges || Boolean(preview.errors?.length) || preview.revision !== batch.revision} onClick={commit}>校验并写入账本</button>}</div><p className="muted preview-targets">{(preview.targetFiles ?? Object.keys(preview.monthFiles)).join(" · ")}</p>{preview.opens.length > 0 && <p className="error-line">账户指令建议：{preview.opens.join("；")}</p>}{preview.errors?.map((message, index) => <p role="alert" className="error-line" key={index}>{message}</p>)}<BeancountCode className="code" text={preview.entries} /></section>}
      {posted && <section className="card done-banner"><h2>此批次已过账</h2>{Boolean(batch.written?.length) && <p>{batch.written?.join(" · ")}</p>}</section>}
      {batch.mergedInto && <section className="card done-banner"><div className="toolbar"><h2>此批次已合并</h2>
        {batches.some(({ batchId }) => batchId === batch.mergedInto) && <button type="button" className="btn small"
          disabled={busy} onClick={() => navigateBatch(batch.mergedInto!)}>查看合并后的批次</button>}
      </div></section>}
      <section className="card"><div className="toolbar"><button className="btn" disabled={busy} onClick={() => void perform(async () => { const result = await api.validate(); setValidation(`${result.ok ? "校验通过" : "校验未通过"}\n${result.output}`); })}>校验当前账本</button><button className="btn" disabled={busy} onClick={() => void perform(async () => { const result = await api.fava(); setFavaMessage(result.running ? `http://localhost:${result.port}` : result.error ?? "Fava 启动失败"); })}>打开 Fava 报表</button></div>{validation && <pre className="code">{validation}</pre>}{favaMessage && <p>{favaMessage.startsWith("http") ? <a href={favaMessage} target="_blank" rel="noreferrer">在新窗口查看 Fava</a> : favaMessage}</p>}</section>
    </>}
  </main>;
}
