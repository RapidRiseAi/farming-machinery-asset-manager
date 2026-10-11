/**
 * Exact arithmetic for the assistant's AI.
 *
 * Language models add up badly: they read "R 49 691 over 2 242 litres" and write a price per
 * litre that is close and wrong. Every figure the assistant works out itself (an average, a
 * share, a rate, a difference) goes through here instead, so the number on screen is the
 * number the data gives.
 *
 * A small recursive-descent parser over a closed grammar, never `eval`: numbers, + - * / ^,
 * brackets, and a fixed set of functions. Anything else is refused with a reason the model
 * can act on.
 *
 *   sum(a, b, ...)   avg(a, b, ...)   min(...)   max(...)
 *   round(x)  round(x, places)   abs(x)   sqrt(x)
 *   pct(part, whole)      part as a percentage of whole
 *   change(from, to)      percentage change from one to the other
 */

const MAX_EXPRESSION = 500;
const MAX_ARGUMENTS = 200;

type Token = { kind: "num"; value: number } | { kind: "id"; value: string } | { kind: "op"; value: string };

export class CalcError extends Error {}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      let j = i;
      while (j < input.length && /[0-9.]/.test(input[j])) j += 1;
      // A trailing exponent, as JSON writes very large or small numbers: 1.5e-7.
      if (j < input.length && /[eE]/.test(input[j]) && /[-+0-9]/.test(input[j + 1] ?? "")) {
        j += 2;
        while (j < input.length && /[0-9]/.test(input[j])) j += 1;
      }
      const text = input.slice(i, j);
      const value = Number(text);
      if (!Number.isFinite(value) || (text.match(/\./g) ?? []).length > 1) throw new CalcError(`"${text}" is not a number`);
      tokens.push({ kind: "num", value });
      i = j;
      continue;
    }
    if (/[a-z]/i.test(ch)) {
      let j = i;
      while (j < input.length && /[a-z]/i.test(input[j])) j += 1;
      tokens.push({ kind: "id", value: input.slice(i, j).toLowerCase() });
      i = j;
      continue;
    }
    if ("+-*/^(),".includes(ch)) {
      tokens.push({ kind: "op", value: ch });
      i += 1;
      continue;
    }
    throw new CalcError(`"${ch}" is not allowed; use numbers, + - * / ^, brackets and the listed functions`);
  }
  return tokens;
}

const FUNCTIONS: Record<string, (args: number[]) => number> = {
  sum: (a) => a.reduce((t, x) => t + x, 0),
  avg: (a) => {
    if (!a.length) throw new CalcError("avg needs at least one number");
    return a.reduce((t, x) => t + x, 0) / a.length;
  },
  mean: (a) => FUNCTIONS.avg(a),
  min: (a) => {
    if (!a.length) throw new CalcError("min needs at least one number");
    return Math.min(...a);
  },
  max: (a) => {
    if (!a.length) throw new CalcError("max needs at least one number");
    return Math.max(...a);
  },
  round: (a) => {
    if (a.length < 1 || a.length > 2) throw new CalcError("round takes a number and, optionally, decimal places");
    const places = Math.max(0, Math.min(6, Math.trunc(a[1] ?? 0)));
    const f = 10 ** places;
    return Math.round(a[0] * f) / f;
  },
  abs: (a) => {
    if (a.length !== 1) throw new CalcError("abs takes one number");
    return Math.abs(a[0]);
  },
  sqrt: (a) => {
    if (a.length !== 1 || a[0] < 0) throw new CalcError("sqrt takes one number that is not negative");
    return Math.sqrt(a[0]);
  },
  pct: (a) => {
    if (a.length !== 2) throw new CalcError("pct takes a part and a whole");
    if (a[1] === 0) throw new CalcError("pct of a whole of zero is undefined");
    return (a[0] / a[1]) * 100;
  },
  change: (a) => {
    if (a.length !== 2) throw new CalcError("change takes a from value and a to value");
    if (a[0] === 0) throw new CalcError("a change from zero has no percentage");
    return ((a[1] - a[0]) / Math.abs(a[0])) * 100;
  },
};

class Parser {
  private at = 0;
  constructor(private readonly tokens: Token[]) {}

  parse(): number {
    const value = this.expression();
    if (this.at < this.tokens.length) throw new CalcError("unexpected text after the end of the calculation");
    return value;
  }

  private peek(): Token | undefined {
    return this.tokens[this.at];
  }

  private takeOp(op: string): boolean {
    const token = this.peek();
    if (token?.kind === "op" && token.value === op) {
      this.at += 1;
      return true;
    }
    return false;
  }

  private expression(): number {
    let value = this.term();
    for (;;) {
      if (this.takeOp("+")) value += this.term();
      else if (this.takeOp("-")) value -= this.term();
      else return value;
    }
  }

  private term(): number {
    let value = this.power();
    for (;;) {
      if (this.takeOp("*")) value *= this.power();
      else if (this.takeOp("/")) {
        const divisor = this.power();
        if (divisor === 0) throw new CalcError("division by zero");
        value /= divisor;
      } else return value;
    }
  }

  private power(): number {
    const base = this.unary();
    if (this.takeOp("^")) return base ** this.power();
    return base;
  }

  private unary(): number {
    if (this.takeOp("-")) return -this.unary();
    if (this.takeOp("+")) return this.unary();
    return this.primary();
  }

  private primary(): number {
    const token = this.peek();
    if (!token) throw new CalcError("the calculation ends too early");
    if (token.kind === "num") {
      this.at += 1;
      return token.value;
    }
    if (token.kind === "id") {
      const fn = FUNCTIONS[token.value];
      if (!fn) throw new CalcError(`"${token.value}" is not a function here; use ${Object.keys(FUNCTIONS).join(", ")}`);
      this.at += 1;
      if (!this.takeOp("(")) throw new CalcError(`${token.value} needs brackets: ${token.value}(...)`);
      const args: number[] = [];
      if (!this.takeOp(")")) {
        do {
          args.push(this.expression());
          if (args.length > MAX_ARGUMENTS) throw new CalcError("too many numbers in one function");
        } while (this.takeOp(","));
        if (!this.takeOp(")")) throw new CalcError(`${token.value}( is not closed`);
      }
      return fn(args);
    }
    if (this.takeOp("(")) {
      const value = this.expression();
      if (!this.takeOp(")")) throw new CalcError("a bracket is not closed");
      return value;
    }
    throw new CalcError(`"${token.value}" is out of place`);
  }
}

/** The value of one calculation, rounded to six decimals so float noise never shows. */
export function evaluate(expression: string): number {
  const text = expression.trim();
  if (!text) throw new CalcError("the calculation is empty");
  if (text.length > MAX_EXPRESSION) throw new CalcError(`a calculation may be at most ${MAX_EXPRESSION} characters`);
  const value = new Parser(tokenize(text)).parse();
  if (!Number.isFinite(value)) throw new CalcError("the result is not a finite number");
  return Math.round(value * 1e6) / 1e6;
}

export type Calculation = { label: string; expression: string };
export type CalculationResult = { label: string; expression: string; result?: number; error?: string };

/** Several labelled calculations in one call, so working out a figure costs one step. */
export function calculateAll(calculations: readonly Calculation[]): CalculationResult[] {
  return calculations.map(({ label, expression }) => {
    try {
      return { label, expression, result: evaluate(expression) };
    } catch (error) {
      return { label, expression, error: error instanceof CalcError ? error.message : "that could not be worked out" };
    }
  });
}
