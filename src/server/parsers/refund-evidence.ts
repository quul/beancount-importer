import { alipayRefundOrderId, isClosedAlipayPurchase } from "../../shared/alipay.js";
import { normalizePaymentMethod } from "../../shared/funding.js";
import type { RawTx, RefundEvidence } from "../../shared/types.js";
import { parseAmount } from "./common.js";

function alipayRefundEvidence(status?: string, sourceTxId?: string): RefundEvidence | undefined {
  if (status !== "退款成功") return { unconfirmed: true };
  const originalSourceTxId = alipayRefundOrderId(sourceTxId);
  return originalSourceTxId ? { originalSourceTxId } : undefined;
}

function wechatRefundEvidence(status: string | undefined, amount: number): RefundEvidence | undefined {
  const text = status?.normalize("NFKC").trim() ?? "";
  if (text === "已全额退款") return { reportedRefundAmount: amount };
  const match = text.match(/^已(?:全额)?退款\s*(?:\(\s*¥\s*([\d,.]+)\s*\)|¥\s*([\d,.]+))$/);
  const reportedRefundAmount = match ? parseAmount(match[1] ?? match[2]) : null;
  return reportedRefundAmount === null ? undefined : { reportedRefundAmount };
}

export function statementRefundEvidence(tx: RawTx): RefundEvidence | undefined {
  if (tx.refundEvidence) return tx.refundEvidence;
  // Older batches still have the original status and transaction ID.
  if (tx.eventType === "expense" && isClosedAlipayPurchase(tx)) return { restoreWhenFullyRefunded: true };
  if (tx.source === "alipay" && tx.eventType === "refund") return alipayRefundEvidence(tx.sourceStatus, tx.sourceTxId);
  if (tx.source === "wechat" && tx.eventType === "expense") return wechatRefundEvidence(tx.sourceStatus, tx.amount);
}

export function cardSuffix(payment: string): string | undefined {
  return normalizePaymentMethod(payment).match(/\((\d{4,})\)$|[＊*•×]{2,}(\d{4,})$/u)?.slice(1).find(Boolean);
}
