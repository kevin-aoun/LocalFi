
export function canonicalDecimal(input: string | number): string {
  let value = typeof input === "number" ? String(input) : input;
  if (typeof input === "number" && !Number.isFinite(input)) {
    throw new Error("quantity must be finite");
  }
  value = value.trim();
  const match = /^([+-]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(value);
  if (!match) throw new Error("quantity must be a decimal number");

  const negative = match[1] === "-";
  const integer = match[2];
  const fraction = match[3] ?? "";
  const exponent = Number(match[4] ?? 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 10_000) {
    throw new Error("quantity exponent is out of range");
  }

  const digits = integer + fraction;
  const point = integer.length + exponent;
  let expanded: string;
  if (point <= 0) expanded = `0.${"0".repeat(-point)}${digits}`;
  else if (point >= digits.length) expanded = digits + "0".repeat(point - digits.length);
  else expanded = `${digits.slice(0, point)}.${digits.slice(point)}`;

  let [whole, decimals = ""] = expanded.split(".");
  whole = whole.replace(/^0+(?=\d)/, "");
  decimals = decimals.replace(/0+$/, "");
  const body = decimals ? `${whole}.${decimals}` : whole;
  if (/^0(?:\.0*)?$/.test(body)) return "0";
  return negative ? `-${body}` : body;
}

function parts(value: string): { negative: boolean; digits: bigint; scale: number } {
  const canonical = canonicalDecimal(value);
  const negative = canonical.startsWith("-");
  const unsigned = negative ? canonical.slice(1) : canonical;
  const [whole, fraction = ""] = unsigned.split(".");
  return { negative, digits: BigInt(whole + fraction), scale: fraction.length };
}

export function addCanonicalDecimals(left: string, right: string): string {
  const a = parts(left);
  const b = parts(right);
  const scale = Math.max(a.scale, b.scale);
  const aValue = (a.negative ? -a.digits : a.digits) * BigInt(10) ** BigInt(scale - a.scale);
  const bValue = (b.negative ? -b.digits : b.digits) * BigInt(10) ** BigInt(scale - b.scale);
  const total = aValue + bValue;
  const negative = total < BigInt(0);
  const digits = (negative ? -total : total).toString().padStart(scale + 1, "0");
  const raw = scale === 0
    ? digits
    : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  return canonicalDecimal(`${negative ? "-" : ""}${raw}`);
}

export function negateCanonicalDecimal(value: string): string {
  const canonical = canonicalDecimal(value);
  return canonical === "0" ? "0" : canonical.startsWith("-") ? canonical.slice(1) : `-${canonical}`;
}
