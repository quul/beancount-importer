import type { StatementSource } from "../../src/shared/types.js";

export default function StatementSources({ sources }: { sources: StatementSource[] }) {
  if (!sources.length) return null;
  const more = (start: number, compact = false) => {
    const hidden = sources.slice(start);
    return hidden.length > 0 && <span className={"statement-source-chip statement-source-more" + (compact ? " compact" : "")}
      title={hidden.map(({ file }) => file).join("\n")}>+{hidden.length}</span>;
  };
  return <div className="statement-sources">
    <div className="statement-source-line">
      {sources.slice(0, 2).map(({ id, name, file }, index) => <span key={id}
        className={"statement-source-chip" + (index === 1 ? " secondary" : "")} title={file}>{name}</span>)}
      {more(2)}
      {more(1, true)}
    </div>
  </div>;
}
