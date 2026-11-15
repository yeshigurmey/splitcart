/**
 * The Stripe implementation of PaymentGateway, for Stripe's test mode.
 *
 * It talks to Stripe's REST API directly with fetch, so every request the
 * app makes is visible in this one file:
 *
 *   authorize  POST /v1/payment_intents             capture_method=manual
 *   capture    POST /v1/payment_intents/:id/capture
 *   release    POST /v1/payment_intents/:id/cancel
 *   refund     POST /v1/refunds
 *
 * A PaymentIntent created with capture_method=manual and confirmed straight
 * away ends in the status "requires_capture": the card has been authorized
 * and the money is held, but nothing has been taken yet.
 *
 * Stripe's API takes form-encoded bodies, a secret key as a Bearer token and
 * an Idempotency-Key header.
 */

import {
  GatewayError,
  type AuthorizeRequest,
  type AuthorizeResult,
  type PaymentGateway,
} from "./payments";

const STRIPE_API = "https://api.stripe.com";

type Fetch = typeof fetch;

interface StripeError {
  type?: string;
  message?: string;
}

export class StripeGateway implements PaymentGateway {
  readonly name = "stripe-test";

  private readonly secretKey: string;
  private readonly fetchFn: Fetch;

  /** `fetchFn` exists so tests can stand in for the network. */
  constructor(secretKey: string, fetchFn: Fetch = fetch) {
    // Refuse live keys outright. This project only ever places test holds,
    // and this check makes it impossible to charge a real card by accident.
    if (!secretKey.startsWith("sk_test_")) {
      throw new Error("StripeGateway only accepts a test mode secret key (sk_test_...).");
    }
    this.secretKey = secretKey;
    this.fetchFn = fetchFn;
  }

  async authorize(request: AuthorizeRequest): Promise<AuthorizeResult> {
    const { status, body } = await this.post(
      "/v1/payment_intents",
      {
        amount: String(request.amountCents),
        currency: request.currency,
        capture_method: "manual",
        payment_method: request.paymentMethod,
        "payment_method_types[]": "card",
        confirm: "true",
        description: request.description,
      },
      request.idempotencyKey,
    );

    const error = body.error as StripeError | undefined;
    if (error) {
      // A card_error is the bank saying no. That is an answer, not an outage.
      if (error.type === "card_error") {
        return { ok: false, reason: error.message ?? "Your card was declined." };
      }
      throw new GatewayError(`Stripe refused the request (${status}): ${error.message ?? "unknown error"}`);
    }

    if (body.status === "requires_capture" && typeof body.id === "string") {
      return { ok: true, ref: body.id };
    }
    // For example "requires_action" when the bank wants a 3D Secure check,
    // which needs the cardholder in a browser. Cancel so nothing stays half done.
    if (typeof body.id === "string") {
      await this.release(body.id, `${request.idempotencyKey}:abandon`);
    }
    return { ok: false, reason: "This card needs extra verification, which is not supported yet." };
  }

  async capture(ref: string, idempotencyKey: string): Promise<void> {
    await this.mustSucceed(`/v1/payment_intents/${encodeURIComponent(ref)}/capture`, {}, idempotencyKey);
  }

  async release(ref: string, idempotencyKey: string): Promise<void> {
    await this.mustSucceed(`/v1/payment_intents/${encodeURIComponent(ref)}/cancel`, {}, idempotencyKey);
  }

  async refund(ref: string, idempotencyKey: string): Promise<void> {
    await this.mustSucceed("/v1/refunds", { payment_intent: ref }, idempotencyKey);
  }

  private async mustSucceed(
    path: string,
    params: Record<string, string>,
    idempotencyKey: string,
  ): Promise<void> {
    const { status, body } = await this.post(path, params, idempotencyKey);
    const error = body.error as StripeError | undefined;
    if (error) {
      throw new GatewayError(`Stripe refused the request (${status}): ${error.message ?? "unknown error"}`);
    }
  }

  private async post(
    path: string,
    params: Record<string, string>,
    idempotencyKey: string,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    let response: Response;
    try {
      response = await this.fetchFn(STRIPE_API + path, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.secretKey}`,
          "Content-Type": "application/x-www-form-urlencoded",
          "Idempotency-Key": idempotencyKey,
        },
        body: new URLSearchParams(params).toString(),
      });
    } catch (cause) {
      // The request may or may not have arrived. Because of the idempotency
      // key, sending it again later cannot create a second hold.
      throw new GatewayError(`Could not reach Stripe: ${String(cause)}`);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new GatewayError(`Stripe sent an unreadable response (${response.status}).`);
    }
    if (typeof body !== "object" || body === null) {
      throw new GatewayError(`Stripe sent an unexpected response (${response.status}).`);
    }
    return { status: response.status, body: body as Record<string, unknown> };
  }
}
