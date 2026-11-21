import { useEffect, useRef, useState } from "react";
import type { AppConfig, ParsedAccount } from "../../src/shared/types.js";
import AccountSelect from "./AccountSelect";
import { api, ApiError, type ConfigResponse, type PathField } from "./api";

export const SETTINGS_LINKS = { ledger: "#/settings", funding: "#/settings/funding" } as const;
export type SettingsSection = keyof typeof SETTINGS_LINKS;

function formValues(config: AppConfig) {
  return {
    ledgerRoot: config.ledgerRoot, mainFile: config.mainFile, monthlyDir: config.monthlyDir,
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

  if (!section) return null;

  const funding = section === "funding";
  async function save() {
    if (funding) {
      const saved = await onSave({ assetMapping: values.assetMapping });
      if (saved) setValues((current) => ({ ...current, assetMapping: saved.assetMapping }));
      return;
    }
    const original = formValues(config);
    const changed = Object.entries(values).filter(([key, value]) => key !== "assetMapping" && original[key as keyof typeof original] !== value);
    const saved = await onSave(Object.fromEntries(changed));
    if (saved) setValues((current) => ({ ...formValues(saved), assetMapping: current.assetMapping }));
  }

  function updateMapping(index: number, patch: Partial<AppConfig["assetMapping"][number]>) {
    setValues((current) => ({ ...current, assetMapping: current.assetMapping.map((mapping, row) => row === index ? { ...mapping, ...patch } : mapping) }));
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
        <a href={SETTINGS_LINKS.ledger} aria-current={section === "ledger" ? "page" : undefined}>账本设置</a>
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
            <label>导入子目录<input value={values.monthlyDir} aria-describedby="import-directory-variables" onChange={(event) => setValues({ ...values, monthlyDir: event.target.value })} /></label>
            <small id="import-directory-variables" className="wide settings-variables">
              <span><code>{"{year}"}</code> 年份（2026）</span>
              <span><code>{"{month}"}</code> 月份（01）</span>
              <span><code>{"{source}"}</code> 来源（alipay）</span>
              <span><code>{"{account}"}</code> 资金账户（Assets_Bank）</span>
            </small>
            {pathInput("pythonPath", "Python 路径（可选）", "选择文件")}
          </div>
          <label className="check-label"><input type="checkbox" checked={values.annualLayout} onChange={(event) => setValues({ ...values, annualLayout: event.target.checked })} />按年度目录和 include 链写入</label>
          <label className="settings-switch">
            <span>
              <span id="archive-uploads-label">账单副本随账本保存</span>
              <small id="archive-uploads-location">{values.archiveUploadsInLedger ? <>账本目录下的 <code>uploads</code></> : "应用的上传目录"}</small>
            </span>
            <input type="checkbox" role="switch" aria-labelledby="archive-uploads-label" aria-describedby="archive-uploads-location"
              checked={values.archiveUploadsInLedger} onChange={(event) => setValues({ ...values, archiveUploadsInLedger: event.target.checked })} />
          </label>
          <div className="toolbar settings-actions">
            <button type="button" className="btn primary" onClick={() => void save()} disabled={picking !== null || !values.ledgerRoot.trim() || !values.mainFile.trim()}>保存账本设置</button>
          </div>
        </>}
      </fieldset>
    </section>
  </div>;
}
