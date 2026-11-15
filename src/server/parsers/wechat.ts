/** WeChat Pay CSV/XLSX exports, with source states preserved for reconciliation. */
import type { EventType, RawTx } from "../../shared/types.js";
import { col, findHeader, parseAmount, parseDate, readSheet, txId, parseFundingParts, type ParseResult } from "./common.js";

export function isWechat(name: string): boolean { return /微信|wechat|weixin/i.test(name); }

export function parseWechat(file: string): ParseResult {
  const { rows } = readSheet(file);
  const headerIdx = findHeader(rows, ["交易时间", "交易对方", "金额"]);
  const errors: ParseResult["errors"] = [], txs: RawTx[] = [];
  if (headerIdx < 0) return { source: "wechat", txs, errors: [{ row: 0, message: "未找到微信支付交易明细表头" }] };
  const header = rows[headerIdx].map((h) => h.trim());
  const indexes = {
    date: col(header, ["交易时间"]), type: col(header, ["交易类型"]), payee: col(header, ["交易对方"]), goods: col(header, ["商品"]),
    amount: col(header, ["金额(元)", "金额"]), status: col(header, ["当前状态", "交易状态"]), method: col(header, ["支付方式"]),
    id: col(header, ["交易单号", "商户单号"]), direction: col(header, ["收/支"]), remark: col(header, ["备注"]),
  };
  for (let r = headerIdx + 1; r < rows.length; r++) {
    const row = rows[r], cell = (key: keyof typeof indexes) => indexes[key] >= 0 ? (row[indexes[key]] ?? "").trim() : "";
    if (!row.some((value) => value.trim()) || !cell("id") && !/^\d{4}/.test(cell("date"))) continue;
    const parsed = parseDate(cell("date")), amount = parseAmount(cell("amount"));
    const sourceStatus = cell("status"), originalDirection = cell("direction"), rawCategory = cell("type"), rawAccount = cell("method"), payee = cell("payee");
    const note = [...new Set([cell("goods"), cell("remark")].filter((value) => value && value !== "/"))].join(" · ");
    const issues: string[] = []; let excludedReason: string | undefined;
    if (/关闭|失败|取消/.test(sourceStatus)) excludedReason = `交易未完成：${sourceStatus}`;
    else if (/待收|等待|处理中/.test(sourceStatus)) excludedReason = `交易尚未完成：${sourceStatus}`;
    else if (sourceStatus && !/成功|已收钱|已转账|已存入|已退款|提现已到账|已到账|已全额退款|对方已退还|资金已到账|充值完成/.test(sourceStatus)) issues.push(`未识别交易状态：${sourceStatus}`);
    if (!parsed || amount == null) { excludedReason = "日期或金额无法解析"; errors.push({ row: r + 1, message: excludedReason }); }
    else if (amount === 0) excludedReason ??= "零金额交易，无资金变动";
    const refund = /退款|退还/.test(rawCategory), transfer = /零钱提现|零钱充值|零钱通转出|转入零钱通|信用卡还款/.test(rawCategory) || /^转账$/.test(rawCategory);
    const eventType: EventType = refund ? "refund" : transfer ? "transfer" : originalDirection.includes("收入") ? "income" : originalDirection.includes("支出") ? "expense" : "unknown";
    let direction: "in" | "out" = refund || originalDirection.includes("收入") ? "in" : "out";
    if (transfer) {
      // Direction describes the account in 支付方式: for withdrawal this is the
      // receiving bank, whereas top-up names the bank funding the wallet.
      if (/零钱提现/.test(rawCategory)) direction = "in";
      else if (/零钱充值|转入零钱通|零钱通转出/.test(rawCategory)) direction = "out";
      issues.push("资金转移，请确认双方账户；不应计入收入或费用");
    }
    if (!refund && /已退款|已全额退款|对方已退还/.test(sourceStatus)) issues.push("原交易已退款或退还，保留原资金流并核对退款流水");
    if (refund) issues.push("退款应冲回原费用，请关联原交易确认分类");
    if (eventType === "unknown") issues.push("交易收支方向不明确，请核对原始流水");
    const split = parseFundingParts(rawAccount); issues.push(...split.issues);
    const sourceTxId = cell("id") || undefined, date = parsed?.date ?? "";
    txs.push({ id: txId(date, Math.abs(amount ?? 0), direction, payee, `${parsed?.time ?? ""}|${note}|${rawAccount}`, "wechat", sourceTxId),
      date, time: parsed?.time, amount: Math.abs(amount ?? 0), direction, currency: "CNY", payee, note,
      rawCategory, rawAccount, sourceTxId, source: "wechat", sourceFile: file, row: r + 1, eventType, sourceStatus, originalDirection,
      excludedReason, issues, fundingParts: split.fundingParts });
  }
  return { source: "wechat", txs, errors };
}
