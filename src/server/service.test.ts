import { describe, expect, it } from "vitest";
import { OrderError } from "../order";
import { openDb } from "./db";
import { orderTopic } from "./events";
import { FakeGateway } from "./payments";
import { AppError, Service, type OrderView, type User } from "./service";

const HOUR = 60 * 60 * 1000;
const START = Date.UTC(2026, 10, 14, 18, 0, 0);

/** A fresh database with three neighbours in one building, and a clock the test controls. */
function world() {
  const clock = { now: START };
  const gateway = new FakeGateway();
  const service = new Service({ db: openDb(":memory:"), gateway, now: () => clock.now });

  const ana = service.signup({
    name: "Ana",
    email: "ana@example.com",
    password: "password-ana",
    buildingName: "182 Maple",
  }).user;
  const code = service.building(ana.buildingId).code;
  const join = (name: string) =>
    service.signup({
      name,
      email: `${name.toLowerCase()}@example.com`,
      password: `password-${name}`,
      buildingCode: code,
    }).user;

  return { clock, gateway, service, code, ana, ben: join("Ben"), cy: join("Cy") };
}

type World = ReturnType<typeof world>;

/** Ana hosts a $5.00 delivery; Ana and Ben add items, Cy joins without any. */
async function lockedOrder(w: World): Promise<OrderView> {
  const order = w.service.createOrder(w.ana, {
    store: "FreshCo",
    deliverySlot: "Sat 2pm to 4pm",
    cutoffAt: START + 2 * HOUR,
    deliveryFeeCents: 500,
  });
  await w.service.join(w.ben, order.id);
  await w.service.join(w.cy, order.id);
  await w.service.addItem(w.ana, order.id, { name: "Rice", priceCents: 1200 });
  await w.service.addItem(w.ben, order.id, { name: "Eggs", priceCents: 400, quantity: 2 });
  return w.service.act(w.ben, order.id, "lock");
}

const member = (view: OrderView, user: User) => view.members.find((m) => m.userId === user.id)!;

async function rejection(promise: Promise<unknown>): Promise<AppError | OrderError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError || error instanceof OrderError) return error;
    throw error;
  }
  throw new Error("expected the call to be refused");
}

describe("accounts", () => {
  it("starts a building for the first neighbour and lets others join by code", () => {
    const w = world();
    expect(w.code).toMatch(/^[A-Z2-9]{6}$/);
    expect(w.ben.buildingId).toBe(w.ana.buildingId);
    expect(w.service.building(w.ana.buildingId).name).toBe("182 Maple");
  });

  it("accepts the building code in any letter case", () => {
    const w = world();
    const dee = w.service.signup({
      name: "Dee",
      email: "dee@example.com",
      password: "password-dee",
      buildingCode: ` ${w.code.toLowerCase()} `,
    }).user;
    expect(dee.buildingId).toBe(w.ana.buildingId);
  });

  it("rejects bad sign-ups", () => {
    const w = world();
    const signup = (overrides: object) => () =>
      w.service.signup({
        name: "Dee",
        email: "dee@example.com",
        password: "password-dee",
        buildingCode: w.code,
        ...overrides,
      });

    expect(signup({ email: "ANA@example.com" })).toThrow(/already an account/);
    expect(signup({ buildingCode: "NOPE99" })).toThrow(/No building has that code/);
    expect(signup({ password: "short" })).toThrow(/at least 8/);
    expect(signup({ email: "not-an-email" })).toThrow(/does not look right/);
    expect(signup({ name: "  " })).toThrow(/Name is required/);
    expect(signup({ buildingCode: "", buildingName: "" })).toThrow(/Building name is required/);
  });

  it("logs in with the right password only, and gives the same error either way", () => {
    const w = world();
    const { user, token } = w.service.login({ email: " Ana@Example.com ", password: "password-ana" });
    expect(user.id).toBe(w.ana.id);
    expect(w.service.userForToken(token)?.id).toBe(w.ana.id);

    const wrongPassword = () => w.service.login({ email: "ana@example.com", password: "nope" });
    const noSuchUser = () => w.service.login({ email: "zed@example.com", password: "nope" });
    expect(wrongPassword).toThrow("Wrong email or password.");
    expect(noSuchUser).toThrow("Wrong email or password.");
  });

  it("ends a session on logout and after 30 days", () => {
    const w = world();
    const first = w.service.login({ email: "ana@example.com", password: "password-ana" }).token;
    w.service.logout(first);
    expect(w.service.userForToken(first)).toBeNull();

    const second = w.service.login({ email: "ana@example.com", password: "password-ana" }).token;
    w.clock.now += 31 * 24 * HOUR;
    expect(w.service.userForToken(second)).toBeNull();
    expect(w.service.userForToken("made-up-token")).toBeNull();
    expect(w.service.userForToken(undefined)).toBeNull();
  });
});

describe("building an order together", () => {
  it("cuts everyone's delivery fee as neighbours add items", async () => {
    const w = world();
    const order = w.service.createOrder(w.ana, {
      store: "FreshCo",
      deliverySlot: "Sat 2pm to 4pm",
      cutoffAt: START + HOUR,
      deliveryFeeCents: 500,
    });

    let view = await w.service.addItem(w.ana, order.id, { name: "Rice", priceCents: 1200 });
    expect(view.you.feeShareCents).toBe(500); // alone: the whole fee
    expect(view.feeIfOneMoreJoinsCents).toBe(250);

    await w.service.join(w.ben, order.id);
    await w.service.addItem(w.ben, order.id, { name: "Eggs", priceCents: 800 });
    await w.service.join(w.cy, order.id);
    await w.service.addItem(w.cy, order.id, { name: "Milk", priceCents: 600 });
    await w.service.join(
      w.service.signup({ name: "Dee", email: "dee@example.com", password: "password-dee", buildingCode: w.code }).user,
      order.id,
    );

    view = w.service.getOrder(w.ana, order.id);
    expect(view.payingCount).toBe(3);
    expect(view.members.map((m) => m.feeShareCents)).toEqual([167, 167, 166, 0]);
    expect(view.you).toMatchObject({ feeShareCents: 167, totalCents: 1367 });
    expect(view.totalCents).toBe(1200 + 800 + 600 + 500);
  });

  it("shows item details only to their owner and to the host", async () => {
    const w = world();
    const order = await lockedOrder(w);

    const asHost = w.service.getOrder(w.ana, order.id);
    expect(member(asHost, w.ben).items).toEqual([
      { id: expect.any(String), name: "Eggs", priceCents: 400, quantity: 2 },
    ]);

    const asCy = w.service.getOrder(w.cy, order.id);
    expect(member(asCy, w.ben).items).toBeNull();
    expect(member(asCy, w.ben)).toMatchObject({ itemCount: 2, itemsCents: 800 });

    const asBen = w.service.getOrder(w.ben, order.id);
    expect(member(asBen, w.ben).items).toHaveLength(1);
    expect(member(asBen, w.ana).items).toBeNull();
  });

  it("lets people remove their own items but not anyone else's", async () => {
    const w = world();
    const order = w.service.createOrder(w.ana, {
      store: "FreshCo",
      deliverySlot: "Sat",
      cutoffAt: START + HOUR,
      deliveryFeeCents: 500,
    });
    await w.service.join(w.ben, order.id);
    const view = await w.service.addItem(w.ana, order.id, { name: "Rice", priceCents: 1200 });
    const riceId = member(view, w.ana).items![0].id;

    expect((await rejection(w.service.removeItem(w.ben, order.id, riceId))).message).toBe("Item not found.");
    const after = await w.service.removeItem(w.ana, order.id, riceId);
    expect(after.itemsCents).toBe(0);
  });

  it("freezes items at the cutoff", async () => {
    const w = world();
    const order = w.service.createOrder(w.ana, {
      store: "FreshCo",
      deliverySlot: "Sat",
      cutoffAt: START + HOUR,
      deliveryFeeCents: 500,
    });
    await w.service.addItem(w.ana, order.id, { name: "Rice", priceCents: 1200 });

    w.clock.now = START + HOUR;
    const refused = await rejection(w.service.addItem(w.ana, order.id, { name: "Late", priceCents: 100 }));
    expect(refused).toMatchObject({ code: "past_cutoff" });
    expect(w.service.getOrder(w.ana, order.id).pastCutoff).toBe(true);
  });

  it("removes a member's items when they leave", async () => {
    const w = world();
    const order = w.service.createOrder(w.ana, {
      store: "FreshCo",
      deliverySlot: "Sat",
      cutoffAt: START + HOUR,
      deliveryFeeCents: 500,
    });
    await w.service.join(w.ben, order.id);
    await w.service.addItem(w.ben, order.id, { name: "Eggs", priceCents: 800 });

    const view = await w.service.leave(w.ben, order.id);
    expect(view.members.map((m) => m.name)).toEqual(["Ana"]);
    expect(view.itemsCents).toBe(0);
    expect(view.can.join).toBeNull(); // and Ben is free to join again
  });

  it("rejects bad order and item details", async () => {
    const w = world();
    const good = { store: "FreshCo", deliverySlot: "Sat", cutoffAt: START + HOUR, deliveryFeeCents: 500 };
    expect(() => w.service.createOrder(w.ana, { ...good, cutoffAt: START })).toThrow(/in the future/);
    expect(() => w.service.createOrder(w.ana, { ...good, deliveryFeeCents: 4.99 })).toThrow(/whole number/);
    expect(() => w.service.createOrder(w.ana, { ...good, deliveryFeeCents: 0 })).toThrow(/whole number/);
    expect(() => w.service.createOrder(w.ana, { ...good, store: "" })).toThrow(/Store is required/);

    const order = w.service.createOrder(w.ana, good);
    const add = (item: object) => rejection(w.service.addItem(w.ana, order.id, item as never));
    expect((await add({ name: "Rice", priceCents: 12.5 })).message).toMatch(/whole number/);
    expect((await add({ name: "Rice", priceCents: -100 })).message).toMatch(/whole number/);
    expect((await add({ name: "Rice", priceCents: 100, quantity: 0 })).message).toMatch(/Quantity/);
    expect((await add({ name: "", priceCents: 100 })).message).toMatch(/Item name is required/);
  });

  it("hides orders from people in other buildings", async () => {
    const w = world();
    const order = await lockedOrder(w);
    const outsider = w.service.signup({
      name: "Zed",
      email: "zed@example.com",
      password: "password-zed",
      buildingName: "9 Oak",
    }).user;

    expect(() => w.service.getOrder(outsider, order.id)).toThrow("Order not found.");
    expect((await rejection(w.service.join(outsider, order.id))).message).toBe("Order not found.");
    expect(w.service.listOrders(outsider)).toEqual([]);
  });

  it("lists the building's orders with the fee each person would pay", async () => {
    const w = world();
    const order = await lockedOrder(w);
    const open = w.service.createOrder(w.ben, {
      store: "No Frills",
      deliverySlot: "Sun",
      cutoffAt: START + HOUR,
      deliveryFeeCents: 399,
    });

    const list = w.service.listOrders(w.ana);
    expect(list.map((o) => o.id)).toEqual([open.id, order.id]);
    expect(list[0]).toMatchObject({ hostName: "Ben", isMember: false, yourFeeCents: 399, status: "open" });
    expect(list[1]).toMatchObject({ hostName: "Ana", isMember: true, yourFeeCents: 250, payingCount: 2 });
  });
});

describe("money", () => {
  it("holds, captures and delivers on the happy path", async () => {
    const w = world();
    const order = await lockedOrder(w);
    expect(order.waitingOn).toEqual(["Ana", "Ben"]); // Cy has no items, so owes nothing

    await w.service.hold(w.ana, order.id, "pm_card_visa");
    let view = await w.service.hold(w.ben, order.id, "pm_card_mastercard");
    expect(view.you.hold).toBe("authorized");
    expect(view.waitingOn).toEqual([]);
    // Held, not taken: nothing has been captured yet.
    expect(w.gateway.totals()).toMatchObject({ authorized: 1450 + 1050, captured: 0 });

    view = await w.service.act(w.ana, order.id, "place");
    expect(view.status).toBe("placed");
    expect(w.gateway.totals()).toMatchObject({ authorized: 0, captured: 2500 });
    expect(w.gateway.totals().captured).toBe(view.totalCents);

    view = await w.service.act(w.cy, order.id, "deliver");
    expect(view.status).toBe("delivered");
  });

  it("will not place the order until every hold is in", async () => {
    const w = world();
    const order = await lockedOrder(w);
    await w.service.hold(w.ana, order.id, "pm_card_visa");

    const refused = await rejection(w.service.act(w.ana, order.id, "place"));
    expect(refused).toMatchObject({ code: "holds_missing" });
    expect(refused.message).toContain("Ben");
    expect(w.gateway.totals().captured).toBe(0);
  });

  it("releases every hold when the order is unlocked, and asks again after relocking", async () => {
    const w = world();
    const order = await lockedOrder(w);
    await w.service.hold(w.ana, order.id, "pm_card_visa");
    await w.service.hold(w.ben, order.id, "pm_card_visa");

    let view = await w.service.act(w.cy, order.id, "unlock");
    expect(view.status).toBe("open");
    expect(w.gateway.totals()).toMatchObject({ authorized: 0, released: 2500 });
    expect(view.members.map((m) => m.hold)).toEqual(["none", "none", "none"]);

    // Cy adds something, which changes everyone's share, then they lock again.
    await w.service.addItem(w.cy, order.id, { name: "Milk", priceCents: 600 });
    view = await w.service.act(w.ana, order.id, "lock");
    expect(view.waitingOn).toEqual(["Ana", "Ben", "Cy"]);

    view = await w.service.hold(w.ana, order.id, "pm_card_visa");
    expect(view.you).toMatchObject({ hold: "authorized", totalCents: 1200 + 167 });
    expect(w.gateway.totals().authorized).toBe(1367);
  });

  it("refunds everyone if the order is cancelled after the money was taken", async () => {
    const w = world();
    const order = await lockedOrder(w);
    await w.service.hold(w.ana, order.id, "pm_card_visa");
    await w.service.hold(w.ben, order.id, "pm_card_visa");
    await w.service.act(w.ana, order.id, "place");

    const view = await w.service.act(w.ana, order.id, "cancel");
    expect(view.status).toBe("cancelled");
    expect(view.members.map((m) => m.hold)).toEqual(["refunded", "refunded", "none"]);
    expect(w.gateway.totals()).toMatchObject({ authorized: 0, captured: 0, refunded: 2500 });
  });

  it("releases holds if the order is cancelled before placing", async () => {
    const w = world();
    const order = await lockedOrder(w);
    await w.service.hold(w.ben, order.id, "pm_card_visa");

    const view = await w.service.act(w.ana, order.id, "cancel");
    expect(member(view, w.ben).hold).toBe("released");
    expect(w.gateway.totals()).toMatchObject({ authorized: 0, captured: 0, released: 1050 });
  });

  it("shows a decline to the cardholder only, and lets them try another card", async () => {
    const w = world();
    const order = await lockedOrder(w);

    let view = await w.service.hold(w.ben, order.id, "pm_card_chargeDeclinedInsufficientFunds");
    expect(member(view, w.ben)).toMatchObject({
      hold: "failed",
      holdFailure: "Your card has insufficient funds.",
    });
    expect(member(w.service.getOrder(w.ana, order.id), w.ben)).toMatchObject({
      hold: "failed",
      holdFailure: null,
    });
    expect(view.can.hold).toBeNull();

    view = await w.service.hold(w.ben, order.id, "pm_card_visa");
    expect(view.you.hold).toBe("authorized");
    expect(w.gateway.totals().authorized).toBe(1050);

    // The retry used a new idempotency key. The old one would have replayed the decline.
    const keys = w.gateway.calls.map((call) => call.idempotencyKey);
    expect(new Set(keys).size).toBe(2);
  });

  it("refuses a card that is not on the test list", async () => {
    const w = world();
    const order = await lockedOrder(w);
    const refused = await rejection(w.service.hold(w.ben, order.id, "pm_real_card"));
    expect(refused.message).toBe("Choose one of the test cards.");
    expect(w.gateway.calls).toEqual([]);
  });

  it("refuses a second hold, and a hold from someone with nothing to pay", async () => {
    const w = world();
    const order = await lockedOrder(w);
    await w.service.hold(w.ben, order.id, "pm_card_visa");

    expect(await rejection(w.service.hold(w.ben, order.id, "pm_card_visa"))).toMatchObject({
      code: "already_paid",
    });
    expect(await rejection(w.service.hold(w.cy, order.id, "pm_card_visa"))).toMatchObject({
      code: "nothing_to_pay",
    });
    expect(w.gateway.totals().authorized).toBe(1050);
  });
});

describe("when things go wrong", () => {
  it("takes one hold when the pay button is pressed twice at once", async () => {
    const w = world();
    const order = await lockedOrder(w);

    const results = await Promise.allSettled([
      w.service.hold(w.ben, order.id, "pm_card_visa"),
      w.service.hold(w.ben, order.id, "pm_card_visa"),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(w.gateway.totals().authorized).toBe(1050);
  });

  it("captures once when place is pressed twice at once", async () => {
    const w = world();
    const order = await lockedOrder(w);
    await w.service.hold(w.ana, order.id, "pm_card_visa");
    await w.service.hold(w.ben, order.id, "pm_card_visa");

    const results = await Promise.allSettled([
      w.service.act(w.ana, order.id, "place"),
      w.service.act(w.ana, order.id, "place"),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(w.gateway.calls.filter((call) => call.operation === "capture")).toHaveLength(2);
    expect(w.gateway.totals().captured).toBe(2500);
  });

  it("keeps a hold request pending through an outage and never doubles it on retry", async () => {
    const w = world();
    const order = await lockedOrder(w);

    w.gateway.failNext("authorize");
    const refused = await rejection(w.service.hold(w.ben, order.id, "pm_card_visa"));
    expect(refused).toMatchObject({ status: 502, code: "payments_unavailable" });
    expect(member(w.service.getOrder(w.ben, order.id), w.ben).hold).toBe("pending");

    const view = await w.service.hold(w.ben, order.id, "pm_card_visa");
    expect(view.you.hold).toBe("authorized");

    // Both tries carried the same key, so the provider saw one request, not two.
    const keys = w.gateway.calls.map((call) => call.idempotencyKey);
    expect(keys[0]).toBe(keys[1]);
    expect(w.gateway.totals().authorized).toBe(1050);
  });

  it("stays locked if capturing fails half way, then finishes on retry without charging twice", async () => {
    const w = world();
    const order = await lockedOrder(w);
    await w.service.hold(w.ana, order.id, "pm_card_visa");
    await w.service.hold(w.ben, order.id, "pm_card_visa");

    // Ana's capture goes through, then the provider goes down before Ben's.
    const realCapture = w.gateway.capture.bind(w.gateway);
    let captures = 0;
    w.gateway.capture = async (ref, key) => {
      if (++captures === 2) w.gateway.failNext("capture");
      return realCapture(ref, key);
    };

    expect(await rejection(w.service.act(w.ana, order.id, "place"))).toMatchObject({ status: 502 });
    let view = w.service.getOrder(w.ana, order.id);
    expect(view.status).toBe("locked");
    expect(view.members.map((m) => m.hold)).toEqual(["captured", "authorized", "none"]);

    view = await w.service.act(w.ana, order.id, "place");
    expect(view.status).toBe("placed");
    expect(w.gateway.totals()).toMatchObject({ authorized: 0, captured: 2500 });
  });

  it("can back out of a half-captured order and return every cent", async () => {
    const w = world();
    const order = await lockedOrder(w);
    await w.service.hold(w.ana, order.id, "pm_card_visa");
    await w.service.hold(w.ben, order.id, "pm_card_visa");

    const realCapture = w.gateway.capture.bind(w.gateway);
    let captures = 0;
    w.gateway.capture = async (ref, key) => {
      if (++captures === 2) w.gateway.failNext("capture");
      return realCapture(ref, key);
    };
    await rejection(w.service.act(w.ana, order.id, "place"));

    const view = await w.service.act(w.ben, order.id, "unlock");
    expect(view.status).toBe("open");
    // Ana's captured payment was refunded, Ben's hold was released.
    expect(w.gateway.totals()).toEqual({ authorized: 0, captured: 0, released: 1050, refunded: 1450 });
  });

  it("finishes returning money on retry if an unlock is interrupted", async () => {
    const w = world();
    const order = await lockedOrder(w);
    await w.service.hold(w.ana, order.id, "pm_card_visa");
    await w.service.hold(w.ben, order.id, "pm_card_visa");

    const realRelease = w.gateway.release.bind(w.gateway);
    let releases = 0;
    w.gateway.release = async (ref, key) => {
      if (++releases === 2) w.gateway.failNext("release");
      return realRelease(ref, key);
    };

    expect(await rejection(w.service.act(w.ana, order.id, "unlock"))).toMatchObject({ status: 502 });
    expect(w.service.getOrder(w.ana, order.id).status).toBe("locked");
    expect(w.gateway.totals()).toMatchObject({ authorized: 1050, released: 1450 });

    await w.service.act(w.ana, order.id, "unlock");
    expect(w.gateway.totals()).toMatchObject({ authorized: 0, released: 2500 });
  });

  it("finds and releases a hold it never heard back about when cancelling", async () => {
    const w = world();
    const order = await lockedOrder(w);

    // The hold is created at the provider, but the reply is lost on the way back.
    const realAuthorize = w.gateway.authorize.bind(w.gateway);
    w.gateway.authorize = async (request) => {
      await realAuthorize(request);
      w.gateway.authorize = realAuthorize;
      w.gateway.failNext("authorize");
      return realAuthorize(request);
    };
    await rejection(w.service.hold(w.ben, order.id, "pm_card_visa"));
    expect(w.gateway.totals().authorized).toBe(1050); // money is held, but we do not know it

    const view = await w.service.act(w.ana, order.id, "cancel");
    expect(member(view, w.ben).hold).toBe("released");
    expect(w.gateway.totals()).toMatchObject({ authorized: 0, released: 1050 });
  });
});

describe("live updates", () => {
  it("tells everyone watching an order whenever it changes", async () => {
    const w = world();
    const order = w.service.createOrder(w.ana, {
      store: "FreshCo",
      deliverySlot: "Sat",
      cutoffAt: START + HOUR,
      deliveryFeeCents: 500,
    });

    let updates = 0;
    const stop = w.service.events.subscribe(orderTopic(order.id), () => updates++);

    await w.service.join(w.ben, order.id);
    await w.service.addItem(w.ben, order.id, { name: "Eggs", priceCents: 800 });
    await w.service.act(w.ben, order.id, "lock");
    await w.service.hold(w.ben, order.id, "pm_card_visa");
    expect(updates).toBe(4);

    stop();
    await w.service.act(w.ana, order.id, "cancel");
    expect(updates).toBe(4);
  });

  it("does not announce a change that was refused", async () => {
    const w = world();
    const order = await lockedOrder(w);
    let updates = 0;
    w.service.events.subscribe(orderTopic(order.id), () => updates++);

    await rejection(w.service.act(w.ana, order.id, "place"));
    expect(updates).toBe(0);
  });
});
