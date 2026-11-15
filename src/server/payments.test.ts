import { describe, expect, it } from "vitest";
import { FakeGateway, GatewayError, isTestCard } from "./payments";
import { StripeGateway } from "./stripe";

const hold = (overrides = {}) => ({
  amountCents: 1450,
  currency: "cad",
  paymentMethod: "pm_card_visa",
  description: "test",
  idempotencyKey: "key-1",
  ...overrides,
});

describe("FakeGateway", () => {
  it("holds, then captures, then refunds", async () => {
    const gateway = new FakeGateway();
    const result = await gateway.authorize(hold());
    if (!result.ok) throw new Error("expected approval");
    expect(gateway.totals().authorized).toBe(1450);

    await gateway.capture(result.ref, "cap-1");
    expect(gateway.totals()).toMatchObject({ authorized: 0, captured: 1450 });

    await gateway.refund(result.ref, "ref-1");
    expect(gateway.totals()).toMatchObject({ captured: 0, refunded: 1450 });
  });

  it("releases a hold that was never captured", async () => {
    const gateway = new FakeGateway();
    const result = await gateway.authorize(hold());
    if (!result.ok) throw new Error("expected approval");

    await gateway.release(result.ref, "rel-1");
    expect(gateway.totals()).toMatchObject({ authorized: 0, released: 1450 });
  });

  it("declines the test cards that are meant to be declined", async () => {
    const gateway = new FakeGateway();
    expect(await gateway.authorize(hold({ paymentMethod: "pm_card_chargeDeclined" }))).toEqual({
      ok: false,
      reason: "Your card was declined.",
    });
    expect(gateway.totals().authorized).toBe(0);
  });

  it("creates one hold when the same idempotency key is sent twice", async () => {
    const gateway = new FakeGateway();
    const first = await gateway.authorize(hold());
    const second = await gateway.authorize(hold());

    expect(second).toEqual(first);
    expect(gateway.totals().authorized).toBe(1450);
  });

  it("captures once when the same capture is retried", async () => {
    const gateway = new FakeGateway();
    const result = await gateway.authorize(hold());
    if (!result.ok) throw new Error("expected approval");

    await gateway.capture(result.ref, "cap-1");
    await gateway.capture(result.ref, "cap-1");
    expect(gateway.totals().captured).toBe(1450);
  });

  it("refuses moves that make no sense", async () => {
    const gateway = new FakeGateway();
    const result = await gateway.authorize(hold());
    if (!result.ok) throw new Error("expected approval");

    await expect(gateway.refund(result.ref, "ref-1")).rejects.toThrow(GatewayError);
    await gateway.capture(result.ref, "cap-1");
    await expect(gateway.release(result.ref, "rel-1")).rejects.toThrow(GatewayError);
    await expect(gateway.capture("nope", "cap-2")).rejects.toThrow(GatewayError);
  });

  it("can simulate an outage", async () => {
    const gateway = new FakeGateway();
    gateway.failNext("authorize");
    await expect(gateway.authorize(hold())).rejects.toThrow(GatewayError);
    expect((await gateway.authorize(hold())).ok).toBe(true);
  });
});

describe("test cards", () => {
  it("recognises only the cards on the list", () => {
    expect(isTestCard("pm_card_visa")).toBe(true);
    expect(isTestCard("pm_1Nabc")).toBe(false);
  });
});

/** A stand-in for fetch that records requests and replies from a queue. */
function fakeFetch(replies: { status: number; body: unknown }[]) {
  const requests: { url: string; headers: Record<string, string>; params: URLSearchParams }[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(url),
      headers: init?.headers as Record<string, string>,
      params: new URLSearchParams(String(init?.body ?? "")),
    });
    const reply = replies.shift();
    if (!reply) throw new Error("network down");
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  }) as typeof fetch;
  return { fn, requests };
}

describe("StripeGateway", () => {
  it("refuses a live key", () => {
    expect(() => new StripeGateway("sk_live_abc")).toThrow(/test mode/);
  });

  it("asks Stripe for a manual-capture PaymentIntent", async () => {
    const net = fakeFetch([{ status: 200, body: { id: "pi_123", status: "requires_capture" } }]);
    const gateway = new StripeGateway("sk_test_abc", net.fn);

    expect(await gateway.authorize(hold())).toEqual({ ok: true, ref: "pi_123" });

    const [request] = net.requests;
    expect(request.url).toBe("https://api.stripe.com/v1/payment_intents");
    expect(request.headers.Authorization).toBe("Bearer sk_test_abc");
    expect(request.headers["Idempotency-Key"]).toBe("key-1");
    expect(Object.fromEntries(request.params)).toEqual({
      amount: "1450",
      currency: "cad",
      capture_method: "manual",
      payment_method: "pm_card_visa",
      "payment_method_types[]": "card",
      confirm: "true",
      description: "test",
    });
  });

  it("reports a declined card as an answer, not an error", async () => {
    const net = fakeFetch([
      { status: 402, body: { error: { type: "card_error", message: "Your card was declined." } } },
    ]);
    const gateway = new StripeGateway("sk_test_abc", net.fn);

    expect(await gateway.authorize(hold())).toEqual({
      ok: false,
      reason: "Your card was declined.",
    });
  });

  it("throws a retryable error when Stripe rejects the request itself", async () => {
    const net = fakeFetch([
      { status: 401, body: { error: { type: "invalid_request_error", message: "Invalid API Key" } } },
    ]);
    const gateway = new StripeGateway("sk_test_abc", net.fn);
    await expect(gateway.authorize(hold())).rejects.toThrow(/Invalid API Key/);
  });

  it("throws a retryable error when the network fails", async () => {
    const gateway = new StripeGateway("sk_test_abc", fakeFetch([]).fn);
    await expect(gateway.authorize(hold())).rejects.toThrow(GatewayError);
  });

  it("cancels a PaymentIntent that needs extra verification", async () => {
    const net = fakeFetch([
      { status: 200, body: { id: "pi_3ds", status: "requires_action" } },
      { status: 200, body: { id: "pi_3ds", status: "canceled" } },
    ]);
    const gateway = new StripeGateway("sk_test_abc", net.fn);

    const result = await gateway.authorize(hold());
    expect(result.ok).toBe(false);
    expect(net.requests[1].url).toBe("https://api.stripe.com/v1/payment_intents/pi_3ds/cancel");
  });

  it("captures, releases and refunds through the right endpoints", async () => {
    const ok = { status: 200, body: { id: "x" } };
    const net = fakeFetch([ok, ok, ok]);
    const gateway = new StripeGateway("sk_test_abc", net.fn);

    await gateway.capture("pi_1", "cap");
    await gateway.release("pi_2", "rel");
    await gateway.refund("pi_3", "ref");

    expect(net.requests.map((r) => r.url)).toEqual([
      "https://api.stripe.com/v1/payment_intents/pi_1/capture",
      "https://api.stripe.com/v1/payment_intents/pi_2/cancel",
      "https://api.stripe.com/v1/refunds",
    ]);
    expect(net.requests[2].params.get("payment_intent")).toBe("pi_3");
    expect(net.requests.map((r) => r.headers["Idempotency-Key"])).toEqual(["cap", "rel", "ref"]);
  });

  it("throws when a capture is refused", async () => {
    const net = fakeFetch([
      { status: 400, body: { error: { type: "invalid_request_error", message: "already captured" } } },
    ]);
    const gateway = new StripeGateway("sk_test_abc", net.fn);
    await expect(gateway.capture("pi_1", "cap")).rejects.toThrow(/already captured/);
  });
});
