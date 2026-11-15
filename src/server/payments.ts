/**
 * What SplitCart needs from a payment provider, and a pretend provider.
 *
 * The rest of the server only knows this interface. Stripe is one
 * implementation (stripe.ts) and the FakeGateway below is another, which is
 * what makes it possible to test every money path, including declines and
 * outages, without touching a real card network.
 *
 * Money moves in two steps:
 *
 *   authorize  put a hold on the card. The money is reserved, not taken.
 *   capture    take the held money.
 *
 * and can go back in two ways:
 *
 *   release    cancel a hold that was never captured
 *   refund     send back money that was captured
 *
 * Every call carries an idempotency key. If the same key is sent twice (a
 * retry after a timeout, a double click), the provider does the work once and
 * gives the same answer both times. That is what makes retrying safe.
 */

export interface AuthorizeRequest {
  amountCents: number;
  currency: string;
  /** The provider's id for the card to hold, such as Stripe's test card "pm_card_visa". */
  paymentMethod: string;
  description: string;
  idempotencyKey: string;
}

export type AuthorizeResult =
  /** The hold is in place. `ref` is the provider's id for it. */
  | { ok: true; ref: string }
  /** The card said no. `reason` can be shown to the person paying. */
  | { ok: false; reason: string };

export interface PaymentGateway {
  readonly name: string;
  authorize(request: AuthorizeRequest): Promise<AuthorizeResult>;
  capture(ref: string, idempotencyKey: string): Promise<void>;
  release(ref: string, idempotencyKey: string): Promise<void>;
  refund(ref: string, idempotencyKey: string): Promise<void>;
}

/** The provider could not be reached or rejected the request. Safe to retry with the same key. */
export class GatewayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayError";
  }
}

/** Test cards understood by both Stripe's test mode and the FakeGateway. */
export const TEST_CARDS = [
  { id: "pm_card_visa", label: "Test Visa (approved)" },
  { id: "pm_card_mastercard", label: "Test Mastercard (approved)" },
  { id: "pm_card_chargeDeclined", label: "Test card (declined)" },
  { id: "pm_card_chargeDeclinedInsufficientFunds", label: "Test card (insufficient funds)" },
] as const;

export const isTestCard = (id: string): boolean => TEST_CARDS.some((card) => card.id === id);

type FakeHoldState = "authorized" | "captured" | "released" | "refunded";
type Operation = "authorize" | "capture" | "release" | "refund";

/**
 * An in-memory payment provider for tests and for running the app without a
 * Stripe account. It follows the same rules as a real one: idempotency keys
 * are honoured, a hold can only be captured once, and only captured money can
 * be refunded.
 */
export class FakeGateway implements PaymentGateway {
  readonly name = "fake";

  private readonly holds = new Map<string, { amountCents: number; state: FakeHoldState }>();
  private readonly authorizeResults = new Map<string, AuthorizeResult>();
  private readonly doneKeys = new Set<string>();
  private readonly outages = new Map<Operation, number>();
  private nextId = 1;

  /** Every call that reached the provider, for tests to inspect. */
  readonly calls: { operation: Operation; idempotencyKey: string }[] = [];

  /** Make the next `times` calls of one kind fail as if the provider were down. */
  failNext(operation: Operation, times = 1): void {
    this.outages.set(operation, times);
  }

  private begin(operation: Operation, idempotencyKey: string): void {
    this.calls.push({ operation, idempotencyKey });
    const remaining = this.outages.get(operation) ?? 0;
    if (remaining > 0) {
      this.outages.set(operation, remaining - 1);
      throw new GatewayError(`fake gateway: ${operation} is unavailable`);
    }
  }

  async authorize(request: AuthorizeRequest): Promise<AuthorizeResult> {
    this.begin("authorize", request.idempotencyKey);

    const earlier = this.authorizeResults.get(request.idempotencyKey);
    if (earlier) return earlier;

    let result: AuthorizeResult;
    if (request.paymentMethod === "pm_card_chargeDeclinedInsufficientFunds") {
      result = { ok: false, reason: "Your card has insufficient funds." };
    } else if (request.paymentMethod.startsWith("pm_card_chargeDeclined")) {
      result = { ok: false, reason: "Your card was declined." };
    } else {
      const ref = `fake_hold_${this.nextId++}`;
      this.holds.set(ref, { amountCents: request.amountCents, state: "authorized" });
      result = { ok: true, ref };
    }
    this.authorizeResults.set(request.idempotencyKey, result);
    return result;
  }

  async capture(ref: string, idempotencyKey: string): Promise<void> {
    this.move("capture", ref, idempotencyKey, "authorized", "captured");
  }

  async release(ref: string, idempotencyKey: string): Promise<void> {
    this.move("release", ref, idempotencyKey, "authorized", "released");
  }

  async refund(ref: string, idempotencyKey: string): Promise<void> {
    this.move("refund", ref, idempotencyKey, "captured", "refunded");
  }

  private move(
    operation: Operation,
    ref: string,
    idempotencyKey: string,
    from: FakeHoldState,
    to: FakeHoldState,
  ): void {
    this.begin(operation, idempotencyKey);
    if (this.doneKeys.has(idempotencyKey)) return; // same key again: already done

    const hold = this.holds.get(ref);
    if (!hold) throw new GatewayError(`fake gateway: no such hold ${ref}`);
    if (hold.state !== from) {
      throw new GatewayError(`fake gateway: cannot ${operation} a hold that is ${hold.state}`);
    }
    hold.state = to;
    this.doneKeys.add(idempotencyKey);
  }

  /** Total cents currently in each state, for tests to check where the money is. */
  totals(): Record<FakeHoldState, number> {
    const totals = { authorized: 0, captured: 0, released: 0, refunded: 0 };
    for (const hold of this.holds.values()) totals[hold.state] += hold.amountCents;
    return totals;
  }
}
