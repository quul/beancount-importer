/**
 * Bank statement parsers: BOC / ABC / CZBank / SPDB / ICBC / CCB + generic fallback.
 *
 * Key improvements over the original Python importer_bank.py:
 *  - per-bank header definitions (the original only had a generic guess)
 *  - direction detection via 借贷/收支/正负号 columns (the original did abs()
 *    and never decided direction — incomes were booked as expenses)
 *  - running balance capture for balance assertions
 *  - account/card number capture so one bank can hold multiple cards
 */

import type { RawTx, SourceType } from "../../shared/types.js";
import {
  col,
  findHeader,
  normalizeStatementCurrency,
  parseAmount,
  parseDate,
  readSheet,
  txId,
  type ParseResult,
} from "./common.js";

interface BankDef {
  source: SourceType;
  match: RegExp;
  /** alternative: header keywords unique enough to identify the bank */
  headerHint?: string[];
  /** date column candidates */
  dateCols: string[];
  /** direction columns: value containing these keywords → in/out */
  dirIn?: string[];
  dirOut?: string[];
  /** sign convention: amount sign carries direction */
  signedAmount?: boolean;
  amountCols: string[];
  payeeCols: string[];
  noteCols: string[];
  balanceCols: string[];
  /** card/account column for multi-account-per-bank */
  accountCols: string[];
  txNoCols: string[];
}

export const BANK_DEFS: BankDef[] = [
  {
    source: "bank-boc", // 中国银行
    match: /中国银行|boc|bank of china/i,
    dateCols: ["交易日期", "记账日期", "日期"],
    amountCols: ["交易金额", "金额", "发生额"],
    payeeCols: ["交易对方", "对方户名", "收款人", "付款人", "商户名称"],
    noteCols: ["摘要", "备注", "附言", "说明", "渠道"],
    balanceCols: ["余额", "账户余额", "可用余额"],
    accountCols: ["卡号", "账号", "账户"],
    txNoCols: ["交易流水号", "流水号"],
    dirIn: ["贷方", "收入", "存入", "贷"],
    dirOut: ["借方", "支出", "取出", "借"],
  },
  {
    source: "bank-abc", // 农业银行
    match: /农业银行|农行|abc|agricultural/i,
    dateCols: ["交易日期", "记账日期", "日期"],
    amountCols: ["交易金额", "金额", "发生额", "支出金额", "收入金额"],
    payeeCols: ["交易对方", "对方户名", "对方名称", "收款人"],
    noteCols: ["摘要", "备注", "附言"],
    balanceCols: ["余额", "账户余额"],
    accountCols: ["卡号", "账号", "账户"],
    txNoCols: ["交易流水号", "流水号"],
    dirIn: ["收入", "贷方", "存入"],
    dirOut: ["支出", "借方", "取出"],
  },
  {
    source: "bank-czbank", // 浙商银行
    match: /浙商银行|czbank/i,
    dateCols: ["交易日期", "记账日期", "日期"],
    amountCols: ["交易金额", "金额", "发生额"],
    payeeCols: ["交易对方", "对方户名", "收款人"],
    noteCols: ["摘要", "备注", "用途", "附言"],
    balanceCols: ["余额", "账户余额"],
    accountCols: ["卡号", "账号", "账户"],
    txNoCols: ["交易流水号", "流水号"],
    signedAmount: true,
  },
  {
    source: "bank-spdb", // 浦发银行
    match: /浦发银行|浦发|spdb|shanghai pudong/i,
    dateCols: ["交易日期", "记账日期", "日期"],
    amountCols: ["交易金额", "金额", "发生额"],
    payeeCols: ["交易对方", "对方户名", "收款人", "付款人"],
    noteCols: ["摘要", "备注", "附言"],
    balanceCols: ["余额", "账户余额"],
    accountCols: ["卡号", "账号", "账户"],
    txNoCols: ["交易流水号", "流水号"],
    dirIn: ["收入", "贷方", "存入"],
    dirOut: ["支出", "借方", "取出"],
  },
  {
    source: "bank-icbc", // 工商银行
    match: /工商银行|工行|icbc/i,
    dateCols: ["交易日期", "记账日期", "日期"],
    amountCols: ["交易金额", "金额", "发生额", "借贷金额"],
    payeeCols: ["交易对方", "对方户名", "收款人", "付款人"],
    noteCols: ["摘要", "备注", "附言", "业务类型"],
    balanceCols: ["余额", "账户余额"],
    accountCols: ["卡号", "账号", "账户"],
    txNoCols: ["交易流水号", "流水号"],
    dirIn: ["贷方金额", "收入", "存入", "贷"],
    dirOut: ["借方金额", "支出", "取出", "借"],
  },
  {
    source: "bank-ccb", // 建设银行
    match: /建设银行|建行|ccb/i,
    dateCols: ["交易日期", "记账日期", "日期"],
    amountCols: ["交易金额", "金额", "发生额"],
    payeeCols: ["交易对方", "对方户名", "收款人", "付款人"],
    noteCols: ["摘要", "备注", "附言"],
    balanceCols: ["余额", "账户余额"],
    accountCols: ["卡号", "账号", "账户"],
    txNoCols: ["交易流水号", "流水号"],
    signedAmount: true,
  },
  {
    source: "bank-generic",
    match: /.*/,
    dateCols: ["交易日期", "交易时间", "记账日期", "日期", "date"],
    amountCols: ["交易金额", "金额", "发生额", "amount"],
    payeeCols: ["交易对方", "对方户名", "收款人", "付款人", "商户名称", "payee"],
    noteCols: ["摘要", "备注", "说明", "description", "note"],
    balanceCols: ["余额", "账户余额", "balance"],
    accountCols: ["卡号", "账号", "账户", "account"],
    txNoCols: ["交易流水号", "流水号"],
    dirIn: ["收入", "贷方", "存入", "credit"],
    dirOut: ["支出", "借方", "取出", "debit"],
  },
];

export function detectBank(name: string, rows: string[][]): BankDef | null {
  for (const def of BANK_DEFS) {
    if (def.match.test(name)) {
      // generic matches everything — only use if no other match & headers look like a bank
      if (def.source === "bank-generic") continue;
      return def;
    }
  }
  // content-based: header row has date+amount columns
  const g = BANK_DEFS[BANK_DEFS.length - 1];
  if (findHeader(rows, ["日期"]) >= 0 || findHeader(rows, ["交易"]) >= 0) {
    return g;
  }
  return null;
}

export function parseBank(file: string, def: BankDef): ParseResult {
  const { rows } = readSheet(file);
  const errors: ParseResult["errors"] = [];
  const txs: RawTx[] = [];

  const headerIdx = findHeader(rows, ["日期"]);
  if (headerIdx < 0) {
    return {
      source: def.source,
      txs,
      errors: [{ row: 0, message: "未找到表头（日期列）" }],
    };
  }

  const header = rows[headerIdx].map((h) => h.trim());
  const iDate = col(header, def.dateCols);
  const iAmount = col(header, def.amountCols);
  const iPayee = col(header, def.payeeCols);
  const iNote = col(header, def.noteCols);
  const iBalance = col(header, def.balanceCols);
  const iAccount = col(header, def.accountCols);
  const iTxNo = col(header, def.txNoCols);
  const iCurrency = col(header, ["交易币种", "币种", "currency"]);

  if (iDate < 0 || iAmount < 0) {
    return {
      source: def.source,
      txs,
      errors: [{ row: 0, message: `未找到日期或金额列，表头: ${header.join(",")}` }],
    };
  }

  // direction columns: ICBC/BOC style separate 借方金额/贷方金额 columns
  const iDirIn = def.dirIn ? col(header, def.dirIn) : -1;
  const iDirOut = def.dirOut ? col(header, def.dirOut) : -1;
  // generic 收/支 column
  const iDirCol = col(header, ["收/支", "收支", "借贷标志", "借贷方向"]);

  for (let r = headerIdx + 1; r < rows.length; r++) {
    const row = rows[r];
    const cell = (i: number) => (i >= 0 ? (row[i] ?? "").trim() : "");

    const dateParsed = parseDate(cell(iDate));
    if (!dateParsed) {
      if (row.some((c) => c.trim() !== "")) {
        errors.push({ row: r + 1, message: `无法解析日期: ${cell(iDate)}` });
      }
      continue;
    }

    // amount: may be one column, or separate in/out columns
    let amount = parseAmount(cell(iAmount));
    let direction: "in" | "out" | null = null;

    const inAmt = iDirIn >= 0 ? parseAmount(cell(iDirIn)) : null;
    const outAmt = iDirOut >= 0 ? parseAmount(cell(iDirOut)) : null;

    if (inAmt != null && inAmt !== 0 && (outAmt == null || outAmt === 0)) {
      amount = inAmt;
      direction = "in";
    } else if (outAmt != null && outAmt !== 0) {
      amount = outAmt;
      direction = "out";
    }

    if (amount == null) {
      if (row.some((c) => c.trim() !== "")) {
        errors.push({ row: r + 1, message: `无法解析金额: ${cell(iAmount)}` });
      }
      continue;
    }

    if (direction === null) {
      const dirText = cell(iDirCol);
      if (/收入|贷|存入/.test(dirText)) direction = "in";
      else if (/支出|借|取出/.test(dirText)) direction = "out";
      else direction = amount < 0 ? "out" : "in";
    }

    const balance = iBalance >= 0 ? parseAmount(cell(iBalance)) : null;
    const payee = cell(iPayee);

    txs.push({
      id: txId(dateParsed.date, Math.abs(amount), direction, payee, `${dateParsed.time ?? ""}|${cell(iNote)}|${cell(iAccount)}|${balance ?? ""}`, def.source, cell(iTxNo) || undefined),
      date: dateParsed.date,
      time: dateParsed.time,
      amount: Math.abs(amount),
      direction,
      currency: normalizeStatementCurrency(cell(iCurrency)),
      payee,
      note: cell(iNote),
      rawCategory: cell(iNote).slice(0, 40),
      rawAccount: cell(iAccount) || file,
      balanceAfter: balance ?? undefined,
      sourceTxId: cell(iTxNo) || undefined,
      source: def.source,
      sourceFile: file,
      row: r + 1,
      eventType: /还款|转账|转入|转出|充值|提现/.test(cell(iNote)) ? "transfer" : direction === "in" ? "income" : "expense",
      excludedReason: amount === 0 ? "零金额" : undefined,
      issues: iDirCol < 0 && inAmt == null && outAmt == null ? ["收支待确认"] : [],
    });
  }

  return { source: def.source, txs, errors };
}
