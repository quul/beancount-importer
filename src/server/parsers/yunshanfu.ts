/**
 * YunShanFu (云闪付 / UnionPay app) statement parser.
 * YunShanFu exports CSV/XLSX with columns like 交易时间,交易类型,交易对方,金额,收支类型,支付方式.
 */

import type { RawTx } from "../../shared/types.js";
import {
  col,
  findHeader,
  parseAmount,
  parseDate,
  readSheet,
  txId,
  type ParseResult,
} from "./common.js";

export function isYunshanfu(name: string): boolean {
  return /云闪付|yunshanfu|unionpay|银联/.test(name);
}

export function parseYunshanfu(file: string): ParseResult {
  const { rows } = readSheet(file);
  const headerIdx = findHeader(rows, ["交易时间"]);
  const errors: ParseResult["errors"] = [];
  const txs: RawTx[] = [];

  if (headerIdx < 0) {
    return { source: "yunshanfu", txs, errors: [{ row: 0, message: "未找到表头（交易时间）" }] };
  }

  const header = rows[headerIdx].map((h) => h.trim());
  const iDate = col(header, ["交易时间", "交易日期"]);
  const iType = col(header, ["交易类型", "业务类型"]);
  const iPayee = col(header, ["交易对方", "对方", "商户名称"]);
  const iAmount = col(header, ["金额", "交易金额"]);
  const iDir = col(header, ["收支类型", "收/支", "借贷方向"]);
  const iMethod = col(header, ["支付方式", "付款方式", "卡号"]);
  const iNote = col(header, ["备注", "商品说明", "摘要"]);
  const iTxNo = col(header, ["交易单号", "交易流水号", "订单号"]);

  for (let r = headerIdx + 1; r < rows.length; r++) {
    const row = rows[r];
    const cell = (i: number) => (i >= 0 ? (row[i] ?? "").trim() : "");

    const dateParsed = parseDate(cell(iDate));
    const amount = parseAmount(cell(iAmount));
    if (!dateParsed || amount == null || amount === 0) {
      if (row.some((c) => c.trim() !== "")) {
        errors.push({ row: r + 1, message: `无法解析日期或金额` });
      }
      continue;
    }

    const dirRaw = cell(iDir) + cell(iType);
    const direction: "in" | "out" = /收入|贷|转入|收入/.test(dirRaw) ? "in" : "out";

    txs.push({
      id: txId(dateParsed.date, Math.abs(amount), direction, cell(iPayee), `${dateParsed.time ?? ""}|${cell(iNote)}|${cell(iMethod)}`, "yunshanfu", cell(iTxNo) || undefined),
      date: dateParsed.date,
      time: dateParsed.time,
      amount: Math.abs(amount),
      direction,
      currency: "CNY",
      payee: cell(iPayee),
      note: cell(iNote),
      rawCategory: cell(iType),
      rawAccount: cell(iMethod),
      source: "yunshanfu",
      sourceFile: file,
      row: r + 1,
      sourceTxId: cell(iTxNo) || undefined,
      eventType: /退款/.test(cell(iType)) ? "refund" : /还款|转账|充值|提现/.test(cell(iType)) ? "transfer" : direction === "in" ? "income" : "expense",
    });
  }

  return { source: "yunshanfu", txs, errors };
}
