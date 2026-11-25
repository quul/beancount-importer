import { useId, useState } from "react";
import type { AutomaticExclusionRule } from "../../src/shared/types.js";
import { api } from "./api";
import type { ExclusionFilter } from "./reviewRows";

const filters: Array<{ key: ExclusionFilter; label: string }> = [
  { key: "excluded", label: "全部" },
  { key: "excluded:manual", label: "手动排除" },
  { key: "excluded:automatic", label: "自动排除" },
  { key: "excluded:deduplicate", label: "重复剔除" },
];

export default function ExclusionFilters({ value, count, onChange }: {
  value: ExclusionFilter;
  count: (filter: ExclusionFilter) => number;
  onChange: (filter: ExclusionFilter) => void;
}) {
  const rulesId = useId();
  const [open, setOpen] = useState(false);
  const [rules, setRules] = useState<AutomaticExclusionRule[] | "loading" | "error">();
  const loadRules = () => {
    setRules("loading");
    void api.exclusionRules().then(setRules, () => setRules("error"));
  };

  return <div className="exclusion-controls">
    <nav className="tabs" aria-label="筛选排除原因">
      {filters.map(({ key, label }) => <button key={key} type="button"
        className={`tab${value === key ? " active" : ""}`} aria-pressed={value === key}
        onClick={() => onChange(key)}>{label}<span className="count">{count(key)}</span></button>)}
    </nav>
    <button type="button" className="btn small quiet" aria-expanded={open} aria-controls={open ? rulesId : undefined}
      onClick={() => {
        setOpen(!open);
        if (!open && !rules) loadRules();
      }}>{open ? "收起自动排除规则" : "查看自动排除规则"}</button>
    {open && <section className="exclusion-rules" id={rulesId} aria-label="自动排除规则">
      {rules === "loading" && <p className="muted" role="status">正在加载规则…</p>}
      {rules === "error" && <div className="toolbar">
        <p role="status">暂时无法读取排除规则。</p><button type="button" className="btn small" onClick={loadRules}>重试</button>
      </div>}
      {Array.isArray(rules) && <ul>
        {rules.map(({ source, title, description }, index) => <li key={`${source}:${index}`}>
          <div><strong>{title}</strong><span className="muted">{source}</span></div>
          {description && <p>{description}</p>}
        </li>)}
      </ul>}
    </section>}
  </div>;
}
