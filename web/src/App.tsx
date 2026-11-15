import { useEffect, useMemo, useRef, useState } from "react";
import type { AppConfig, ImportPreview, ParsedTx, TxStatus } from "../../../src/shared/types.js";
import { api, type UploadSummary } from "./api";

type Phase = "upload" | "review" | "preview" | "done";
type SortKey = "date" | "amount" | "payee" | "confidence";
type SortDir = "asc" | "desc";

const STATUS_TABS: Array<{ key: "all" | TxStatus; label: string }> = [
  { key: "all", label: "全部" },
  { key: "pending", label: "待确认" },
  { key: "ready", label: "已就绪" },
  { key: "duplicate", label: "重复" },
  { key: "excluded", label: "已排除" },
];

/** beancount syntax highlight for the preview block. */
function highlight(entries: string): React.ReactNode[] {
  return entries.split("\n").map((line, i) => {
    if (line.startsWith(";")) return <div key={i} className="mo">{line}</div>;
    if (/^\d{4}-\d{2}-\d{2}/.test(line)) {
      const m = line.match(/^(\S+)(.*)$/)!;
      return <div key={i}><span className="mo">{m[1]}</span>{m[2]}</div>;
    }
    const m = line.match(/^(\s+)([A-Z][\w:-]*)(.*)$/);
    if (m) return <div key={i}>{m[1]}<span className="acc">{m[2]}</span>{m[3]}</div>;
    return <div key={i}>{line}</div>;
  });
}

export default function App() {
  const [phase, setPhase] = useState<Phase>("upload");
  const [summary, setSummary] = useState<UploadSummary | null>(null);
  const [batch, setBatch] = useState<ImportPreview | null>(null);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [entries, setEntries] = useState<string>("");
  const [monthFiles, setMonthFiles] = useState<Record<string, string>>({});
  const [opens, setOpens] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | TxStatus>("all");
  const [sortKey, setSortKey] = useState<SortKey>("date");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [helpOpen, setHelpOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [validateResult, setValidateResult] = useState<string>("");
  const [favaMsg, setFavaMsg] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.config().then(setConfig).catch(() => {});
  }, []);

  // "/" focuses search, Esc clears
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "/" && document.activeElement?.tagName !== "INPUT" && document.activeElement?.tagName !== "SELECT") {
        e.preventDefault();
        searchRef.current?.focus();
      }
      if (e.key === "Escape" && document.activeElement === searchRef.current) {
        setFilter("");
        searchRef.current?.blur();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const handleFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    setError("");
    try {
      const s = await api.upload([...files]);
      setSummary(s);
      setBatch(await api.batch(s.batchId));
      setPhase("review");
      setFilter("");
      setStatusFilter("all");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const txs = batch?.txs ?? [];

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const filtered = txs.filter((t) => {
      if (statusFilter !== "all" && t.status !== statusFilter) return false;
      if (!q) return true;
      return (
        t.payee.toLowerCase().includes(q) ||
        t.note.toLowerCase().includes(q) ||
        t.amount.toFixed(2).includes(q) ||
        t.rawAccount.toLowerCase().includes(q)
      );
    });
    const dir = sortDir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      switch (sortKey) {
        case "amount": return (a.amount - b.amount) * dir;
        case "payee": return a.payee.localeCompare(b.payee, "zh") * dir;
        case "confidence": return (a.confidence - b.confidence) * dir;
        default: return (a.date === b.date ? a.id.localeCompare(b.id) : a.date < b.date ? -1 : 1) * dir;
      }
    });
  }, [txs, filter, statusFilter, sortKey, sortDir]);

  const stats = useMemo(() => {
    const by = (s: TxStatus) => txs.filter((t) => t.status === s).length;
    const sums = txs
      .filter((t) => t.status === "ready")
      .reduce(
        (acc, t) => {
          if (t.direction === "in") acc.in += t.amount;
          else acc.out += t.amount;
          return acc;
        },
        { in: 0, out: 0 },
      );
    return {
      total: txs.length,
      ready: by("ready"),
      pending: by("pending"),
      sums,
    };
  }, [txs]);

  const patchTx = (id: string, patch: Partial<ParsedTx>) => {
    setBatch((b) =>
      b ? { ...b, txs: b.txs.map((t) => (t.id === id ? { ...t, ...patch } : t)) } : b,
    );
  };

  const toggleStatus = async (tx: ParsedTx) => {
    const next: TxStatus =
      tx.status === "excluded" ? "ready"
      : tx.status === "ready" ? "excluded"
      : tx.status === "duplicate" ? "ready"
      : "excluded";
    patchTx(tx.id, { status: next });
    await api.decide(summary!.batchId, [{ id: tx.id, status: next }]);
  };

  const setAccount = async (tx: ParsedTx, account: string) => {
    const status: TxStatus = tx.status === "pending" ? "ready" : tx.status;
    patchTx(tx.id, { finalAccount: account, status });
    await api.decide(summary!.batchId, [{ id: tx.id, account, status }]);
  };

  const acceptAllHighConfidence = async () => {
    const decisions = txs
      .filter((t) => t.status === "pending" && t.confidence >= 0.9)
      .map((t) => ({ id: t.id, account: t.suggestedAccount, status: "ready" as TxStatus }));
    if (!decisions.length) return;
    await api.decide(summary!.batchId, decisions);
    setBatch((b) =>
      b
        ? {
            ...b,
            txs: b.txs.map((t) => {
              const d = decisions.find((x) => x.id === t.id);
              return d ? { ...t, finalAccount: d.account!, status: "ready" } : t;
            }),
          }
        : b,
    );
  };

  const doGenerate = async () => {
    setBusy(true);
    try {
      const r = await api.generate(summary!.batchId);
      setEntries(r.entries);
      setMonthFiles(r.monthFiles);
      setOpens(r.opens);
      setPhase("preview");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const doCommit = async () => {
    setBusy(true);
    try {
      await api.commit(summary!.batchId, monthFiles, opens);
      setPhase("done");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setPhase("upload");
    setBatch(null);
    setSummary(null);
    setValidateResult("");
    setFavaMsg("");
    setEntries("");
    setFilter("");
  };

  const accountOptions = useMemo(() => {
    const set = new Set<string>(config?.accounts ?? []);
    for (const t of txs) {
      if (t.suggestedAccount) set.add(t.suggestedAccount);
      if (t.fundingAccount) set.add(t.fundingAccount);
    }
    return [...set].sort();
  }, [config, txs]);

  const fmt = (n: number) => n.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pendingHigh = txs.filter((t) => t.status === "pending" && t.confidence >= 0.9).length;
  const sortIndicator = (k: SortKey) =>
    sortKey === k ? <span className="arrow">{sortDir === "asc" ? "↑" : "↓"}</span> : null;
  const clickSort = (k: SortKey) => {
    if (sortKey === k) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(k); setSortDir("asc"); }
  };

  return (
    <div className="container">
      {/* ===== masthead ===== */}
      <header className="masthead">
        <div className={`seal${phase === "done" ? " green" : ""}`}>{phase === "done" ? "讫" : "记"}</div>
        <div className="masthead-text">
          <h1>Bean Import <span className="thin">· 账单过账</span></h1>
          <div className="subtitle">
            支付宝 · 微信 · 云闪付 · 银行流水（中行 农行 浙商 浦发 工行 建行）→ beancount
          </div>
        </div>
        <button className="help-toggle" onClick={() => setHelpOpen(!helpOpen)}>
          📖 使用说明 {helpOpen ? "▲" : "▼"}
        </button>
      </header>

      {helpOpen && (
        <div className="help-body">
          <section>
            <h3>1️⃣ 上传账单</h3>
            <p>把导出的账单文件拖进虚线框（可多选）。支持：</p>
            <ul>
              <li><b>支付宝</b>：交易明细 CSV（GBK 编码，官网/App 导出的标准格式）</li>
              <li><b>微信支付</b>：账单 CSV / XLSX</li>
              <li><b>云闪付</b>：交易记录 CSV / XLSX</li>
              <li><b>银行流水</b>：中行 / 农行 / 浙商 / 浦发 / 工行 / 建行的 CSV、XLSX、PDF</li>
            </ul>
            <p className="muted">文件名带银行关键词（如「工行」「icbc」）识别更准；没有也能靠表头自动识别。</p>
          </section>
          <section>
            <h3>2️⃣ 审阅交易</h3>
            <ul>
              <li><b>入账 ✓</b>：勾选 = 会写入账本；重复或误识别的可取消勾选</li>
              <li><b>分类账户</b>：按「记忆映射 → 账本历史 → 规则 → AI」推荐，<span className="badge low">黄色</span>边框为低置信度，建议手动确认</li>
              <li><b>资金账户</b>：钱从哪个账户出（银行卡 / 余额 / 零钱），多卡场景请核对</li>
              <li><b>重复</b>：同一笔消费同时出现在支付宝和银行流水里，只保留信息最全的一条</li>
              <li><b>转账配对</b>：信用卡还款等两条腿自动合并为一笔转账，不再虚增收支</li>
            </ul>
            <p>手动改过的分类会被记住，下次同一商户自动应用。表头可点击排序，按 <code>/</code> 聚焦搜索。</p>
          </section>
          <section>
            <h3>3️⃣ 生成 & 写入</h3>
            <ul>
              <li>按月分卷追加到 <code>data/YYYYMM.beancount</code></li>
              <li>银行流水自动生成 <code>balance assertion</code>（余额断言）</li>
              <li>缺失账户自动补 <code>open</code> 指令，自动维护 <code>include</code></li>
            </ul>
          </section>
          <section>
            <h3>4️⃣ 校验 & 查看</h3>
            <p>写入完成后可一键 <b>bean-check 校验</b>（需本机安装 beancount）和 <b>启动 Fava</b>（:5000 报表）。重复导入同一批文件是安全的：已入账交易标记「已在账本」自动跳过。</p>
          </section>
          <section>
            <h3>⚙️ 配置</h3>
            <p>账户映射（多卡、借记/信用卡区分）、分类账户列表、LLM API 在服务端 <code>server-data/config.json</code>。信用卡还款配对需把信用卡账户配置为 <code>Liabilities:CC:xxx</code>。</p>
          </section>
        </div>
      )}

      {error && <div className="card" style={{ borderColor: "var(--seal)" }}>{error}</div>}

      {/* ===== upload ===== */}
      {phase === "upload" && (
        <div className="card">
          <div
            className={`dropzone${dragOver ? " over" : ""}`}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => { e.preventDefault(); setDragOver(false); void handleFiles(e.dataTransfer.files); }}
            onClick={() => fileRef.current?.click()}
          >
            <div className="dz-glyph">{busy ? "…" : "账"}</div>
            <div className="dz-main">{busy ? "解析中——识别账单类型、去重、分类…" : "拖拽账单文件到此处，或点击选择（支持多选）"}</div>
            {!busy && (
              <>
                <div className="dz-sub">CSV / XLSX / PDF · 自动识别 GBK / UTF-8 编码</div>
                <div className="fmt-tags">
                  <span className="fmt-tag">支付宝</span>
                  <span className="fmt-tag">微信支付</span>
                  <span className="fmt-tag">云闪付</span>
                  <span className="fmt-tag">工行</span>
                  <span className="fmt-tag">建行</span>
                  <span className="fmt-tag">中行</span>
                  <span className="fmt-tag">农行</span>
                  <span className="fmt-tag">浙商</span>
                  <span className="fmt-tag">浦发</span>
                </div>
              </>
            )}
          </div>
          <input
            ref={fileRef}
            type="file"
            multiple
            accept=".csv,.xlsx,.xls,.pdf"
            hidden
            onChange={(e) => void handleFiles(e.target.files)}
          />
        </div>
      )}

      {/* ===== stats ===== */}
      {summary && phase !== "upload" && (
        <div className="card">
          <div className="stats">
            <div className="stat"><div className="num">{summary.preview.txCount}</div><div className="lbl">解析交易</div></div>
            <div className="stat warn"><div className="num">{summary.preview.dedup.crossSourceDuplicates}</div><div className="lbl">跨账单重复</div></div>
            <div className="stat warn"><div className="num">{summary.preview.dedup.ledgerDuplicates}</div><div className="lbl">已在账本</div></div>
            {summary.preview.dedup.transferPairs != null && summary.preview.dedup.transferPairs > 0 && (
              <div className="stat good"><div className="num">{summary.preview.dedup.transferPairs}</div><div className="lbl">转账配对</div></div>
            )}
            <div className="stat good"><div className="num">{stats.ready}</div><div className="lbl">已就绪</div></div>
            <div className="stat"><div className="num">{stats.pending}</div><div className="lbl">待确认</div></div>
            <div className="stat sums">
              <div className="num">
                <span className="in">+{fmt(stats.sums.in)}</span>
                <span className="out">−{fmt(stats.sums.out)}</span>
              </div>
              <div className="lbl">就绪收支合计</div>
            </div>
          </div>
          {summary.preview.accountsDetected.length > 1 && (
            <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
              ⚠️ 检测到 {summary.preview.accountsDetected.length} 种支付方式/账户（多卡场景），
              请逐笔核对资金账户，或在 config 中配置卡号后缀映射。
            </div>
          )}
          {summary.preview.errors.length > 0 && (
            <details style={{ marginTop: 8 }}>
              <summary className="muted" style={{ fontSize: 12, cursor: "pointer" }}>
                {summary.preview.errors.length} 条解析警告
              </summary>
              {summary.preview.errors.slice(0, 20).map((e, i) => (
                <div key={i} className="error-line">行 {e.row}: {e.message}</div>
              ))}
            </details>
          )}
        </div>
      )}

      {/* ===== review table ===== */}
      {(phase === "review" || phase === "preview") && batch && (
        <div className="card">
          <div className="toolbar">
            <button className="btn" onClick={() => void acceptAllHighConfidence()} disabled={pendingHigh === 0}>
              ✓ 一键接受高置信度 ({pendingHigh})
            </button>
            <div className="spacer" />
            <button className="btn primary" onClick={() => void doGenerate()} disabled={busy || stats.ready === 0}>
              生成 beancount ({stats.ready})
            </button>
          </div>

          <div className="tabs">
            {STATUS_TABS.map(({ key, label }) => (
              <div
                key={key}
                className={`tab${statusFilter === key ? " active" : ""}`}
                onClick={() => setStatusFilter(key)}
              >
                {label}
                <span className="count">{key === "all" ? txs.length : txs.filter((t) => t.status === key).length}</span>
              </div>
            ))}
          </div>

          <div className="filter-row">
            <input
              ref={searchRef}
              placeholder="搜索商户 / 备注 / 金额 / 支付方式…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            <span className="kbd-hint"><kbd>/</kbd> 聚焦 · <kbd>Esc</kbd> 清空</span>
          </div>

          {visible.length === 0 ? (
            <div className="empty">
              <div className="glyph">空</div>
              <div>{filter ? "没有匹配的交易" : "此状态下没有交易"}</div>
              <div className="hint">{filter && <>按 <kbd>/</kbd> 重新搜索，或切换标签页</>}</div>
            </div>
          ) : (
            <div className="table-scroll">
              <table className="tx">
                <thead>
                  <tr>
                    <th>入账</th>
                    <th className="sortable" onClick={() => clickSort("date")}>日期{sortIndicator("date")}</th>
                    <th className="sortable" onClick={() => clickSort("payee")}>商户 / 说明{sortIndicator("payee")}</th>
                    <th className="sortable" onClick={() => clickSort("amount")}>金额{sortIndicator("amount")}</th>
                    <th>分类账户</th>
                    <th>资金账户</th>
                    <th className="sortable" onClick={() => clickSort("confidence")}>依据{sortIndicator("confidence")}</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((t, i) => (
                    <tr
                      key={t.id}
                      className={[
                        t.status === "excluded" ? "excluded-row" : "",
                        t.status === "duplicate" ? "dup-row" : "",
                        "row-in",
                      ].join(" ")}
                      style={{ animationDelay: `${Math.min(i, 20) * 15}ms` }}
                    >
                      <td>
                        <input
                          className="checkbox"
                          type="checkbox"
                          checked={t.status === "ready"}
                          onChange={() => void toggleStatus(t)}
                        />
                      </td>
                      <td className="tx-date">
                        {t.date}
                        {t.time && <span className="time">{t.time}</span>}
                      </td>
                      <td>
                        <div className="payee">{t.payee || <span className="muted">(无商户)</span>}</div>
                        {t.note && <div className="tx-note">{t.note}</div>}
                        {t.status === "duplicate" && t.duplicateOf && (
                          <div className="badge dup">重复 · {t.duplicateOf.label}</div>
                        )}
                        {t.fundingAccount2 && (
                          <div className="badge pair">转账 · {t.fundingAccount} → {t.fundingAccount2}</div>
                        )}
                      </td>
                      <td className={`amt ${t.direction}`}>
                        <span className="dir">{t.direction === "in" ? "收" : "支"}</span>
                        {fmt(t.amount)}
                      </td>
                      <td>
                        <select
                          className={`account-select${t.confidence < 0.7 ? " low" : ""}`}
                          value={t.finalAccount || t.suggestedAccount}
                          onChange={(e) => void setAccount(t, e.target.value)}
                        >
                          {accountOptions.map((a) => (
                            <option key={a} value={a}>{a}</option>
                          ))}
                        </select>
                        <div className="meter-row">
                          <span className="meter">
                            <i
                              className={t.confidence >= 0.9 ? "hi" : t.confidence >= 0.7 ? "mid" : "lo"}
                              style={{ width: `${Math.round(t.confidence * 100)}%` }}
                            />
                          </span>
                          <span className="conf-text">{Math.round(t.confidence * 100)}%</span>
                        </div>
                        {t.reason && <div className="reason">{t.reason}</div>}
                      </td>
                      <td>
                        <select
                          className="account-select"
                          value={t.fundingAccount}
                          onChange={(e) => patchTx(t.id, { fundingAccount: e.target.value })}
                        >
                          {accountOptions.map((a) => (
                            <option key={a} value={a}>{a}</option>
                          ))}
                        </select>
                      </td>
                      <td className="raw-src">{t.rawAccount.slice(0, 20)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ===== preview ===== */}
      {(phase === "preview" || phase === "done") && (
        <div className="card">
          <div className="toolbar">
            <strong>生成结果</strong>
            {Object.keys(monthFiles).map((m) => (
              <span key={m} className="month-chip">{m.slice(0, 4)}-{m.slice(4)}.beancount</span>
            ))}
            <div className="spacer" />
            {phase === "preview" ? (
              <>
                <button className="btn" onClick={() => void doGenerate()}>重新生成</button>
                <button className="btn primary" onClick={() => void doCommit()} disabled={busy}>
                  ⬇ 写入账本
                </button>
              </>
            ) : (
              <span style={{ color: "var(--green)", fontWeight: 500 }}>✅ 已写入账本</span>
            )}
          </div>
          {opens.length > 0 && (
            <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
              将自动补充 {opens.length} 条 open 指令：{opens.join("；")}
            </div>
          )}
          <pre className="code" style={{ marginTop: 12 }}>{highlight(entries)}</pre>
        </div>
      )}

      {/* ===== done ===== */}
      {phase === "done" && (
        <div className="card done-banner">
          <div className="seal green" style={{ animation: "stamp-in 0.5s cubic-bezier(0.2, 1.4, 0.4, 1) both" }}>讫</div>
          <div className="msg">
            <div className="big">过账完成</div>
            <div className="sub">
              重新导入同一批文件是安全的：已入账交易会标记「已在账本」自动跳过。
            </div>
          </div>
        </div>
      )}

      {phase === "done" && (
        <div className="card">
          <div className="toolbar">
            <button
              className="btn"
              onClick={async () => setValidateResult((await api.validate()).output)}
            >
              🔍 bean-check 校验
            </button>
            <button
              className="btn"
              onClick={async () => {
                const r = await api.fava();
                setFavaMsg(r.running ? `Fava: http://localhost:${r.port}` : (r.error ?? "启动失败"));
              }}
            >
              📊 启动 Fava
            </button>
            <div className="spacer" />
            <button className="btn primary" onClick={reset}>继续导入下一批</button>
          </div>
          {validateResult && <pre className="code" style={{ marginTop: 12, maxHeight: 160 }}>{validateResult}</pre>}
          {favaMsg && <div className="muted" style={{ marginTop: 10 }}>{favaMsg}</div>}
        </div>
      )}
    </div>
  );
}
