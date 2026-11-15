import { describe, expect, it } from "vitest";
import { formatCents, parseDollars } from "./money";

describe("parseDollars", () => {
  it("reads dollars and cents", () => {
    expect(parseDollars("4.99")).toBe(499);
    expect(parseDollars("5")).toBe(500);
    expect(parseDollars("0.5")).toBe(50);
    expect(parseDollars("$12.30")).toBe(1230);
    expect(parseDollars("  7.05 ")).toBe(705);
  });

  it("is exact for amounts that floating point gets wrong", () => {
    // Number("1.15") * 100 is 114.99999999999999
    expect(parseDollars("1.15")).toBe(115);
    expect(parseDollars("4.35")).toBe(435);
    expect(parseDollars("8.20")).toBe(820);
  });

  it("round-trips every amount up to $20", () => {
    for (let cents = 0; cents <= 2000; cents++) {
      expect(parseDollars(formatCents(cents))).toBe(cents);
    }
  });

  it("rejects anything that is not a plain amount", () => {
    for (const bad of ["", "abc", "-5", "4.999", "1,000", "4.", ".50", "1e3", "5 dollars"]) {
      expect(parseDollars(bad), bad).toBeNull();
    }
  });
});

describe("formatCents", () => {
  it("always shows two decimal places", () => {
    expect(formatCents(499)).toBe("$4.99");
    expect(formatCents(500)).toBe("$5.00");
    expect(formatCents(5)).toBe("$0.05");
    expect(formatCents(0)).toBe("$0.00");
    expect(formatCents(123456)).toBe("$1,234.56");
  });
});
