/** Alipay export: retain every source transaction, including excluded rows. */
import fs from "node:fs";
import type { EventType, RawTx } from "../../shared/types.js";
import { col, findHeader, parseAmount, parseDate, readTextSmart, parseCsv, txId, parseFundingParts, type ParseResult } from "./common.js";

export function isAlipay(file: string, name: string): boolean {
  if (/支付宝|alipay|ali-pay|zhifubao/i.test(name)) return true;
  try { const text = readTextSmart(fs.readFileSync(file)).slice(0, 4000); return text.includes("支付宝") && text.includes("交易时间"); }
  catch { return false; }
}

export function parseAlipay(file: string): ParseResult {
  const rows = parseCsv(readTextSmart(fs.readFileSync(file)));
  const headerIdx = findHeader(rows, ["交易时间", "交易对方", "金额"]);
  const errors: ParseResult["errors"] = [];
  const txs: RawTx[] = [];
  if (headerIdx < 0) return { source: "alipay", txs, errors: [{ row: 0, message: "未找到支付宝交易明细表头" }] };
  const header = rows[headerIdx].map((h) => h.trim());
  const indexes = {
    date: col(header, ["交易时间", "记录时间"]), payee: col(header, ["交易对方"]), direction: col(header, ["收/支"]),
    amount: col(header, ["金额"]), status: col(header, ["交易状态"]), method: col(header, ["收/付款方式"]),
    category: col(header, ["交易分类"]), tag: col(header, ["标签"]), note: col(header, ["商品说明", "商品名称"]),
    remark: col(header, ["备注"]), id: col(header, ["交易订单号", "交易号", "订单号"]),
  };
  for (let r = headerIdx + 1; r < rows.length; r++) {
    const row = rows[r];
    const cell = (key: keyof typeof indexes) => indexes[key] >= 0 ? (row[indexes[key]] ?? "").trim() : "";
    if (!row.some((value) => value.trim())) continue;
    if (!cell("id") && !/^\d{4}/.test(cell("date"))) continue;
    const parsed = parseDate(cell("date"));
    const amount = parseAmount(cell("amount"));
    const sourceStatus = cell("status"), originalDirection = cell("direction"), category = cell("category"), rawAccount = cell("method"), payee = cell("payee");
    const note = [...new Set([cell("note"), cell("remark")].filter(Boolean))].join(" · ");
    const issues: string[] = [];
    let excludedReason: string | undefined;
    if (/关闭|失败|取消/.test(sourceStatus)) excludedReason = `交易未完成：${sourceStatus}`;
    else if (/等待|处理中|待支付|待付款/.test(sourceStatus)) excludedReason = `交易尚未完成：${sourceStatus}`;
    else if (sourceStatus && !/成功|已收|已转|已完成/.test(sourceStatus)) issues.push(`未识别交易状态：${sourceStatus}`);
    if (!parsed || amount == null) { excludedReason = "日期或金额无法解析"; errors.push({ row: r + 1, message: excludedReason }); }
    else if (amount === 0) excludedReason ??= "零金额交易，无资金变动";
    const refund = /^退款$/.test(category) || originalDirection.includes("收入") && /退款/.test(note);
    const transfer = /信用借还|账户存取/.test(category) || /还款|提现|转入余额|余额转出/.test(`${category} ${note}`);
    // 亲情卡/亲友代付: someone else's card paid for this purchase. The funding
    // description (e.g. 浙商银行信用卡(5103)) belongs to THEM, never to my mapping.
    const familyCard = /亲情卡|亲属卡/.test(note) || /亲友代付|亲情代付/.test(category);
    let eventType: EventType = refund ? "refund" : transfer ? "transfer" : familyCard ? "familyCard" : originalDirection.includes("收入") ? "income" : originalDirection.includes("支出") ? "expense" : "unknown";
    let direction: "in" | "out" = refund || originalDirection.includes("收入") ? "in" : "out";
    if (!refund && /退款成功/.test(sourceStatus)) { eventType = "expense"; issues.push("原消费已退款，保留原支出并核对对应退款流水"); }
    else if (transfer) { direction = /转入|存入|充值/.test(note) && !/还款/.test(note) ? "in" : "out"; issues.push("资金转移，请确认双方账户；不应计入收入或费用"); }
    else if (eventType === "unknown") issues.push("不计收支流水，请确认经济业务与资金方向");
    if (refund) issues.push("退款应冲回原费用，请关联原交易确认分类");
    if (familyCard) issues.push(`${payee}的${/退款/.test(category) ? "亲情卡退款" : "亲情卡消费"}，资金出自对方账户；若对方账单也导入，两笔会配对，保留对方扣款一笔`);
    const split = parseFundingParts(rawAccount); issues.push(...split.issues);
    const sourceTxId = cell("id") || undefined, date = parsed?.date ?? "";
    txs.push({ id: txId(date, Math.abs(amount ?? 0), direction, payee, `${parsed?.time ?? ""}|${note}|${rawAccount}`, "alipay", sourceTxId),
      date, time: parsed?.time, amount: Math.abs(amount ?? 0), direction, currency: "CNY", payee, note,
      rawCategory: cell("tag") || category, rawAccount, sourceTxId, source: "alipay", sourceFile: file, row: r + 1,
      eventType, sourceStatus, originalDirection, excludedReason, issues, fundingParts: split.fundingParts });
  }
  return { source: "alipay", txs, errors };
}
