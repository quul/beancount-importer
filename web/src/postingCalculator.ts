type AmountResult = { value: string; error?: never } | { error: string; value?: never };
type Fraction = { numerator: bigint; denominator: bigint };

export function calculatePostingAmount(input: string): AmountResult {
  const expression = input.normalize("NFKC").trim().replaceAll("×", "*").replaceAll("÷", "/").replaceAll("−", "-");
  if (!expression) return { error: "请输入金额" };
  if (Number.isFinite(Number(expression))) return { value: expression };
  if (expression.length > 256) return { error: "算式太长" };

  const tokens = expression.match(/\d+(?:\.\d*)?|\.\d+|\S/g) ?? [];
  const syntaxError = new Error("金额或算式无效");
  let index = 0;

  function factor(): Fraction {
    const token = tokens[index++];
    if (token === "+") return factor();
    if (token === "-") {
      const value = factor();
      return { ...value, numerator: -value.numerator };
    }
    if (token === "(") {
      const value = sum();
      if (tokens[index++] !== ")") throw new Error("请配对括号");
      return value;
    }
    if (!token || !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(token)) throw syntaxError;
    const [whole, fraction = ""] = token.split(".");
    return { numerator: BigInt(whole + fraction), denominator: 10n ** BigInt(fraction.length) };
  }

  function product(): Fraction {
    let value = factor();
    while (tokens[index] === "*" || tokens[index] === "/") {
      const multiply = tokens[index++] === "*";
      const right = factor();
      if (!multiply && right.numerator === 0n) throw new Error("除数不能为 0");
      value = multiply
        ? { numerator: value.numerator * right.numerator, denominator: value.denominator * right.denominator }
        : { numerator: value.numerator * right.denominator, denominator: value.denominator * right.numerator };
    }
    return value;
  }

  function sum(): Fraction {
    let value = product();
    while (tokens[index] === "+" || tokens[index] === "-") {
      const sign = tokens[index++] === "+" ? 1n : -1n;
      const right = product();
      value = {
        numerator: value.numerator * right.denominator + sign * right.numerator * value.denominator,
        denominator: value.denominator * right.denominator,
      };
    }
    return value;
  }

  try {
    const { numerator, denominator } = sum();
    if (index !== tokens.length) throw syntaxError;
    const negative = (numerator < 0n) !== (denominator < 0n);
    const magnitude = numerator < 0n ? -numerator : numerator;
    const divisor = denominator < 0n ? -denominator : denominator;
    const cents = (magnitude * 200n + divisor) / (divisor * 2n);
    const fraction = (cents % 100n).toString().padStart(2, "0").replace(/0+$/, "");
    const sign = negative && cents !== 0n ? "-" : "";
    return { value: `${sign}${cents / 100n}${fraction ? `.${fraction}` : ""}` };
  } catch (error) {
    return { error: error instanceof Error ? error.message : syntaxError.message };
  }
}
