/**
 * WeChat Pay statement parser (微信支付账单, CSV or XLSX export).
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

const OK_STATUS = ["成功", "已收钱", "已转账", "已存入", "已退款", "提现已到账"];

export function isWechat(name: string): boolean {
  return /微信|wechat|weixin/i.test(name);
}

export function parseWechat(file: string): ParseResult {
  const { rows } = readSheet(file);
  const headerIdx = findHeader(rows, ["交易时间"]);
  const errors: ParseResult["errors"] = [];
  const txs: RawTx[] = [];

  if (headerIdx < 0) {
    return { source: "wechat", txs, errors: [{ row: 0, message: "未找到表头（交易时间）" }] };
  }

  const header = rows[headerIdx].map((h) => h.trim());
  const iDate = col(header, ["交易时间"]);
  const iType = col(header, ["交易类型"]);
  const iPayee = col(header, ["交易对方"]);
  const iGoods = col(header, ["商品"]);
  const iAmount = col(header, ["金额(元)", "金额"]);
  const iStatus = col(header, ["当前状态", "交易状态"]);
  const iMethod = col(header, ["支付方式"]);
  const iTxNo = col(header, ["交易单号", "商户单号"]);

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

    // wechat marks direction via 收/支 column in newer exports; infer from type otherwise
    const iDir = col(header, ["收/支"]);
    const dirRaw = cell(iDir);
    let direction: "in" | "out" = "out";
    if (dirRaw.includes("收入")) direction = "in";
    else if (dirRaw.includes("支出")) direction = "out";
    else {
      const t = cell(iType);
      if (/退款|收入|转入|红包.*收|零钱通收益/.test(t)) direction = "in";
    }

    txs.push({
      id: txId(dateParsed.date, amount, direction, cell(iPayee), r),
      date: dateParsed.date,
      time: dateParsed.time,
      amount: Math.abs(amount),
      direction,
      currency: "CNY",
      payee: cell(iPayee),
      note: cell(iGoods),
      rawCategory: cell(iType),
      rawAccount: cell(iMethod),
      sourceTxId: cell(iTxNo) || undefined,
      source: "wechat",
      sourceFile: file,
      row: r + 1,
    });
  }

  return { source: "wechat", txs, errors };
}
