import { DEFAULT_MANUAL_CURRENCY, validateManualTransaction, type ManualTransactionInput } from "../../src/shared/manual-batch.js";
import { CNY_SETTLEMENT_REQUIRED, needsCnySettlement } from "../../src/shared/settlement.js";
import type { LedgerBalances, ParsedAccount } from "../../src/shared/types.js";

type DecimalBalance = { units: bigint; scale: number };
export type BalanceValue = { currency: string; amount: string } | { currency: string; message: string };

function decimal(value: string): DecimalBalance {
  const [whole, fraction = ""] = value.split(".");
  return { units: BigInt(whole + fraction), scale: fraction.length };
}

function subtract(balance: DecimalBalance, amount: DecimalBalance): DecimalBalance {
  const scale = Math.max(balance.scale, amount.scale);
  const units = balance.units * 10n ** BigInt(scale - balance.scale) - amount.units * 10n ** BigInt(scale - amount.scale);
  return { units, scale };
}

function balanceValue(currency: string, value: DecimalBalance | null): BalanceValue {
  if (value === null) return { currency, message: CNY_SETTLEMENT_REQUIRED };
  const sign = value.units < 0n ? "-" : "";
  const digits = (value.units < 0n ? -value.units : value.units).toString().padStart(value.scale + 1, "0");
  const wholeLength = digits.length - value.scale;
  const fraction = digits.slice(wholeLength).replace(/0+$/, "").padEnd(2, "0");
  return { currency, amount: sign + digits.slice(0, wholeLength) + "." + fraction };
}

export function projectManualBalances(rows: readonly ManualTransactionInput[], fundingAccount: string,
  accounts: ReadonlyMap<string, ParsedAccount>, opening: LedgerBalances, requireCnySettlement: boolean) {
  const zero = decimal("0");
  const balances = new Map<string, Map<string, DecimalBalance | null>>();
  const balancesFor = (account: string) => {
    let running = balances.get(account);
    if (!running) {
      running = new Map(Object.entries(opening[account] ?? {}).map(([currency, value]) => [currency, decimal(value)]));
      balances.set(account, running);
    }
    return running;
  };
  const steps = rows.map((row) => {
    const account = row.fundingAccount ?? fundingAccount;
    const { amount, signedAmount, currency, problems } = validateManualTransaction(row, accounts.get(account), requireCnySettlement);
    if (amount === undefined) return { account, currency, message: row.amount.trim() ? "金额无效" : "待填金额" };
    const problem = problems.fundingAccount || problems.currency || problems.date;
    if (problem) return { account, currency, message: problem };
    const running = balancesFor(account);
    const settling = needsCnySettlement({ currency, requireCnySettlement });
    const balanceCurrency = settling ? DEFAULT_MANUAL_CURRENCY : currency;
    const previous = running.get(balanceCurrency);
    const next = settling || previous === null ? null
      : subtract(previous ?? zero, decimal(signedAmount));
    running.set(balanceCurrency, next);
    return { account, ...balanceValue(balanceCurrency, next) };
  });

  const running = balancesFor(fundingAccount);
  const definition = accounts.get(fundingAccount);
  const declared = definition?.currencies ?? (definition?.currency ? [definition.currency] : []);
  const currencies = [...new Set([...running.keys(), ...declared])].sort();
  if (!currencies.length) currencies.push(DEFAULT_MANUAL_CURRENCY);
  return {
    steps,
    opening: currencies.map((currency) => balanceValue(currency, decimal(opening[fundingAccount]?.[currency] ?? "0"))),
    closing: currencies.map((currency) => {
      const value = running.get(currency);
      return balanceValue(currency, value === undefined ? zero : value);
    }),
  };
}
