import { isYuebaoInterestDescription } from "./alipay.js";
import { transactionPostings } from "./postings.js";
import type { AppConfig, ImportStatementKind, ParsedTx, SourceType } from "./types.js";

export type ImportLayout = Pick<AppConfig, "monthlyDir" | "annualLayout" | "statementDirectories">;

export const importStatementKinds = {
  "yuebao-interest": { label: "余额宝收益", exampleSource: "alipay" },
  alipay: { label: "支付宝账单", exampleSource: "alipay" },
  wechat: { label: "微信支付账单", exampleSource: "wechat" },
  yunshanfu: { label: "云闪付账单", exampleSource: "yunshanfu" },
  bank: { label: "银行账单", exampleSource: "bank-cmb" },
} satisfies Record<ImportStatementKind, { label: string; exampleSource: SourceType }>;

export function importDirectoryError(template: string): string | undefined {
  const sample = template.replace(/\{(?:year|month|source|account)\}/g, "value");
  if (/[{}]/.test(sample)) return "导入子目录仅支持 {year}、{month}、{source}、{account} 变量";
  if (/^[/\\~$]|[\x00-\x1f<>:"|?*\[\]]/.test(sample) || sample.split(/[/\\]/).some((part) => part !== "." && /[. ]$/.test(part))) {
    return "导入子目录必须是账本内的有效相对路径";
  }
}

export function importLayoutError(layout: ImportLayout): string | undefined {
  const defaultError = importDirectoryError(layout.monthlyDir);
  if (defaultError) return defaultError;
  const directories = layout.statementDirectories;
  if (directories === undefined) return;
  if (!directories || typeof directories !== "object" || Array.isArray(directories)) return "按账单种类指定目录的设置无效";
  for (const [kind, directory] of Object.entries(directories)) {
    if (!Object.hasOwn(importStatementKinds, kind) || typeof directory !== "string") return "账单种类或保存目录无效";
    const error = importDirectoryError(directory);
    if (error) return `${importStatementKinds[kind as ImportStatementKind].label} · ${error}`;
  }
}

export function importTarget(layout: ImportLayout, date: string, source: string, account: string, template = layout.monthlyDir): string {
  const year = date.slice(0, 4), month = date.slice(5, 7);
  const variables = { year, month, source: source.replace(/[^a-z0-9-]/gi, "_"), account: account.replaceAll(":", "_") };
  const directory = template.replace(/\{(year|month|source|account)\}/g, (_, key: keyof typeof variables) => variables[key]);
  const filename = layout.annualLayout ? `${year}-${month}.bean` : `${year}${month}.beancount`;
  const segments = directory.split(/[/\\]/).filter((segment) => segment && segment !== ".");
  return [...segments, filename].join("/");
}

function statementDirectoryKind(layout: ImportLayout, tx: ParsedTx): ImportStatementKind | undefined {
  const directories = layout.statementDirectories;
  if (!directories) return;
  if (tx.source === "alipay") {
    if (directories["yuebao-interest"] && tx.eventType === "income" && tx.direction === "in" && tx.rawAccount === "余额宝"
      && isYuebaoInterestDescription(tx.note.split(" · ", 1)[0])) return "yuebao-interest";
    return directories.alipay ? "alipay" : undefined;
  }
  if (tx.source === "wechat" || tx.source === "yunshanfu") return directories[tx.source] ? tx.source : undefined;
  if (tx.source.startsWith("bank-") && directories.bank) return "bank";
}

export function importFundingAccount(tx: ParsedTx, postings = transactionPostings(tx)): string {
  if (tx.merge) return tx.fundingAccount || "merged";
  return postings.find((posting) => posting.account === tx.fundingAccount)?.account
    ?? postings.find((posting) => /^(Assets|Liabilities):/.test(posting.account))?.account
    ?? postings[0]?.account ?? "";
}

export function transactionImportTarget(layout: ImportLayout, tx: ParsedTx, {
  account, date = tx.date, members = [tx],
}: { account: string; date?: string; members?: readonly (ParsedTx | undefined)[] }): { file: string; kinds: ImportStatementKind[] } {
  const matches = members.flatMap((member) => {
    if (!member) return [];
    const kind = statementDirectoryKind(layout, member);
    const directory = kind && layout.statementDirectories?.[kind];
    return kind && directory ? [{ kind, file: importTarget(layout, date, member.source, account, directory) }] : [];
  });
  const first = matches[0];
  if (first && matches.length === members.length && matches.every(({ file }) => file === first.file)) {
    return { file: first.file, kinds: [...new Set(matches.map(({ kind }) => kind))] };
  }
  return { file: importTarget(layout, date, tx.source, account), kinds: [] };
}
