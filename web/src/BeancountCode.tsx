import { Fragment } from "react";
import { accountPattern, currencyPattern } from "../../src/shared/postings.js";

const moneyLine = /^(?:[ \t]+|\d{4}-\d{2}-\d{2} balance )(\S+)[ \t]+-?\d+(?:\.\d+)?[ \t]+(\S+)$/;

export default function BeancountCode({ text, className }: { text: string; className: string }) {
  const lines = text.split("\n");
  return <pre className={className} tabIndex={0}><code>{lines.map((line, index) => {
    const newline = index < lines.length - 1 ? "\n" : "";
    const match = moneyLine.exec(line);
    if (!match || !accountPattern.test(match[1]) || !currencyPattern.test(match[2])) return line + newline;
    return <Fragment key={index}><span className="entry-amount-line">{line}</span>{newline}</Fragment>;
  })}</code></pre>;
}
