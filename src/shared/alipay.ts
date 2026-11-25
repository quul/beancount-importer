import type { RawTx } from "./types.js";

export const isYuebaoInterestDescription = (description: string) => /^余额宝-\d{4}\.\d{2}\.\d{2}-收益发放$/.test(description);

export function alipayRefundOrderId(sourceTxId?: string): string | undefined {
  return sourceTxId?.match(/^(\d+)_\d+$/)?.[1];
}

export function isClosedAlipayPurchase(tx: Pick<RawTx, "source" | "sourceStatus" | "excludedReason">): boolean {
  return tx.source === "alipay" && tx.sourceStatus === "交易关闭" && tx.excludedReason === "交易未完成：交易关闭";
}
