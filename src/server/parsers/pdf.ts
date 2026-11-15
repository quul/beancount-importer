/**
 * PDF bank statement parser using pdfjs-dist (legacy build for Node).
 *
 * Bank PDFs are table-like but not real tables: pdfjs gives text runs with
 * x/y coordinates. Strategy:
 *  1. extract all text items per page
 *  2. group items into lines by y coordinate (±3pt tolerance)
 *  3. a line that starts with a date AND contains a parseable amount is a
 *     transaction row; other lines glue onto the previous transaction as
 *     continuation (multi-line 摘要)
 *  4. direction from amount sign or 借/贷 marker in the line
 *
 * This still needs per-bank tuning for exotic layouts, but handles the common
 * "date | payee/摘要 | amount | balance" grid the six supported banks export.
 */

import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import type { RawTx } from "../../shared/types.js";
import { parseAmount, parseDate, txId, type ParseResult } from "./common.js";

interface TextItem {
  str: string;
  x: number;
  y: number;
}

async function extractLines(file: string): Promise<string[][]> {
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(await (await import("node:fs")).readFileSync(file)),
    // banks' PDFs rarely need worker; disable to keep Node happy
    useWorkerFetch: false,
    useSystemFonts: true,
  }).promise;

  const lines: string[][] = [];

  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const items: TextItem[] = content.items
      .map((it) => it as { str: string; transform: number[] })
      .filter((it) => typeof it.str === "string")
      .map((it) => ({
        str: it.str,
        x: it.transform[4],
        y: it.transform[5],
      }));

    // group by y with tolerance, keep x order
    const rows = new Map<number, TextItem[]>();
    for (const it of items) {
      if (!it.str.trim()) continue;
      let key: number | undefined;
      for (const y of rows.keys()) {
        if (Math.abs(y - it.y) <= 3) { key = y; break; }
      }
      const k = key ?? it.y;
      const arr = rows.get(k) ?? [];
      arr.push(it);
      rows.set(k, arr);
    }

    const sorted = [...rows.entries()].sort((a, b) => b[0] - a[0]); // top→bottom
    for (const [, arr] of sorted) {
      arr.sort((a, b) => a.x - b.x);
      // insert spaces where x-gaps are wide, so "3500.00" and "0.00" don't glue
      const cells: string[] = [];
      let prevEndX = 0;
      for (const it of arr) {
        if (prevEndX && it.x - prevEndX > 2) cells.push(" ");
        cells.push(it.str);
        prevEndX = it.x + it.str.length * 3; // approx width at size 10
      }
      lines.push([cells.join("")]);
    }
  }

  await doc.cleanup?.();
  return lines;
}

export async function parsePdfBank(file: string, source: ParseResult["source"]): Promise<ParseResult> {
  const errors: ParseResult["errors"] = [];
  const txs: RawTx[] = [];

  let lines: string[][];
  try {
    lines = await extractLines(file);
  } catch (e) {
    return { source, txs, errors: [{ row: 0, message: `PDF 解析失败: ${(e as Error).message}` }] };
  }

  // join each line's cells; pdfjs often splits mid-number ("1,23" "4.00")
  const joined = lines.map((cells) => cells.join(""));

  interface Draft {
    date: string;
    time?: string;
    amounts: number[];
    text: string;
  }
  const drafts: Draft[] = [];

  for (const line of joined) {
    const dateParsed = parseDate(line);
    // a transaction line must start with a date and contain an amount
    const amounts = (line.match(/-?[\d,]+\.\d{2}/g) ?? []).map((s) => parseAmount(s) ?? 0);
    const isHeaderOrNoise = /交易日期|摘要|金额|余额|第\s*\d+\s*页|共\s*\d+\s*页|statement/i.test(line);

    if (dateParsed && amounts.length >= 1 && !isHeaderOrNoise) {
      drafts.push({ date: dateParsed.date, time: dateParsed.time, amounts, text: line });
    } else if (drafts.length > 0 && !isHeaderOrNoise && line.trim()) {
      // continuation line (long 摘要 wrapped): append text
      drafts[drafts.length - 1].text += " " + line.trim();
    }
  }

  for (const d of drafts) {
    // column semantics: debit column + credit column + balance column.
    // The transaction amount is the first non-zero; the balance is the last.
    const nonzero = d.amounts.filter((a) => a !== 0);
    const balance = d.amounts.length > 1 ? d.amounts[d.amounts.length - 1] : undefined;
    const amount = nonzero[0] ?? d.amounts[0];
    if (amount === 0) continue;

    let direction: "in" | "out";
    if (amount < 0) direction = "out";
    else if (/借方|支出|取出/.test(d.text)) direction = "out";
    else if (/贷方|收入|存入|工资|薪|salary/i.test(d.text)) direction = "in";
    else direction = "out";

    // payee: text between the date and the first amount
    const afterDate = d.text.replace(/^\S+\s+/, "");
    const firstAmtIdx = afterDate.search(/-?[\d,]+\.\d{2}/);
    const payee =
      firstAmtIdx > 0 ? afterDate.slice(0, firstAmtIdx).trim() : "";

    txs.push({
      id: txId(d.date, Math.abs(amount), direction, payee, txs.length),
      date: d.date,
      time: d.time,
      amount: Math.abs(amount),
      direction,
      currency: "CNY",
      payee,
      note: d.text.slice(0, 80),
      rawCategory: "PDF银行流水",
      rawAccount: file,
      balanceAfter: balance,
      source,
      sourceFile: file,
      row: txs.length + 1,
    });
  }

  return { source, txs, errors };
}
