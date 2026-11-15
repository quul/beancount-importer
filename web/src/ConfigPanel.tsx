import { useState } from "react";
import type { AppConfig, ParsedAccount } from "../../src/shared/types.js";
import { AccountSelect } from "./ReviewEditor";

export default function ConfigPanel({ config, accounts, disabled, onSave }: {
  config: AppConfig; accounts: ParsedAccount[]; disabled: boolean; onSave: (config: Partial<AppConfig>) => Promise<void>;
}) {
  const [values, setValues] = useState({ ledgerRoot: config.ledgerRoot, mainFile: config.mainFile, monthlyDir: config.monthlyDir, pythonPath: config.pythonPath ?? "", annualLayout: config.annualLayout ?? true, assetMapping: config.assetMapping });
  return <details className="card settings"><summary>账本设置与资金账户映射</summary>
    <p className="muted">先保存目标账本，再从真实账本账户中配置支付方式映射。银行卡可加尾号区分。</p>
    <fieldset disabled={disabled}>
      <div className="editor-grid">
        <label className="wide">账本目录<input value={values.ledgerRoot} onChange={(event) => setValues({ ...values, ledgerRoot: event.target.value })} /></label>
        <label>主入口<input value={values.mainFile} onChange={(event) => setValues({ ...values, mainFile: event.target.value })} /></label>
        <label>导入子目录<input value={values.monthlyDir} onChange={(event) => setValues({ ...values, monthlyDir: event.target.value })} /></label>
        <label className="wide">Python 路径（留空自动寻找）<input value={values.pythonPath} onChange={(event) => setValues({ ...values, pythonPath: event.target.value })} /></label>
      </div>
      <label className="check-label"><input type="checkbox" checked={values.annualLayout} onChange={(event) => setValues({ ...values, annualLayout: event.target.checked })} />按年度目录及 include 链写入</label>
      <div className="mapping-list">{values.assetMapping.map((mapping, index) => <div className="mapping-row" key={index}>
        <input aria-label={`映射 ${index + 1} 关键词`} value={mapping.keyword} placeholder="支付方式关键词" onChange={(event) => setValues({ ...values, assetMapping: values.assetMapping.map((item, i) => i === index ? { ...item, keyword: event.target.value } : item) })} />
        <input aria-label={`映射 ${index + 1} 卡片尾号`} value={mapping.cardSuffix ?? ""} placeholder="尾号（可选）" onChange={(event) => setValues({ ...values, assetMapping: values.assetMapping.map((item, i) => i === index ? { ...item, cardSuffix: event.target.value } : item) })} />
        <AccountSelect value={mapping.account} accounts={accounts} funding label={`映射 ${index + 1} 资金账户`} onChange={(account) => setValues({ ...values, assetMapping: values.assetMapping.map((item, i) => i === index ? { ...item, account, kind: account.startsWith("Liabilities:") ? "credit" : "debit" } : item) })} />
        <button className="btn small" onClick={() => setValues({ ...values, assetMapping: values.assetMapping.filter((_, i) => i !== index) })}>移除</button>
      </div>)}</div>
      <div className="toolbar"><button className="btn small" onClick={() => setValues({ ...values, assetMapping: [...values.assetMapping, { keyword: "", account: "", kind: "debit" }] })}>＋ 添加资金映射</button><button className="btn primary" onClick={() => void onSave(values)} disabled={!values.ledgerRoot.trim() || !values.mainFile.trim()}>保存设置并读取账本</button></div>
    </fieldset>
    {disabled && <p className="muted">审阅批次期间不能切换账本设置；返回批次列表后可修改。</p>}
  </details>;
}
