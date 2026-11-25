import type { AppConfig } from "./types.js";

export type ImportLayout = Pick<AppConfig, "monthlyDir" | "annualLayout">;

export function importDirectoryError(template: string): string | undefined {
  const sample = template.replace(/\{(?:year|month|source|account)\}/g, "value");
  if (/[{}]/.test(sample)) return "导入子目录仅支持 {year}、{month}、{source}、{account} 变量";
  if (/^[/\\~$]|[\x00-\x1f<>:"|?*\[\]]/.test(sample) || sample.split(/[/\\]/).some((part) => part !== "." && /[. ]$/.test(part))) {
    return "导入子目录必须是账本内的有效相对路径";
  }
}

export function importTarget(layout: ImportLayout, date: string, source: string, account: string): string {
  const year = date.slice(0, 4), month = date.slice(5, 7);
  const variables = { year, month, source: source.replace(/[^a-z0-9-]/gi, "_"), account: account.replaceAll(":", "_") };
  const directory = layout.monthlyDir.replace(/\{(year|month|source|account)\}/g, (_, key: keyof typeof variables) => variables[key]);
  const filename = layout.annualLayout ? `${year}-${month}.bean` : `${year}${month}.beancount`;
  const segments = directory.split(/[/\\]/).filter((segment) => segment && segment !== ".");
  return [...segments, filename].join("/");
}
