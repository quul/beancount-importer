/** Alipay export: retain every source transaction, including excluded rows. */
import fs from "node:fs";
import { alipayRefundOrderId, isYuebaoInterestDescription } from "../../shared/alipay.js";
import type { EventType, RawTx } from "../../shared/types.js";
import { col, parseAmount, parseDate, readTextSmart, parseCsv, txId, parseFundingParts, UNREADABLE_TRANSACTION, type ParseResult } from "./common.js";
import { statementRefundEvidence } from "./refund-evidence.js";

const requiredColumns = {
  date: ["交易时间", "交易创建时间", "记录时间"],
  payee: ["交易对方"],
  amount: ["金额", "金额（元）", "金额(元)"],
};

interface TimedRow { tx: RawTx; timestamp: number }
export const alipayWalletExclusion = { title: "支付宝余额转入余额宝", receiptWindowSeconds: 30 };

function excludePairedWalletTransfers(transfers: TimedRow[], receiptsByAmount: Map<number, TimedRow[]>) {
  const candidates = new Map<RawTx, TimedRow[]>();
  const transferCounts = new Map<RawTx, number>();
  for (const { tx, timestamp } of transfers) {
    const receipts = (receiptsByAmount.get(tx.amount) ?? []).filter((receipt) =>
      receipt.timestamp < timestamp && timestamp - receipt.timestamp <= alipayWalletExclusion.receiptWindowSeconds * 1000);
    candidates.set(tx, receipts);
    for (const receipt of receipts) {
      transferCounts.set(receipt.tx, (transferCounts.get(receipt.tx) ?? 0) + 1);
    }
  }
  for (const [tx, receipts] of candidates) {
    if (receipts.length !== 1 || transferCounts.get(receipts[0].tx) !== 1) continue;
    tx.eventType = "transfer";
    tx.excludedReason = alipayWalletExclusion.title;
    tx.issues = tx.issues?.filter((issue) => issue !== "收支待确认");
  }
}

function findAlipayHeader(rows: string[][]): number {
  return rows.findIndex((row) => Object.values(requiredColumns).every((names) => col(row, names) >= 0));
}

export function isAlipay(file: string, name: string): boolean {
  if (/支付宝|alipay|ali-pay|zhifubao/i.test(name)) return true;
  try {
    const text = readTextSmart(fs.readFileSync(file)).slice(0, 4000);
    return text.includes("支付宝") && findAlipayHeader(parseCsv(text)) >= 0;
  }
  catch { return false; }
}

export function parseAlipay(file: string): ParseResult {
  const rows = parseCsv(readTextSmart(fs.readFileSync(file)));
  const headerIdx = findAlipayHeader(rows);
  const errors: ParseResult["errors"] = [];
  const txs: RawTx[] = [];
  const walletTransfers: TimedRow[] = [];
  const receiptsByAmount = new Map<number, TimedRow[]>();
  if (headerIdx < 0) return { source: "alipay", txs, errors: [{ row: 0, message: "未找到支付宝交易明细表头" }] };
  const header = rows[headerIdx].map((h) => h.trim());
  const indexes = {
    date: col(header, requiredColumns.date), payee: col(header, requiredColumns.payee), direction: col(header, ["收/支"]),
    amount: col(header, requiredColumns.amount), status: col(header, ["交易状态"]), method: col(header, ["收/付款方式"]),
    category: col(header, ["交易分类", "类型"]), tag: col(header, ["标签"]), note: col(header, ["商品说明", "商品名称"]),
    remark: col(header, ["备注"]), id: col(header, ["交易订单号", "交易号", "订单号"]),
    order: col(header, ["商家订单号", "商户订单号"]),
  };
  for (let r = headerIdx + 1; r < rows.length; r++) {
    const row = rows[r];
    const cell = (key: keyof typeof indexes) => indexes[key] >= 0 ? (row[indexes[key]] ?? "").trim() : "";
    const rawDate = cell("date"), sourceTxId = cell("id") || undefined;
    // The older export starts with the ID column and ends with short summary rows.
    if (row.length <= indexes.amount && !rawDate) continue;
    if (!sourceTxId && !/^\d{4}/.test(rawDate)) continue;
    const parsed = parseDate(rawDate);
    const amount = parseAmount(cell("amount"));
    const sourceStatus = cell("status"), originalDirection = cell("direction"), category = cell("category"), rawAccount = cell("method"), payee = cell("payee");
    const description = cell("note");
    const note = [...new Set([description, cell("remark")].filter(Boolean))].join(" · ");
    const issues: string[] = [];
    let excludedReason: string | undefined;
    if (/关闭|失败|取消/.test(sourceStatus)) excludedReason = `交易未完成：${sourceStatus}`;
    else if (/等待|处理中|待支付|待付款/.test(sourceStatus)) excludedReason = `交易未完成：${sourceStatus}`;
    else if (sourceStatus && !/成功|已收|已转|已完成/.test(sourceStatus)) issues.push(`未识别交易状态：${sourceStatus}`);
    if (!parsed || amount == null) { excludedReason = UNREADABLE_TRANSACTION; errors.push({ row: r + 1, message: excludedReason }); }
    else if (amount === 0) excludedReason ??= "零金额";
    const refund = category === "退款" || (originalDirection.includes("收入") && /退款/.test(note))
      || (sourceStatus === "退款成功" && Boolean(alipayRefundOrderId(sourceTxId)));
    const yuEBaoInterest = !excludedReason && amount !== null && amount > 0 && category === "投资理财"
      && rawAccount === "余额宝" && sourceStatus === "交易成功" && originalDirection === "不计收支"
      && isYuebaoInterestDescription(description);
    const income = yuEBaoInterest || originalDirection.includes("收入");
    const transfer = !yuEBaoInterest && (/信用借还|账户存取/.test(category) || /还款|提现|转入余额|余额转出/.test(`${category} ${note}`));
    // 亲情卡/亲友代付: someone else's card paid for this purchase. The funding
    // description (e.g. 浙商银行信用卡(5103)) belongs to THEM, never to my mapping.
    const familyCard = !yuEBaoInterest && (/亲情卡|亲属卡/.test(note) || /亲友代付|亲情代付/.test(category));
    let eventType: EventType = refund ? "refund" : transfer ? "transfer" : familyCard ? "familyCard"
      : income ? "income" : originalDirection.includes("支出") ? "expense" : "unknown";
    let direction: "in" | "out" = refund || income ? "in" : "out";
    if (!refund && /退款成功/.test(sourceStatus)) { eventType = "expense"; issues.push("已退款，核对退款流水"); }
    else if (transfer) { direction = /转入|存入|充值/.test(note) && !/还款/.test(note) ? "in" : "out"; issues.push("转账"); }
    else if (eventType === "unknown") issues.push("收支待确认");
    if (refund) issues.push("冲回原费用");
    if (familyCard) issues.push("对方付款");
    const split = parseFundingParts(rawAccount); issues.push(...split.issues);
    const date = parsed?.date ?? "";
    const tx: RawTx = { id: txId(date, Math.abs(amount ?? 0), direction, payee, `${parsed?.time ?? ""}|${note}|${rawAccount}`, "alipay", sourceTxId),
      date, time: parsed?.time, amount: Math.abs(amount ?? 0), direction, currency: "CNY", payee, note,
      rawCategory: cell("tag") || category, rawAccount, sourceTxId, orderId: cell("order") || undefined, source: "alipay", sourceFile: file, row: r + 1,
      eventType, sourceStatus, originalDirection, excludedReason, issues, fundingParts: split.fundingParts };
    const evidence = statementRefundEvidence(tx);
    if (evidence) tx.refundEvidence = evidence;
    txs.push(tx);
    if (excludedReason || !parsed?.time || !/\d{1,2}:\d{2}:\d{2}\b/.test(rawDate)
      || amount === null || amount <= 0 || rawAccount !== "账户余额" || sourceStatus !== "交易成功") continue;
    const timestamp = Date.parse(`${date}T${parsed.time}Z`);
    if (category === "投资理财" && originalDirection === "不计收支" && payee === "余额宝" && description === "转账收款到余额宝") {
      walletTransfers.push({ tx, timestamp });
    } else if (category === "转账红包" && originalDirection === "收入" && eventType === "income" && direction === "in") {
      const receipts = receiptsByAmount.get(amount) ?? [];
      receipts.push({ tx, timestamp });
      receiptsByAmount.set(amount, receipts);
    }
  }
  excludePairedWalletTransfers(walletTransfers, receiptsByAmount);
  return { source: "alipay", txs, errors };
}
