import { describe, expect, it } from "vitest";
import { splitEvenly, splitProportionally } from "./split";

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

// Small seeded random number generator so the randomized test is repeatable.
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("splitEvenly", () => {
  it("splits an amount that divides exactly", () => {
    expect(splitEvenly(900, 3)).toEqual([300, 300, 300]);
  });

  it("gives the leftover cents to the first people, one each", () => {
    // $47.33 between three people: 4733 = 3 * 1577 + 2
    expect(splitEvenly(4733, 3)).toEqual([1578, 1578, 1577]);
  });

  it("handles a total smaller than the number of people", () => {
    expect(splitEvenly(2, 5)).toEqual([1, 1, 0, 0, 0]);
  });

  it("handles one person and a zero total", () => {
    expect(splitEvenly(4733, 1)).toEqual([4733]);
    expect(splitEvenly(0, 4)).toEqual([0, 0, 0, 0]);
  });

  it("always adds back up to the total", () => {
    for (let total = 0; total <= 500; total++) {
      for (let people = 1; people <= 9; people++) {
        expect(sum(splitEvenly(total, people))).toBe(total);
      }
    }
  });

  it("rejects amounts that are not whole cents", () => {
    expect(() => splitEvenly(47.33, 3)).toThrow(RangeError);
    expect(() => splitEvenly(-100, 3)).toThrow(RangeError);
    expect(() => splitEvenly(Number.NaN, 3)).toThrow(RangeError);
  });

  it("rejects a bad number of people", () => {
    expect(() => splitEvenly(100, 0)).toThrow(RangeError);
    expect(() => splitEvenly(100, 1.5)).toThrow(RangeError);
    expect(() => splitEvenly(100, -2)).toThrow(RangeError);
  });
});

describe("splitProportionally", () => {
  it("splits exactly when the proportions divide cleanly", () => {
    expect(splitProportionally(500, [1000, 3000])).toEqual([125, 375]);
  });

  it("gives a missing cent to the earliest person when remainders tie", () => {
    expect(splitProportionally(100, [1, 1, 1])).toEqual([34, 33, 33]);
  });

  it("gives a missing cent to the largest remainder, not the first person", () => {
    // Exact shares are 3.33 and 6.67, so the second person gets the cent.
    expect(splitProportionally(10, [1, 2])).toEqual([3, 7]);
  });

  it("splits a delivery fee by how much each household is buying", () => {
    // $6.99 fee, households buying $45.00, $25.00 and $10.00.
    // Exact shares: 393.19, 218.44, 87.38 cents, so one cent is left over
    // and goes to the second household (largest discarded fraction).
    expect(splitProportionally(699, [4500, 2500, 1000])).toEqual([393, 219, 87]);
  });

  it("charges nothing to someone with weight zero", () => {
    expect(splitProportionally(100, [0, 1, 1])).toEqual([0, 50, 50]);
    expect(splitProportionally(101, [0, 1, 1])).toEqual([0, 51, 50]);
  });

  it("falls back to an even split when every weight is zero", () => {
    expect(splitProportionally(100, [0, 0, 0])).toEqual([34, 33, 33]);
  });

  it("handles a single person", () => {
    expect(splitProportionally(699, [4500])).toEqual([699]);
  });

  it("always adds up to the total and stays within one cent of the exact share", () => {
    const random = mulberry32(2026);
    for (let run = 0; run < 2000; run++) {
      const people = 1 + Math.floor(random() * 8);
      const total = Math.floor(random() * 20000);
      const weights = Array.from({ length: people }, () => Math.floor(random() * 10000));
      const weightSum = sum(weights);

      const shares = splitProportionally(total, weights);

      expect(sum(shares)).toBe(total);
      shares.forEach((share, i) => {
        expect(Number.isInteger(share)).toBe(true);
        expect(share).toBeGreaterThanOrEqual(0);
        if (weightSum > 0) {
          const exact = (total * weights[i]) / weightSum;
          expect(share).toBeGreaterThanOrEqual(Math.floor(exact));
          expect(share).toBeLessThanOrEqual(Math.ceil(exact));
        }
      });
    }
  });

  it("rejects bad input", () => {
    expect(() => splitProportionally(100, [])).toThrow(RangeError);
    expect(() => splitProportionally(100, [1, -1])).toThrow(RangeError);
    expect(() => splitProportionally(100, [1.5, 2])).toThrow(RangeError);
    expect(() => splitProportionally(10.5, [1, 2])).toThrow(RangeError);
  });
});
