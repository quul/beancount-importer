/**
 * Common utilities for statement parsers.
 * Statement files are untrusted input: parsers only read text, never execute it.
 */

import fs from "node:fs";
import iconv from "iconv-lite";
import * as XLSX from "xlsx";
import crypto from "node:crypto";
import type { RawTx, SourceType } from "../../shared/types.js";

export function txId(
  date: string,
  amount: number,
  direction: string,
  payee: string,
  row: number,
): string {
  const h = crypto
    .createHash("sha1")
    .update([date, amount.toFixed(2), direction, payee, row].join("|"))
    .digest("hex");
  return h.slice(0, 12);
}

/** Read file as text trying GBK first (Chinese banks/Alipay default) then UTF-8. */
export function readTextSmart(buf: Buffer): string {
  // BOM → utf-8
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.toString("utf-8");
  }
  // try utf-8 strictly; if it fails, fall back to gbk
  const utf8 = buf.toString("utf-8");
  if (!utf8.includes("�")) return utf8;
  return iconv.decode(buf, "gbk");
}

export interface SheetData {
  /** rows of cells as strings */
  rows: string[][];
}

/** Parse CSV/TSV text into rows (handles quoted fields). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let cur: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === "," || c === "\t") {
      cur.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      cur.push(field);
      field = "";
      if (cur.some((f) => f.trim() !== "")) rows.push(cur);
      cur = [];
    } else field += c;
  }
  if (field || cur.length) {
    cur.push(field);
    if (cur.some((f) => f.trim() !== "")) rows.push(cur);
  }
  return rows;
}

/** Read xlsx/xls/csv uniformly into rows of string cells. */
export function readSheet(file: string): SheetData {
  const ext = file.toLowerCase().split(".").pop();
  if (ext === "xlsx" || ext === "xls") {
    const wb = XLSX.read(fs.readFileSync(file), { type: "buffer" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows: string[][] = XLSX.utils.sheet_to_json(ws, {
      header: 1,
      raw: false,
      defval: "",
    });
    return { rows: rows.map((r) => (r as unknown[]).map((c) => String(c ?? ""))) };
  }
  const text = readTextSmart(fs.readFileSync(file));
  return { rows: parseCsv(text) };
}

/** Find the header row index: first row containing all given keywords. */
export function findHeader(
  rows: string[][],
  keywords: string[],
): number {
  for (let i = 0; i < rows.length; i++) {
    const joined = rows[i].map((c) => c.trim()).join("|");
    if (keywords.every((k) => joined.includes(k))) return i;
  }
  return -1;
}

/** Column lookup by fuzzy name (exact contains, trimmed). */
export function col(
  header: string[],
  names: string[],
): number {
  for (const n of names) {
    const idx = header.findIndex((h) => h.trim() === n || h.trim().includes(n));
    if (idx >= 0) return idx;
  }
  return -1;
}

/** Normalize amount string: strip ¥, spaces, commas, ＋, keep sign. */
export function parseAmount(raw: string): number | null {
  const s = raw
    .replace(/[¥￥,，\s+＋]/g, "")
    .replace(/（-/g, "-")
    .replace(/[（）()]/g, "");
  if (!s || s === "-" || s === ".") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse date in the many formats Chinese statements use:
 * 2024-01-02, 2024/1/2, 2024.1.2, 2024年1月2日, 20240102, and with time suffix.
 */
export function parseDate(raw: string): { date: string; time?: string } | null {
  const s = raw.trim();
  let m = s.match(
    /(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/,
  );
  if (m) {
    const [, y, mo, d, h, mi, se] = m;
    return {
      date: `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`,
      time: h ? `${h.padStart(2, "0")}:${mi}:${se ?? "00"}` : undefined,
    };
  }
  m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) {
    return { date: `${m[1]}-${m[2]}-${m[3]}` };
  }
  // Excel serial date
  const n = Number(s);
  if (Number.isFinite(n) && n > 20000 && n < 80000) {
    const d = new Date(Math.round((n - 25569) * 86400 * 1000));
    return { date: d.toISOString().slice(0, 10) };
  }
  return null;
}

export interface ParseResult {
  source: SourceType;
  txs: RawTx[];
  errors: Array<{ row: number; message: string }>;
}
