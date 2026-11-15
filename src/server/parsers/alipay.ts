/**
 * Alipay statement parser (支付宝账单明细 CSV export).
 * Handles: GBK encoding, preamble lines, 交易状态 filter, 交易分类/标签,
 * 收/付款方式 (funding account), and pass-through detection.
 */

import type { RawTx } from "../../shared/types.js";
import {
  col,
  findHeader,
  parseAmount,
  parseDate,
  readTextSmart,
  parseCsv,
  txId,
  type ParseResult,
} from "./common.js";
import fs from "node:fs";

const HEADER_KEYWORDS = ["交易时间"];

// statuses considered successful
const OK_STATUS = ["成功", "已收", "已转", "还款成功", "提现成功"];

export function isAlipay(file: string, name: string): boolean {
  const n = name.toLowerCase();
  if (/支付宝|alipay|ali-pay|zhifubao/.test(n)) return true;
  // content sniff: alipay export has a fixed preamble mentioning 支付宝
  try {
    const text = readTextSmart(fs.readFileSync(file)).slice(0, 2000);
    return text.includes("支付宝") && text.includes("交易时间");
  } catch {
    return false;
  }
}

export function parseAlipay(file: string): ParseResult {
  const text = readTextSmart(fs.readFileSync(file));
  const rows = parseCsv(text);
  const headerIdx = findHeader(rows, HEADER_KEYWORDS);
  const errors: ParseResult["errors"] = [];
  const txs: RawTx[] = [];

  if (headerIdx < 0) {
    return { source: "alipay", txs, errors: [{ row: 0, message: "未找到表头（交易时间）" }] };
  }

  const header = rows[headerIdx].map((h) => h.trim());
  const iDate = col(header, ["交易时间", "记录时间"]);
  const iPayee = col(header, ["交易对方"]);
  const iDir = col(header, ["收/支"]);
  const iAmount = col(header, ["金额"]);
  const iStatus = col(header, ["交易状态"]);
  const iMethod = col(header, ["收/付款方式"]);
  const iCategory = col(header, ["交易分类"]);
  const iTag = col(header, ["标签"]);
  const iNote = col(header, ["商品说明", "商品名称", "备注"]);
  const iTxNo = col(header, ["交易号", "订单号"]);

  for (let r = headerIdx + 1; r < rows.length; r++) {
    const row = rows[r];
    const cell = (i: number) => (i >= 0 ? (row[i] ?? "").trim() : "");

    const status = cell(iStatus);
    if (status && !OK_STATUS.some((k) => status.includes(k))) continue;

    const dateParsed = parseDate(cell(iDate));
    const amount = parseAmount(cell(iAmount));
    if (!dateParsed || amount == null || amount === 0) {
      if (row.some((c) => c.trim() !== "")) {
        errors.push({ row: r + 1, message: `无法解析日期或金额: ${cell(iDate)} / ${cell(iAmount)}` });
      }
      continue;
    }

    const dirRaw = cell(iDir);
    // 交易类型 "不计收支" happens for refunds etc.; keep direction from amount sign as fallback
    const direction =
      dirRaw.includes("支出") || dirRaw.includes("收入") === false && amount < 0
        ? dirRaw.includes("收入")
          ? "in"
          : "out"
        : dirRaw.includes("收入")
          ? "in"
          : "out";

    const payee = cell(iPayee);
    const note = cell(iNote);

    txs.push({
      id: txId(dateParsed.date, amount, direction, payee, r),
      date: dateParsed.date,
      time: dateParsed.time,
      amount: Math.abs(amount),
      direction,
      currency: "CNY",
      payee,
      note,
      rawCategory: cell(iTag) || cell(iCategory),
      rawAccount: cell(iMethod),
      sourceTxId: cell(iTxNo) || undefined,
      source: "alipay",
      sourceFile: file,
      row: r + 1,
    });
  }

  return { source: "alipay", txs, errors };
}
