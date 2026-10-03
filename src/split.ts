/**
 * Fee splitting for SplitCart.
 *
 * Money is always an integer number of cents (4733 means $47.33). Floating
 * point numbers cannot represent most decimal amounts exactly, so adding up
 * shares computed with them can lose or invent a cent. Integers never do.
 *
 * Both functions return one share per person, in the same order as the input,
 * and the shares always add up to exactly the total.
 */

function assertCents(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(
      `${name} must be a non-negative integer number of cents, got ${value}`,
    );
  }
}

/**
 * Split a total equally between `people`.
 *
 * When the total does not divide evenly, the leftover cents go one each to the
 * first people in the list. 4733 cents between 3 people gives [1578, 1578, 1577].
 */
export function splitEvenly(totalCents: number, people: number): number[] {
  assertCents(totalCents, "totalCents");
  if (!Number.isSafeInteger(people) || people < 1) {
    throw new RangeError(`people must be a positive integer, got ${people}`);
  }

  const leftover = totalCents % people;
  const base = (totalCents - leftover) / people;
  return Array.from({ length: people }, (_, i) => (i < leftover ? base + 1 : base));
}

/**
 * Split a total in proportion to a weight for each person, for example a fee
 * split by how much each household is buying.
 *
 * Uses the largest remainder method: everyone first gets the whole cents of
 * their exact share, then the cents still missing go to the people whose
 * discarded fractions were largest. Ties go to whoever is listed first.
 *
 * A person with weight 0 pays nothing. If every weight is 0 there is nothing
 * to be proportional to, so the total is split evenly instead.
 */
export function splitProportionally(totalCents: number, weights: number[]): number[] {
  assertCents(totalCents, "totalCents");
  if (weights.length === 0) {
    throw new RangeError("weights must contain at least one person");
  }
  weights.forEach((w, i) => assertCents(w, `weights[${i}]`));

  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  if (totalWeight === 0) {
    return splitEvenly(totalCents, weights.length);
  }

  // A person's exact share is totalCents * weight / totalWeight, usually a
  // fraction of a cent. Keep the whole cents, and keep the fraction as an
  // integer remainder (out of totalWeight) so no floating point is involved.
  const shares: number[] = [];
  const remainders: number[] = [];
  for (const weight of weights) {
    const product = totalCents * weight;
    if (!Number.isSafeInteger(product)) {
      throw new RangeError("amounts are too large to split safely");
    }
    const remainder = product % totalWeight;
    shares.push((product - remainder) / totalWeight);
    remainders.push(remainder);
  }

  // Cents lost to rounding down. This is always fewer than the number of
  // people, and at least that many people have a nonzero remainder, so one
  // pass over the biggest remainders is enough.
  let missing = totalCents - shares.reduce((sum, share) => sum + share, 0);
  const byLargestRemainder = weights
    .map((_, i) => i)
    .sort((a, b) => remainders[b] - remainders[a] || a - b);

  for (const i of byLargestRemainder) {
    if (missing === 0) break;
    shares[i] += 1;
    missing -= 1;
  }
  return shares;
}
