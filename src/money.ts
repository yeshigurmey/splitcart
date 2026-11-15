/**
 * Converting between what people type ("4.99") and integer cents (499).
 *
 * The conversion works on the text itself. Doing `Number("4.99") * 100` can
 * give 498.99999999999994 for some amounts, which is the floating point
 * problem this project avoids everywhere else.
 */

const DOLLARS = /^\$?\s*(\d{1,7})(?:\.(\d{1,2}))?$/;

/** "4.99" -> 499, "5" -> 500, "$0.5" -> 50. Returns null if it is not money. */
export function parseDollars(text: string): number | null {
  const match = DOLLARS.exec(text.trim());
  if (!match) return null;
  const dollars = Number(match[1]);
  const cents = Number((match[2] ?? "").padEnd(2, "0"));
  return dollars * 100 + cents;
}

/** 499 -> "$4.99" */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100).toLocaleString("en-CA");
  return `${sign}$${whole}.${String(abs % 100).padStart(2, "0")}`;
}
