import { useEffect, useRef, useState } from "react";
import { importDirectoryError, importDirectoryRule, importLayoutError, importStatementKinds, importTarget, importTargetTemplate } from "../../src/shared/import-paths.js";
import type { AppConfig, ImportStatementKind, ParsedAccount } from "../../src/shared/types.js";
import AccountSelect from "./AccountSelect";
import { api, ApiError, type ConfigResponse, type PathField } from "./api";

export const SETTINGS_LINKS = { ledger: "#/settings", funding: "#/settings/funding", directories: "#/settings/statement-directories" } as const;
export type SettingsSection = keyof typeof SETTINGS_LINKS;

function formValues(config: AppConfig) {
  return {
    ledgerRoot: config.ledgerRoot, mainFile: config.mainFile, monthlyDir: config.monthlyDir,
    statementDirectories: config.statementDirectories ?? {},
    pythonPath: config.pythonPath ?? "", annualLayout: config.annualLayout ?? true,
    archiveUploadsInLedger: config.archiveUploadsInLedger ?? true, assetMapping: config.assetMapping,
  };
}

export default function ConfigPanel({ section, config, accounts, busy, lockedByDrafts, onSave }: {
  section: SettingsSection | null;
  config: ConfigResponse;
  accounts: ParsedAccount[];
  busy: boolean;
  lockedByDrafts: boolean;
  onSave: (config: Partial<AppConfig>) => Promise<ConfigResponse | undefined>;
}) {
  const [values, setValues] = useState(() => formValues(config));
  const previousMappings = useRef(config.assetMapping);
  const directorySummary = useRef<HTMLElement>(null);
  const [picking, setPicking] = useState<PathField | null>(null);
  const [pickerError, setPickerError] = useState<{ field: PathField; message: string } | null>(null);
  useEffect(() => {
    const previous = previousMappings.current;
    if (previous === config.assetMapping) return;
    previousMappings.current = config.assetMapping;
    const exactKey = ({ keyword, source }: AppConfig["assetMapping"][number]) => `${source ?? ""}:${keyword.trim().normalize("NFKC").toLowerCase()}`;
    const changed = config.assetMapping.filter((mapping) => mapping.exact && !previous.some((item) => item.exact && exactKey(item) === exactKey(mapping) && item.account === mapping.account));
    const keys = new Set(changed.map(exactKey));
    setValues((current) => ({ ...current, assetMapping: current.assetMapping === previous ? config.assetMapping
      : [...current.assetMapping.filter((mapping) => !mapping.exact || !keys.has(exactKey(mapping))), ...changed] }));
  }, [config.assetMapping]);
  useEffect(() => {
    if (section === "directories") directorySummary.current?.focus();
  }, [section]);

  if (!section) return null;

  const funding = section === "funding";
  const today = new Date();
  const exampleYear = today.getFullYear(), exampleMonth = today.getMonth() + 1;
  const exampleDate = `${exampleYear}-${String(exampleMonth).padStart(2, "0")}-01`;
  const directoryError = importDirectoryError(values.monthlyDir);
  const layoutError = importLayoutError(values);
  const examplePath = directoryError ? undefined : importTarget(values, exampleDate, "alipay", "Assets:Bank");
  async function save() {
    if (funding) {
      const saved = await onSave({ assetMapping: values.assetMapping });
      if (saved) setValues((current) => ({ ...current, assetMapping: saved.assetMapping }));
      return;
    }
    const original = formValues(config);
    const changed = Object.entries(values).filter(([key, value]) => key !== "assetMapping"
      && (key === "statementDirectories"
        ? JSON.stringify(original.statementDirectories) !== JSON.stringify(value)
        : original[key as keyof typeof original] !== value));
    const saved = await onSave(Object.fromEntries(changed));
    if (saved) setValues((current) => ({ ...formValues(saved), assetMapping: current.assetMapping }));
  }

  function updateMapping(index: number, patch: Partial<AppConfig["assetMapping"][number]>) {
    setValues((current) => ({ ...current, assetMapping: current.assetMapping.map((mapping, row) => row === index ? { ...mapping, ...patch } : mapping) }));
  }

  function updateDirectory(kind: ImportStatementKind, value: string) {
    setValues((current) => {
      const statementDirectories = { ...current.statementDirectories };
      if (value) statementDirectories[kind] = value;
      else delete statementDirectories[kind];
      return { ...current, statementDirectories };
    });
  }

  async function pick(field: PathField) {
    setPicking(field);
    setPickerError(null);
    try {
      const selected = await api.pickPath(field, values[field], values.ledgerRoot);
      if (selected.path !== null) setValues((previous) => ({ ...previous, [field]: selected.path }));
    } catch (error) {
      setPickerError({ field, message: error instanceof ApiError ? error.message : "无法打开路径选择窗口。你可以手动输入路径。" });
    } finally {
      setPicking(null);
    }
  }
  function pathInput(field: PathField, label: string, action: string) {
    const error = pickerError?.field === field ? pickerError.message : undefined;
    return <div className="wide">
      <label htmlFor={field}>{label}</label>
      <div className="settings-path">
        <input id={field} value={values[field]} readOnly={picking === field} aria-describedby={error ? `${field}-error` : undefined} onChange={(event) => setValues({ ...values, [field]: event.target.value })} />
        {config.nativePathPicker && <button type="button" className="btn" disabled={picking !== null} aria-label={`${action}（${label}）`} aria-busy={picking === field} onClick={() => void pick(field)}>{picking === field ? "选择中…" : action}</button>}
      </div>
      {error && <p id={`${field}-error`} className="error-line" role="alert">{error}</p>}
    </div>;
  }

  return <div className="settings-layout">
    <aside className="settings-sidebar">
      <h2>设置</h2>
      <nav aria-label="设置分类">
        <a href={SETTINGS_LINKS.ledger} aria-current={!funding ? "page" : undefined}>账本设置</a>
        <a href={SETTINGS_LINKS.funding} aria-current={funding ? "page" : undefined}>资金映射</a>
      </nav>
    </aside>
    <section className="card settings-panel" aria-labelledby="settings-panel-title">
      <h2 id="settings-panel-title">{funding ? "资金映射" : "账本设置"}</h2>
      {lockedByDrafts && <p className="draft-notice">保存或放弃当前交易的编辑后即可修改设置。</p>}
      {funding && !config.ledgerRoot && <p className="muted">先保存账本设置，再添加资金映射。</p>}
      <fieldset disabled={busy || lockedByDrafts || (funding && !config.ledgerRoot)}>
        {funding ? <>
          <div className="mapping-list">
            {values.assetMapping.length ? <div className="mapping-row mapping-head" aria-hidden="true">
              <span>付款方式</span><span>匹配规则</span><span>对应账本账户</span>
            </div> : <p className="muted">暂无资金映射。</p>}
            {values.assetMapping.map((mapping, index) => <div className="mapping-row" role="group" aria-label={`资金映射 ${index + 1}`} key={index}>
              <label className="mapping-field">
                <span>付款方式</span>
                <input aria-label={`映射 ${index + 1} 付款方式`} value={mapping.keyword} placeholder="支付方式关键词"
                  onChange={(event) => updateMapping(index, { keyword: event.target.value })} />
              </label>
              {mapping.exact ? <small>完整匹配{mapping.source ? ` · ${mapping.source}` : ""}</small> : <label className="mapping-field">
                <span>卡片尾号</span>
                <input aria-label={`映射 ${index + 1} 卡片尾号`} value={mapping.cardSuffix ?? ""} placeholder="卡片尾号（可选）" inputMode="numeric"
                  onChange={(event) => updateMapping(index, { cardSuffix: event.target.value })} />
              </label>}
              <div className="mapping-field mapping-account">
                <span>对应账本账户</span>
                <AccountSelect value={mapping.account} accounts={accounts} funding label={`映射 ${index + 1} 账本账户`}
                  onChange={(account) => updateMapping(index, { account, kind: account.startsWith("Liabilities:") ? "credit" : "debit" })} />
              </div>
              <button type="button" className="btn small" onClick={() => setValues((current) => ({
                ...current, assetMapping: current.assetMapping.filter((_, row) => row !== index),
              }))}>移除</button>
            </div>)}
          </div>
          <div className="toolbar settings-actions">
            <button type="button" className="btn" onClick={() => setValues((current) => ({
              ...current, assetMapping: [...current.assetMapping, { keyword: "", account: "", kind: "debit" }],
            }))}>添加资金映射</button>
            <button type="button" className="btn primary" onClick={() => void save()}>保存资金映射</button>
          </div>
        </> : <>
          <div className="editor-grid">
            {pathInput("ledgerRoot", "账本目录", "选择文件夹")}
            <label>主入口<input value={values.mainFile} onChange={(event) => setValues({ ...values, mainFile: event.target.value })} /></label>
            {pathInput("pythonPath", "Python 路径（可选）", "选择文件")}
          </div>
          <section className="settings-destination" aria-labelledby="settings-destination-heading">
            <h3 id="settings-destination-heading">分录保存位置</h3>
            <small>以 {exampleYear} 年 {exampleMonth} 月为例，路径相对于账本目录。</small>
            <output id="import-path-example" className={directoryError ? "error-line" : undefined}>
              {directoryError ?? <code>{examplePath}</code>}
            </output>
            <details className="settings-disclosure">
              <summary>修改保存目录</summary>
              <label htmlFor="import-directory">保存目录</label>
              <input id="import-directory" value={values.monthlyDir} aria-invalid={directoryError ? true : undefined}
                aria-describedby={directoryError ? "import-directory-variables import-path-example" : "import-directory-variables"}
                onChange={(event) => setValues({ ...values, monthlyDir: event.target.value })} />
              <small id="import-directory-variables" className="settings-variables">
                <span><code>{"{year}"}</code> 年份</span>
                <span><code>{"{month}"}</code> 月份</span>
                <span><code>{"{source}"}</code> 来源（alipay）</span>
                <span><code>{"{account}"}</code> 资金账户（Assets_Bank）</span>
              </small>
            </details>
          </section>
          <details className="settings-disclosure statement-directory-settings" open={section === "directories" || undefined}>
            <summary ref={directorySummary}>按账单种类指定目录</summary>
            <div className="statement-directory-rules">
              {(Object.keys(importStatementKinds) as ImportStatementKind[]).map((kind) => {
                const { label, exampleSource } = importStatementKinds[kind];
                const template = values.statementDirectories[kind] ?? "";
                const destination = importDirectoryRule(values, kind);
                const error = importDirectoryError(destination.template);
                const id = `statement-directory-${kind}`;
                const target = template ? importTarget(values, exampleDate, exampleSource, "Assets:Bank", destination.template)
                  : importTargetTemplate(values, destination.template);
                return <div className="statement-directory-rule" key={kind}>
                  <label htmlFor={id}>{label}</label>
                  <input id={id} value={template} placeholder="填写目录（可选）" aria-invalid={template && error ? true : undefined}
                    aria-describedby={`${id}-example`} onChange={(event) => updateDirectory(kind, event.target.value)} />
                  <output id={`${id}-example`} className={error ? "error-line" : undefined}>
                    {!template && !error && <span className="muted">留空时写入 </span>}
                    {error ?? <code>{target}</code>}
                  </output>
                  {kind === "yuebao-interest" && <details className="statement-recognition-rule">
                    <summary>查看余额宝收益识别规则</summary>
                    <ul>
                      <li>来源是支付宝账单，交易被识别为收入。</li>
                      <li>账单的收付款方式是「余额宝」。</li>
                      <li>商品说明采用 <code>余额宝-{exampleYear}.{String(exampleMonth).padStart(2, "0")}.01-收益发放</code> 这样的格式。</li>
                    </ul>
                    <p>支付宝标为「不计收支」的流水，如果类别为「投资理财」、状态为「交易成功」且收益金额大于零，也会识别为收入。</p>
                  </details>}
                </div>;
              })}
            </div>
          </details>
          <details className="settings-disclosure settings-advanced">
            <summary>高级设置</summary>
            <label className="check-label"><input type="checkbox" checked={values.annualLayout} aria-describedby="annual-layout-help"
              onChange={(event) => setValues({ ...values, annualLayout: event.target.checked })} />使用年度索引</label>
            <small id="annual-layout-help">开启后，每年生成一个索引文件，主账本通过它读取月度分录。</small>
          </details>
          <label className="settings-switch">
            <span>
              <span id="archive-uploads-label">账单副本随账本保存</span>
              <small id="archive-uploads-location">{values.archiveUploadsInLedger ? <>账本目录下的 <code>uploads</code></> : "应用的上传目录"}</small>
            </span>
            <input type="checkbox" role="switch" aria-labelledby="archive-uploads-label" aria-describedby="archive-uploads-location"
              checked={values.archiveUploadsInLedger} onChange={(event) => setValues({ ...values, archiveUploadsInLedger: event.target.checked })} />
          </label>
          <div className="toolbar settings-actions">
            <button type="button" className="btn primary" onClick={() => void save()}
              disabled={picking !== null || !values.ledgerRoot.trim() || !values.mainFile.trim() || Boolean(layoutError)}>保存账本设置</button>
          </div>
        </>}
      </fieldset>
    </section>
  </div>;
}
