import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { PDF_REVIEW_ISSUE, type PdfRegion, type RawTx } from "../../shared/types.js";
import { parseAmount, parseDate, txId, type ParseResult } from "./common.js";
import { compactPdfText, loadPdfRules, type PdfRules, type PdfTableRule } from "./pdf-rules.js";

interface TextItem {
  str: string;
  x: number;
  width: number;
  bottom: number;
  top: number;
}
interface TextLine { page: number; y: number; items: TextItem[]; text: string }

export const PDF_RETRY_HINT = "暂时无法读取 PDF。请重新上传，或改用银行导出的 CSV 或 XLSX。";

function joinText(items: readonly TextItem[]): string {
  let text = "", endX: number | undefined;
  for (const { x, width, str } of items) {
    if (endX !== undefined && x - endX > 2) text += " ";
    text += str;
    endX = x + width;
  }
  return text.trim();
}

function openPdf(data: Uint8Array, stopAtErrors = false) {
  // PDF.js calls this API even when only extracting text on an older Node runtime.
  if (!("withResolvers" in Promise)) Object.defineProperty(Promise, "withResolvers", {
    configurable: true,
    writable: true,
    value: function <T>(this: PromiseConstructor) {
      let resolve!: (value: T | PromiseLike<T>) => void;
      let reject!: (reason?: unknown) => void;
      const promise = new this<T>((accept, fail) => { resolve = accept; reject = fail; });
      return { promise, resolve, reject };
    },
  });
  const packageUrl = import.meta.resolve("pdfjs-dist/package.json");
  const assetPath = (folder: string) => fileURLToPath(new URL(`./${folder}/`, packageUrl)).replaceAll("\\", "/");
  return pdfjs.getDocument({
    data: new Uint8Array(data), cMapUrl: assetPath("cmaps"), standardFontDataUrl: assetPath("standard_fonts"),
    wasmUrl: assetPath("wasm"), useWorkerFetch: false, useSystemFonts: true, stopAtErrors,
  });
}

async function extractPages(data: Uint8Array): Promise<TextLine[][]> {
  const task = openPdf(data);
  try {
    const doc = await task.promise;
    const pages: TextLine[][] = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      const rows = new Map<number, TextItem[]>();
      for (const item of content.items) {
        if (!("str" in item) || !item.str.trim()) continue;
        const x = item.transform[4], y = -item.transform[5];
        const height = item.height || Math.hypot(item.transform[2], item.transform[3]);
        const style = content.styles[item.fontName];
        const key = [...rows.keys()].find((rowY) => Math.abs(rowY - y) <= 3) ?? y;
        const items = rows.get(key) ?? [];
        items.push({ str: item.str, x, width: item.width, bottom: -y + height * (style?.descent ?? -0.22), top: -y + height * (style?.ascent ?? 0.9) });
        rows.set(key, items);
      }
      pages.push([...rows.entries()].sort(([a], [b]) => a - b).map(([y, items]) => {
        items.sort((a, b) => a.x - b.x);
        return { page: p, y, items, text: joinText(items) };
      }));
    }
    return pages;
  } finally {
    await task.destroy();
  }
}

function sourceRegions(lines: readonly TextLine[]): PdfRegion[] {
  const pages = new Map<number, PdfRegion["bounds"]>();
  for (const { page, items } of lines) {
    for (const { x, width, bottom, top } of items) {
      const bounds = pages.get(page);
      if (!bounds) {
        pages.set(page, [x, bottom, x + width, top]);
        continue;
      }
      bounds[0] = Math.min(bounds[0], x);
      bounds[1] = Math.min(bounds[1], bottom);
      bounds[2] = Math.max(bounds[2], x + width);
      bounds[3] = Math.max(bounds[3], top);
    }
  }
  return [...pages].map(([page, bounds]) => ({ page, bounds }));
}

type NodeCanvas = HTMLCanvasElement & { toBuffer(type: "image/png"): Buffer };
type CanvasSurface = { canvas: NodeCanvas; context: CanvasRenderingContext2D };
type CanvasFactory = { create(width: number, height: number): CanvasSurface; destroy(surface: CanvasSurface): void };

export async function renderPdfRegions(data: Uint8Array, regions: readonly PdfRegion[]) {
  // PDF.js uses fixed-length transfers when preparing fonts for drawing.
  if (!("transferToFixedLength" in ArrayBuffer.prototype)) Object.defineProperty(ArrayBuffer.prototype, "transferToFixedLength", {
    configurable: true,
    writable: true,
    value: function (this: ArrayBuffer, length = this.byteLength) {
      const copy = new ArrayBuffer(length);
      new Uint8Array(copy).set(new Uint8Array(this, 0, Math.min(this.byteLength, copy.byteLength)));
      structuredClone(this, { transfer: [this] });
      return copy;
    },
  });
  const task = openPdf(data, true);
  try {
    const pdf = await task.promise;
    const factory = pdf.canvasFactory as CanvasFactory;
    const screenshots: Array<{ page: number; image: string }> = [];
    for (const { page: number, bounds } of regions) {
      const page = await pdf.getPage(number);
      const viewport = page.getViewport({ scale: 1 });
      const [x1, y1] = viewport.convertToViewportPoint(bounds[0], bounds[1]);
      const [x2, y2] = viewport.convertToViewportPoint(bounds[2], bounds[3]);
      const left = Math.max(0, Math.min(x1, x2) - 7), top = Math.max(0, Math.min(y1, y2) - 3);
      const width = Math.min(viewport.width, Math.max(x1, x2) + 7) - left;
      const height = Math.min(viewport.height, Math.max(y1, y2) + 3) - top;
      if (!(width > 0 && height > 0)) continue;
      const scale = Math.min(2.5, 1800 / width, 1200 / height);
      const surface = factory.create(Math.ceil(width * scale), Math.ceil(height * scale));
      try {
        await page.render({
          canvas: surface.canvas, canvasContext: surface.context, viewport: page.getViewport({ scale }),
          transform: [1, 0, 0, 1, -left * scale, -top * scale], background: "white",
        }).promise;
        screenshots.push({ page: number, image: `data:image/png;base64,${surface.canvas.toBuffer("image/png").toString("base64")}` });
      } finally {
        factory.destroy(surface);
      }
    }
    return screenshots;
  } finally {
    await task.destroy();
  }
}

function readRowDate(value: string, pattern: RegExp, latest?: string): string | undefined {
  if (!pattern.test(value)) return undefined;
  if (/^\d{4}/.test(value)) return parseDate(value)?.date;
  if (!latest) return undefined;
  const [month, day] = value.replace(/日$/, "").split(/[-/.月]/).map((part) => part.padStart(2, "0"));
  const suffix = `-${month}-${day}`;
  const year = Number(latest.slice(0, 4));
  const thisYear = `${year}${suffix}`;
  return parseDate(thisYear > latest ? `${year - 1}${suffix}` : thisYear)?.date;
}

type Field = PdfTableRule["columns"][number]["field"];
interface ColumnBounds { left: number; right: number; header: string }
type Columns = Map<Field, ColumnBounds>;
interface TableRow { line: TextLine; columns: Columns; traded: string; booked: string; section: string }
type DescribedRow = TableRow & { description: string; evidence: TextLine[] };

function tableColumns(items: TextItem[], rule: PdfTableRule): Columns | undefined {
  const anchors = rule.columns.map(({ header }) => header && items.find(({ str }) => header.test(compactPdfText(str))));
  if (rule.columns.some(({ header }, index) => header && !anchors[index])) return undefined;
  const edges = rule.columns.map(({ fromPreviousRight, offset }, index) => {
    const anchor = anchors[fromPreviousRight ? index - 1 : index]!;
    return anchor.x + (fromPreviousRight ? anchor.width : 0) + offset;
  });
  if (edges.some((left, index) => index > 0 && left <= edges[index - 1])) return undefined;
  return new Map(rule.columns.map(({ field }, index) => [field, {
    left: edges[index], right: edges[index + 1] ?? Infinity, header: compactPdfText(anchors[index]?.str ?? ""),
  }]));
}

function cell(line: TextLine, columns: Columns, field: Field): string {
  const bounds = columns.get(field);
  return bounds ? joinText(line.items.filter(({ x }) => x >= bounds.left && x < bounds.right)) : "";
}

function billingDate(lines: TextLine[], title: string, rule: PdfTableRule["statementDate"]): string | undefined {
  if (!rule) return undefined;
  const billLabel = lines.findIndex(({ text }) => rule.label.test(text));
  const month = title.match(rule.monthInTitle)?.groups;
  let periodEnd: string | undefined;
  if (month?.year && Number(month.month) >= 1 && Number(month.month) <= 12) {
    periodEnd = new Date(Date.UTC(Number(month.year), Number(month.month), 0)).toISOString().slice(0, 10);
  }
  return (billLabel >= 0 ? lines.slice(billLabel, billLabel + rule.lookahead)
    .map(({ text }) => parseDate(text)?.date)
    .find((date) => date && (!periodEnd || date.slice(0, 7) === periodEnd.slice(0, 7))) : undefined) ?? periodEnd;
}

function descriptionLines(page: TextLine[], rows: TableRow[], index: number, window: PdfTableRule["descriptionWindow"]): TextLine[] {
  const { line, columns } = rows[index];
  if (!window) return [line];
  // Centered date/amount cells can sit between two description baselines.
  const center = line.y + window.baselineOffset;
  const previous = rows[index - 1], next = rows[index + 1];
  const before = previous?.columns === columns ? (previous.line.y + line.y) / 2 + window.baselineOffset : -Infinity;
  const after = next?.columns === columns ? (line.y + next.line.y) / 2 + window.baselineOffset : Infinity;
  const first = Math.min(line.y, Math.max(before, center - window.maxDistance));
  const last = Math.max(line.y + 0.01, Math.min(after, center + window.maxDistance));
  const { left, right } = columns.get("description")!;
  return page.filter((candidate) => candidate.y >= first && candidate.y < last
    && (candidate === line || candidate.items.every(({ x }) => x >= left && x < right)));
}

function tableRows(pages: TextLine[][], rule: PdfTableRule): DescribedRow[] {
  const all: DescribedRow[] = [];
  let columns: Columns | undefined;
  let section = "", previousPageLast: DescribedRow | undefined;
  for (const page of pages) {
    const rows: TableRow[] = [];
    for (const line of page) {
      const header = tableColumns(line.items, rule);
      if (header) { columns = header; section = ""; continue; }
      if (!columns) continue;
      const traded = compactPdfText(cell(line, columns, "tradeDate"));
      const booked = compactPdfText(cell(line, columns, "bookDate"));
      if (rule.sections.has(traded) && !booked && !cell(line, columns, "description")) section = traded;
      else if (rule.datePattern.test(traded) || rule.datePattern.test(booked)) rows.push({ line, columns, traded, booked, section });
    }
    const described = rows.map((row, index) => {
      const lines = descriptionLines(page, rows, index, rule.descriptionWindow);
      const carry = rule.descriptionWindow?.pageCarryDistance;
      const text = (line: TextLine) => cell(line, row.columns, "description");
      if (index === 0 && carry && previousPageLast?.columns === row.columns) {
        // On a continued page, a detached description line can belong to the previous page's last row.
        const cutoff = row.line.y - carry;
        const continuation = lines.filter(({ y }) => y <= cutoff);
        const evidence = lines.filter(({ y }) => y > cutoff);
        previousPageLast.description += continuation.map(text).join("");
        previousPageLast.evidence.push(...continuation);
        return { ...row, evidence, description: evidence.map(text).join("") };
      }
      return { ...row, evidence: lines, description: lines.map(text).join("") };
    });
    previousPageLast = described.at(-1);
    all.push(...described);
  }
  return all;
}

function parseTableStatement(file: string, pages: TextLine[][], title: string, rule: PdfTableRule): ParseResult {
  const { source } = rule;
  const errors: ParseResult["errors"] = [];
  const txs: RawTx[] = [];
  const billDate = billingDate(pages.flat(), title, rule.statementDate);
  const rows = tableRows(pages, rule);
  for (const [index, { line, columns, traded, booked, section, description, evidence }] of rows.entries()) {
    const row = index + 1;
    const settled = compactPdfText(cell(line, columns, "amount")).replaceAll("−", "-");
    const parsed = settled.match(rule.amount.pattern)?.groups;
    const amount = parsed?.amount ? parseAmount(parsed.amount) : null;
    const currency = parsed?.currency ?? rule.amount.currencyByHeader.get(columns.get("amount")!.header) ?? rule.amount.currency;
    const postedDate = readRowDate(booked, rule.datePattern, billDate);
    const transactionDate = readRowDate(traded, rule.datePattern, postedDate ?? billDate);
    if (amount === null || !currency || !(postedDate || transactionDate) || !description) {
      errors.push({ row, message: `${rule.name}明细缺少可识别的日期、摘要或记账金额` });
      continue;
    }
    if (amount === 0) continue;
    const direction = amount > 0 ? rule.amount.positiveDirection : rule.amount.positiveDirection === "in" ? "out" : "in";
    const applicable = rule.rules.filter((action) => (!action.section || action.section === section)
      && (!action.description || action.description.test(description)) && (!action.direction || action.direction === direction));
    const date = (applicable.some((action) => action.date === "bookDate") ? postedDate ?? transactionDate : transactionDate ?? postedDate)!;
    const eventType = applicable.find((action) => action.event)?.event ?? (direction === "in" ? "income" : "expense");
    const suffix = compactPdfText(cell(line, columns, "cardSuffix"));
    const cardIdentity = suffix && rule.account?.suffixPattern.test(suffix) ? `${rule.account.label}(${suffix})` : undefined;
    const rawAccount = cardIdentity ?? rule.account?.label ?? file;
    const original = cell(line, columns, "originalAmount");
    const note = original && compactPdfText(original).replaceAll("−", "-") !== settled ? `${description} · 原交易 ${original}` : description;
    txs.push({
      id: txId(date, Math.abs(amount), direction, description, row, source), date, amount: Math.abs(amount),
      direction, currency, payee: description, note, rawCategory: section || rule.category,
      rawAccount, source, sourceFile: file, row, eventType, pdfRegions: sourceRegions(evidence), issues: [PDF_REVIEW_ISSUE],
      ...(cardIdentity && (eventType === "expense" || eventType === "refund") ? { refundEvidence: { cardIdentity } } : {}),
    });
  }
  if (!rows.length) errors.push({ row: 0, message: `未找到${rule.name}账单的交易明细` });
  return { source, txs, errors };
}

export async function parsePdfBank(file: string, source: ParseResult["source"], rules?: PdfRules, data?: Uint8Array): Promise<ParseResult> {
  let pages: TextLine[][];
  try {
    pages = await extractPages(data ?? await readFile(file));
  } catch (error) {
    let message = PDF_RETRY_HINT;
    if (error instanceof pdfjs.PasswordException) message = "这份 PDF 有密码保护。请先解除密码保护，再上传副本。";
    else if (error instanceof pdfjs.InvalidPDFException) message = "这份 PDF 无法打开。请重新下载原账单后上传。";
    else console.error("Could not read statement PDF", error);
    return { source, txs: [], errors: [{ row: 0, message }] };
  }
  try {
    rules ??= loadPdfRules();
  } catch (error) {
    console.error("Could not load PDF recognition rules", error);
    return { source, txs: [], errors: [{ row: 0, message: "无法读取 PDF 识别规则。请检查 config/pdf-rules.json 后重新上传。" }] };
  }
  const lines = pages.flat();
  const candidates = rules.tables.flatMap((rule) => {
    const title = lines.find(({ text }) => rule.documentPattern.test(compactPdfText(text)))?.text;
    return title ? [{ rule, title }] : [];
  });
  const match = candidates.find(({ rule }) => lines.some(({ items }) => tableColumns(items, rule))) ?? candidates[0];
  if (match) return parseTableStatement(file, pages, match.title, match.rule);
  return parseGenericStatement(file, source, lines, rules.fallback);
}

function parseGenericStatement(file: string, source: ParseResult["source"], lines: TextLine[], rule: PdfRules["fallback"]): ParseResult {
  const txs: RawTx[] = [];
  const signedAmount = lines.some(({ text }) => rule.signedAmountDocumentPattern?.test(compactPdfText(text)));
  interface Draft {
    date: string;
    time?: string;
    amounts: number[];
    text: string;
    origin: TextLine;
  }
  const drafts: Draft[] = [];

  for (const origin of lines) {
    const line = origin.text;
    const dateParsed = parseDate(line);
    // a transaction line must start with a date and contain an amount
    const amounts = (line.match(rule.amountPattern) ?? []).map((s) => parseAmount(s) ?? 0);
    const isHeaderOrNoise = rule.ignorePattern.test(line);

    if (dateParsed && amounts.length >= 1 && !isHeaderOrNoise) {
      drafts.push({ date: dateParsed.date, time: dateParsed.time, amounts, text: line, origin });
    } else if (drafts.length > 0 && !isHeaderOrNoise && line.trim()) {
      // continuation line (long 摘要 wrapped): append text
      drafts[drafts.length - 1].text += " " + line.trim();
    }
  }

  for (const d of drafts) {
    // Signed layouts put the transaction amount first. Other layouts may have separate debit and credit columns.
    const balance = d.amounts.length > 1 ? d.amounts[d.amounts.length - 1] : undefined;
    const amount = signedAmount ? d.amounts[0] : d.amounts.find((a) => a !== 0) ?? d.amounts[0];
    if (amount === 0) continue;

    let direction: "in" | "out";
    if (signedAmount) direction = amount > 0 ? "in" : "out";
    else if (amount < 0 || rule.outPattern.test(d.text)) direction = "out";
    else if (rule.inPattern.test(d.text)) direction = "in";
    else direction = "out";

    // payee: text between the date and the first amount
    const afterDate = d.text.replace(/^\S+\s+/, "");
    const firstAmtIdx = afterDate.search(rule.amountPattern);
    const payee =
      firstAmtIdx > 0 ? afterDate.slice(0, firstAmtIdx).trim() : "";

    txs.push({
      id: txId(d.date, Math.abs(amount), direction, payee, `${d.time ?? ""}|${d.text}`, source),
      date: d.date,
      time: d.time,
      amount: Math.abs(amount),
      direction,
      currency: rule.currency,
      payee,
      note: d.text.slice(0, 80),
      rawCategory: rule.category,
      rawAccount: file,
      balanceAfter: balance,
      source,
      sourceFile: file,
      row: txs.length + 1,
      eventType: rule.transferPattern.test(d.text) ? "transfer" : direction === "in" ? "income" : "expense",
      pdfRegions: sourceRegions([d.origin]),
      issues: [PDF_REVIEW_ISSUE],
    });
  }

  const errors = txs.length ? [] : [{ row: 0, message: lines.length
    ? "未识别到 PDF 交易明细，请核对账单版式" : "PDF 中没有可提取的文字，请使用可选中文字的账单" }];
  return { source, txs, errors };
}
