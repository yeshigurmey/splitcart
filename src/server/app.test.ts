import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app";
import { openDb } from "./db";
import { FakeGateway } from "./payments";
import { Service, type OrderView } from "./service";

const closers: (() => void)[] = [];
afterEach(() => {
  while (closers.length) closers.pop()!();
});

/** Start the real app on a free port, with an in-memory database. */
async function startServer() {
  const service = new Service({ db: openDb(":memory:"), gateway: new FakeGateway() });
  const server = createApp(service).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  closers.push(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://localhost:${(server.address() as AddressInfo).port}`;
}

/** A pretend browser: remembers the session cookie between requests. */
function browser(base: string) {
  let cookie = "";

  async function request(method: string, path: string, body?: unknown) {
    const response = await fetch(base + path, {
      method,
      headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    return { status: response.status, body: (await response.json()) as any, setCookie };
  }

  return {
    get: (path: string) => request("GET", path),
    post: (path: string, body?: unknown) => request("POST", path, body),
    delete: (path: string) => request("DELETE", path),
    /** Open a live stream and return a function that waits for the next message. */
    async listen(path: string) {
      const controller = new AbortController();
      closers.push(() => controller.abort());
      const response = await fetch(base + path, { headers: { cookie }, signal: controller.signal });
      const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      return {
        contentType: response.headers.get("content-type"),
        async next(): Promise<any> {
          for (;;) {
            const end = buffer.indexOf("\n\n");
            if (end >= 0) {
              const message = buffer.slice(0, end);
              buffer = buffer.slice(end + 2);
              if (message.startsWith("data: ")) return JSON.parse(message.slice(6));
              continue; // a heartbeat comment
            }
            const { value, done } = await reader.read();
            if (done) throw new Error("stream ended");
            buffer += value;
          }
        },
      };
    },
  };
}

const inAnHour = () => Date.now() + 60 * 60 * 1000;

async function twoNeighbours() {
  const base = await startServer();
  const ana = browser(base);
  const ben = browser(base);
  const signup = await ana.post("/api/signup", {
    name: "Ana",
    email: "ana@example.com",
    password: "password-ana",
    buildingName: "182 Maple",
  });
  await ben.post("/api/signup", {
    name: "Ben",
    email: "ben@example.com",
    password: "password-ben",
    buildingCode: signup.body.building.code,
  });
  return { base, ana, ben, signup };
}

describe("accounts over HTTP", () => {
  it("signs up, sets a locked-down session cookie, and remembers the user", async () => {
    const { ana, signup } = await twoNeighbours();

    expect(signup.status).toBe(201);
    expect(signup.body.user).toMatchObject({ name: "Ana", email: "ana@example.com" });
    expect(signup.body.building.name).toBe("182 Maple");
    expect(signup.setCookie).toMatch(/^splitcart_session=.+; HttpOnly; SameSite=Lax; Path=\//);
    // The password, hashed or not, never leaves the server.
    expect(JSON.stringify(signup.body)).not.toMatch(/password/i);

    expect((await ana.get("/api/me")).body.user.name).toBe("Ana");
  });

  it("turns away requests without a session", async () => {
    const stranger = browser(await startServer());
    for (const path of ["/api/me", "/api/orders", "/api/orders/abc", "/api/events"]) {
      const response = await stranger.get(path);
      expect(response.status, path).toBe(401);
      expect(response.body.error.code).toBe("not_logged_in");
    }
  });

  it("logs out and back in", async () => {
    const { ana } = await twoNeighbours();
    await ana.post("/api/logout");
    expect((await ana.get("/api/me")).status).toBe(401);

    expect((await ana.post("/api/login", { email: "ana@example.com", password: "wrong" })).status).toBe(401);
    expect((await ana.post("/api/login", { email: "ana@example.com", password: "password-ana" })).status).toBe(200);
    expect((await ana.get("/api/me")).status).toBe(200);
  });
});

describe("an order over HTTP", () => {
  it("runs from creation to delivery", async () => {
    const { ana, ben } = await twoNeighbours();

    const created = await ana.post("/api/orders", {
      store: "FreshCo",
      deliverySlot: "Sat 2pm to 4pm",
      cutoffAt: inAnHour(),
      deliveryFeeCents: 500,
    });
    expect(created.status).toBe(201);
    const url = `/api/orders/${created.body.id}`;

    expect((await ben.post(`${url}/join`)).status).toBe(200);
    expect((await ana.post(`${url}/items`, { name: "Rice", priceCents: 1200 })).status).toBe(201);
    const added = await ben.post(`${url}/items`, { name: "Eggs", priceCents: 800, quantity: 1 });
    expect(added.body.you).toMatchObject({ feeShareCents: 250, totalCents: 1050 });

    expect((await ben.post(`${url}/lock`)).body.status).toBe("locked");
    await ana.post(`${url}/hold`, { paymentMethod: "pm_card_visa" });
    const held = await ben.post(`${url}/hold`, { paymentMethod: "pm_card_visa" });
    expect(held.body.waitingOn).toEqual([]);

    expect((await ana.post(`${url}/place`)).body.status).toBe("placed");
    expect((await ben.post(`${url}/deliver`)).body.status).toBe("delivered");

    const list = await ben.get("/api/orders");
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ store: "FreshCo", status: "delivered", isMember: true });
  });

  it("answers with a status code that says what kind of problem it was", async () => {
    const { ana, ben } = await twoNeighbours();
    const created = await ana.post("/api/orders", {
      store: "FreshCo",
      deliverySlot: "Sat",
      cutoffAt: inAnHour(),
      deliveryFeeCents: 500,
    });
    const url = `/api/orders/${created.body.id}`;

    // 400: the request itself is wrong
    expect((await ana.post(`${url}/items`, { name: "Rice", priceCents: "12" })).status).toBe(400);
    expect((await ana.post("/api/orders", { store: "FreshCo" })).status).toBe(400);
    // 403: this person may not do it
    const notMember = await ben.post(`${url}/lock`);
    expect(notMember.status).toBe(403);
    expect(notMember.body.error).toEqual({ code: "not_member", message: "Join this order first." });
    await ben.post(`${url}/join`);
    await ana.post(`${url}/items`, { name: "Rice", priceCents: 1200 });
    expect((await ben.post(`${url}/cancel`)).status).toBe(403);
    // 409: not possible in the order's current state
    expect((await ana.post(`${url}/place`)).status).toBe(409);
    expect((await ana.post(`${url}/hold`, { paymentMethod: "pm_card_visa" })).status).toBe(409);
    // 404: no such thing
    expect((await ana.get("/api/orders/does-not-exist")).status).toBe(404);
    expect((await ana.delete(`${url}/items/does-not-exist`)).status).toBe(404);
    expect((await ana.get("/api/nope")).status).toBe(404);
  });

  it("rejects a body that is not JSON", async () => {
    const { base } = await twoNeighbours();
    const response = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as any).error.code).toBe("invalid");
  });
});

describe("live updates over HTTP", () => {
  it("pushes the new order to everyone watching as soon as someone changes it", async () => {
    const { ana, ben } = await twoNeighbours();
    const created = await ana.post("/api/orders", {
      store: "FreshCo",
      deliverySlot: "Sat",
      cutoffAt: inAnHour(),
      deliveryFeeCents: 500,
    });
    const url = `/api/orders/${created.body.id}`;
    await ana.post(`${url}/items`, { name: "Rice", priceCents: 1200 });

    const stream = await ana.listen(`${url}/events`);
    expect(stream.contentType).toBe("text/event-stream");
    const first: OrderView = await stream.next();
    expect(first.you.feeShareCents).toBe(500);

    // Ben joins and adds an item from his own browser. Ana's screen hears about both.
    await ben.post(`${url}/join`);
    expect((await stream.next()).members).toHaveLength(2);
    await ben.post(`${url}/items`, { name: "Eggs", priceCents: 800 });
    const afterBen: OrderView = await stream.next();
    expect(afterBen.you.feeShareCents).toBe(250);
    // Ana is the host, so her view includes what Ben needs her to buy.
    expect(afterBen.members[1].items?.[0].name).toBe("Eggs");
  });

  it("pushes the order list to the building when an order appears", async () => {
    const { ana, ben } = await twoNeighbours();
    const stream = await ben.listen("/api/events");
    expect(await stream.next()).toEqual([]);

    await ana.post("/api/orders", {
      store: "FreshCo",
      deliverySlot: "Sat",
      cutoffAt: inAnHour(),
      deliveryFeeCents: 500,
    });
    const list = await stream.next();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ store: "FreshCo", hostName: "Ana", yourFeeCents: 500 });
  });

  it("does not open a stream for an order in another building", async () => {
    const { base, ana } = await twoNeighbours();
    const created = await ana.post("/api/orders", {
      store: "FreshCo",
      deliverySlot: "Sat",
      cutoffAt: inAnHour(),
      deliveryFeeCents: 500,
    });

    const outsider = browser(base);
    await outsider.post("/api/signup", {
      name: "Zed",
      email: "zed@example.com",
      password: "password-zed",
      buildingName: "9 Oak",
    });
    expect((await outsider.get(`/api/orders/${created.body.id}/events`)).status).toBe(404);
  });
});
