import type { RawTx } from "./types.js";

export function alipayRefundOrderId(sourceTxId?: string): string | undefined {
  return sourceTxId?.match(/^(\d+)_\d+$/)?.[1];
}

export function isClosedAlipayPurchase(tx: Pick<RawTx, "source" | "sourceStatus" | "excludedReason">): boolean {
  return tx.source === "alipay" && tx.sourceStatus === "交易关闭" && tx.excludedReason === "交易未完成：交易关闭";
}
