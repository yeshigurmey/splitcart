/**
 * Everything the app can do, as plain functions over the database.
 *
 * This layer knows nothing about HTTP. The web routes (app.ts) call it, and so
 * do the tests, which is why the money paths can be tested without a browser
 * or a server.
 *
 * Each method follows the same three steps:
 *
 *   1. load the order from the database into an OrderState
 *   2. ask the pure rules in ../order.ts whether the request is allowed
 *   3. only then write to the database or talk to the payment provider
 */

import { randomUUID } from "node:crypto";
import {
  MONEY_EFFECT,
  OrderError,
  checkAction,
  checkEditItems,
  checkHold,
  checkJoin,
  checkLeave,
  feeShareIfOneMoreJoins,
  membersStillToPay,
  nextStatus,
  quote,
  type HoldStatus,
  type OrderAction,
  type OrderState,
  type OrderStatus,
  type Refusal,
  type SplitMode,
} from "../order";
import { hashPassword, hashToken, newBuildingCode, newSessionToken, verifyPassword } from "./auth";
import type { Db } from "./db";
import { Events, buildingTopic, orderTopic } from "./events";
import { GatewayError, TEST_CARDS, isTestCard, type PaymentGateway } from "./payments";

// ---------------------------------------------------------------------------
// Types the rest of the app sees
// ---------------------------------------------------------------------------

export interface User {
  id: string;
  name: string;
  email: string;
  buildingId: string;
}

export interface Building {
  id: string;
  name: string;
  code: string;
}

/** Null means "allowed". A string is the reason it is not. */
export type Permission = string | null;

export interface MemberView {
  userId: string;
  name: string;
  isHost: boolean;
  isYou: boolean;
  /** Item details are private: only the member and the host, who has to buy them, see these. */
  items: { id: string; name: string; priceCents: number; quantity: number }[] | null;
  itemCount: number;
  itemsCents: number;
  feeShareCents: number;
  totalCents: number;
  hold: HoldStatus;
  holdFailure: string | null;
}

export interface OrderView {
  id: string;
  store: string;
  deliverySlot: string;
  cutoffAt: number;
  pastCutoff: boolean;
  deliveryFeeCents: number;
  splitMode: SplitMode;
  status: OrderStatus;
  hostName: string;
  members: MemberView[];
  payingCount: number;
  itemsCents: number;
  totalCents: number;
  /** Names of members whose card hold is still missing. */
  waitingOn: string[];
  you: {
    isMember: boolean;
    isHost: boolean;
    feeShareCents: number;
    totalCents: number;
    hold: HoldStatus;
  };
  /** With an even split, the delivery share a newcomer would pay. Null when split by size. */
  feeIfOneMoreJoinsCents: number | null;
  can: Record<OrderAction | "join" | "leave" | "editItems" | "hold", Permission>;
  payment: { gateway: string; testCards: readonly { id: string; label: string }[] };
}

export interface OrderSummary {
  id: string;
  store: string;
  deliverySlot: string;
  cutoffAt: number;
  status: OrderStatus;
  hostName: string;
  deliveryFeeCents: number;
  payingCount: number;
  memberCount: number;
  isMember: boolean;
  /** Your delivery share if you are in the order, or what it would be if you joined. */
  yourFeeCents: number | null;
}

/** A request that cannot be carried out. `status` is the HTTP status the web layer should send. */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
  }
}

const invalid = (message: string) => new AppError(400, "invalid", message);
const notFound = (what: string) => new AppError(404, "not_found", `${what} not found.`);

// ---------------------------------------------------------------------------
// Database rows
// ---------------------------------------------------------------------------

interface UserRow {
  id: string;
  building_id: string;
  name: string;
  email: string;
  password_hash: string;
}

interface OrderRow {
  id: string;
  building_id: string;
  host_id: string;
  store: string;
  delivery_slot: string;
  cutoff_at: number;
  delivery_fee_cents: number;
  split_mode: SplitMode;
  status: OrderStatus;
  lock_version: number;
}

interface PaymentRow {
  id: string;
  order_id: string;
  user_id: string;
  lock_version: number;
  amount_cents: number;
  status: Exclude<HoldStatus, "none">;
  payment_method: string;
  attempt: number;
  gateway_ref: string | null;
  failure: string | null;
}

interface Loaded {
  row: OrderRow;
  state: OrderState;
  /** Payments belonging to the current lock, at most one per member. */
  payments: PaymentRow[];
}

const toUser = (row: UserRow): User => ({
  id: row.id,
  name: row.name,
  email: row.email,
  buildingId: row.building_id,
});

// ---------------------------------------------------------------------------
// Input checks
// ---------------------------------------------------------------------------

const SESSION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_ITEMS_PER_ORDER = 300;

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== "string") throw invalid(`${label} is required.`);
  const trimmed = value.trim();
  if (trimmed.length === 0) throw invalid(`${label} is required.`);
  if (trimmed.length > max) throw invalid(`${label} must be at most ${max} characters.`);
  return trimmed;
}

function wholeNumber(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw invalid(`${label} must be a whole number between ${min} and ${max}.`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export interface ServiceOptions {
  db: Db;
  gateway: PaymentGateway;
  events?: Events;
  /** The clock, replaceable so tests can move time past a cutoff. */
  now?: () => number;
  currency?: string;
}

export class Service {
  readonly events: Events;
  private readonly db: Db;
  private readonly gateway: PaymentGateway;
  private readonly now: () => number;
  private readonly currency: string;
  /** One queue of pending work per order. See `exclusive`. */
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(options: ServiceOptions) {
    this.db = options.db;
    this.gateway = options.gateway;
    this.events = options.events ?? new Events();
    this.now = options.now ?? Date.now;
    this.currency = options.currency ?? "cad";
  }

  // ----- accounts -----------------------------------------------------------

  /**
   * Create an account. A new neighbour either starts their building
   * (`buildingName`) or joins one with the code a neighbour gave them
   * (`buildingCode`).
   */
  signup(input: {
    name: unknown;
    email: unknown;
    password: unknown;
    buildingName?: unknown;
    buildingCode?: unknown;
  }): { user: User; token: string } {
    const name = text(input.name, "Name", 60);
    const email = text(input.email, "Email", 200).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw invalid("That email address does not look right.");
    if (typeof input.password !== "string" || input.password.length < 8 || input.password.length > 200) {
      throw invalid("Password must be at least 8 characters.");
    }
    const password = input.password;
    const now = this.now();

    const create = this.db.transaction((): User => {
      if (this.db.prepare("SELECT 1 FROM users WHERE email = ?").get(email)) {
        throw new AppError(409, "email_taken", "There is already an account with that email.");
      }

      let buildingId: string;
      const code = typeof input.buildingCode === "string" ? input.buildingCode.trim().toUpperCase() : "";
      if (code) {
        const building = this.db.prepare("SELECT id FROM buildings WHERE code = ?").get(code) as
          | { id: string }
          | undefined;
        if (!building) throw invalid("No building has that code. Check it with your neighbour.");
        buildingId = building.id;
      } else {
        const buildingName = text(input.buildingName, "Building name", 80);
        buildingId = randomUUID();
        this.db
          .prepare("INSERT INTO buildings (id, name, code, created_at) VALUES (?, ?, ?, ?)")
          .run(buildingId, buildingName, this.unusedBuildingCode(), now);
      }

      const user: User = { id: randomUUID(), name, email, buildingId };
      this.db
        .prepare(
          "INSERT INTO users (id, building_id, name, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(user.id, buildingId, name, email, hashPassword(password), now);
      return user;
    });

    const user = create();
    return { user, token: this.startSession(user.id) };
  }

  login(input: { email: unknown; password: unknown }): { user: User; token: string } {
    const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
    const password = typeof input.password === "string" ? input.password : "";
    const row = this.db.prepare("SELECT * FROM users WHERE email = ?").get(email) as UserRow | undefined;

    // The same message either way, so the form cannot be used to find out
    // which email addresses have accounts.
    if (!row || !verifyPassword(password, row.password_hash)) {
      throw new AppError(401, "bad_login", "Wrong email or password.");
    }
    return { user: toUser(row), token: this.startSession(row.id) };
  }

  logout(token: string): void {
    this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
  }

  userForToken(token: string | undefined): User | null {
    if (!token) return null;
    const row = this.db
      .prepare(
        `SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id
         WHERE sessions.token_hash = ? AND sessions.expires_at > ?`,
      )
      .get(hashToken(token), this.now()) as UserRow | undefined;
    return row ? toUser(row) : null;
  }

  building(buildingId: string): Building {
    return this.db.prepare("SELECT id, name, code FROM buildings WHERE id = ?").get(buildingId) as Building;
  }

  private startSession(userId: string): string {
    const token = newSessionToken();
    this.db
      .prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
      .run(hashToken(token), userId, this.now() + SESSION_DAYS * DAY_MS);
    return token;
  }

  private unusedBuildingCode(): string {
    for (;;) {
      const code = newBuildingCode();
      if (!this.db.prepare("SELECT 1 FROM buildings WHERE code = ?").get(code)) return code;
    }
  }

  // ----- orders ---------------------------------------------------------------

  createOrder(
    user: User,
    input: {
      store: unknown;
      deliverySlot: unknown;
      cutoffAt: unknown;
      deliveryFeeCents: unknown;
      splitMode?: unknown;
    },
  ): OrderView {
    const store = text(input.store, "Store", 60);
    const deliverySlot = text(input.deliverySlot, "Delivery time", 60);
    const deliveryFeeCents = wholeNumber(input.deliveryFeeCents, "Delivery fee (in cents)", 1, 50_000);
    const splitMode: SplitMode = input.splitMode === "by_size" ? "by_size" : "even";
    const now = this.now();
    if (typeof input.cutoffAt !== "number" || !Number.isFinite(input.cutoffAt)) {
      throw invalid("Cutoff time is required.");
    }
    if (input.cutoffAt <= now) throw invalid("The cutoff time must be in the future.");
    if (input.cutoffAt > now + 30 * DAY_MS) throw invalid("The cutoff time must be within 30 days.");
    const cutoffAt = Math.floor(input.cutoffAt);

    const id = randomUUID();
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO orders (id, building_id, host_id, store, delivery_slot, cutoff_at,
                               delivery_fee_cents, split_mode, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
        )
        .run(id, user.buildingId, user.id, store, deliverySlot, cutoffAt, deliveryFeeCents, splitMode, now);
      this.db
        .prepare("INSERT INTO members (order_id, user_id, joined_at) VALUES (?, ?, ?)")
        .run(id, user.id, now);
    })();

    this.changed(id, user.buildingId);
    return this.getOrder(user, id);
  }

  /** The building's orders, newest first. */
  listOrders(user: User): OrderSummary[] {
    const rows = this.db
      .prepare("SELECT id FROM orders WHERE building_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 50")
      .all(user.buildingId) as { id: string }[];

    return rows.map(({ id }) => {
      const { row, state } = this.load(id, user);
      const q = quote(state);
      const mine = q.members.find((m) => m.userId === user.id);
      const isMember = mine !== undefined;

      let yourFeeCents: number | null = null;
      if (mine && mine.itemsCents > 0) yourFeeCents = mine.feeShareCents;
      else if (state.status === "open" && state.splitMode === "even") {
        yourFeeCents = feeShareIfOneMoreJoins(state);
      }

      return {
        id,
        store: row.store,
        deliverySlot: row.delivery_slot,
        cutoffAt: row.cutoff_at,
        status: row.status,
        hostName: state.members.find((m) => m.userId === row.host_id)?.name ?? "",
        deliveryFeeCents: row.delivery_fee_cents,
        payingCount: q.payingCount,
        memberCount: state.members.length,
        isMember,
        yourFeeCents,
      };
    });
  }

  getOrder(user: User, orderId: string): OrderView {
    return this.view(this.load(orderId, user), user);
  }

  join(user: User, orderId: string): Promise<OrderView> {
    return this.exclusive(orderId, async () => {
      const { state } = this.load(orderId, user);
      allow(checkJoin(state, user.id));
      this.db
        .prepare("INSERT INTO members (order_id, user_id, joined_at) VALUES (?, ?, ?)")
        .run(orderId, user.id, this.now());
      return this.done(orderId, user);
    });
  }

  leave(user: User, orderId: string): Promise<OrderView> {
    return this.exclusive(orderId, async () => {
      const { state } = this.load(orderId, user);
      allow(checkLeave(state, user.id));
      this.db.transaction(() => {
        this.db.prepare("DELETE FROM items WHERE order_id = ? AND user_id = ?").run(orderId, user.id);
        this.db.prepare("DELETE FROM members WHERE order_id = ? AND user_id = ?").run(orderId, user.id);
      })();
      return this.done(orderId, user);
    });
  }

  addItem(
    user: User,
    orderId: string,
    input: { name: unknown; priceCents: unknown; quantity?: unknown },
  ): Promise<OrderView> {
    return this.exclusive(orderId, async () => {
      const name = text(input.name, "Item name", 80);
      const priceCents = wholeNumber(input.priceCents, "Price (in cents)", 1, 1_000_000);
      const quantity = wholeNumber(input.quantity ?? 1, "Quantity", 1, 99);

      const { state } = this.load(orderId, user);
      allow(checkEditItems(state, user.id, this.now()));
      if (state.items.length >= MAX_ITEMS_PER_ORDER) throw invalid("This order is full.");

      this.db
        .prepare(
          "INSERT INTO items (id, order_id, user_id, name, price_cents, quantity, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(randomUUID(), orderId, user.id, name, priceCents, quantity, this.now());
      return this.done(orderId, user);
    });
  }

  removeItem(user: User, orderId: string, itemId: string): Promise<OrderView> {
    return this.exclusive(orderId, async () => {
      const { state } = this.load(orderId, user);
      allow(checkEditItems(state, user.id, this.now()));
      // The user_id condition means nobody can remove someone else's item.
      const result = this.db
        .prepare("DELETE FROM items WHERE id = ? AND order_id = ? AND user_id = ?")
        .run(itemId, orderId, user.id);
      if (result.changes === 0) throw notFound("Item");
      return this.done(orderId, user);
    });
  }

  /**
   * Move the order through its state machine: lock, unlock, place, deliver
   * or cancel.
   *
   * Money moves before the status changes. If the payment provider fails half
   * way, the order stays where it was and the same action can simply be tried
   * again: payments that already went through are skipped, and idempotency
   * keys make repeating the rest harmless.
   */
  act(user: User, orderId: string, action: OrderAction): Promise<OrderView> {
    return this.exclusive(orderId, async () => {
      const loaded = this.load(orderId, user);
      const to = nextStatus(loaded.state, action, user.id);

      const effect = MONEY_EFFECT[action];
      if (effect === "capture") await this.captureAll(loaded.payments);
      if (effect === "return") await this.returnAll(orderId, loaded.row.lock_version);

      this.db
        .prepare("UPDATE orders SET status = ?, lock_version = lock_version + ? WHERE id = ?")
        .run(to, action === "lock" ? 1 : 0, orderId);
      return this.done(orderId, user);
    });
  }

  /**
   * Put a hold on the member's card for their items plus their share of the
   * delivery fee. A declined card is not an error: the returned view shows
   * the hold as "failed" with the bank's reason, and the member can try again.
   */
  hold(user: User, orderId: string, paymentMethod: unknown): Promise<OrderView> {
    return this.exclusive(orderId, async () => {
      if (typeof paymentMethod !== "string" || !isTestCard(paymentMethod)) {
        throw invalid("Choose one of the test cards.");
      }
      const { row, state, payments } = this.load(orderId, user);
      allow(checkHold(state, user.id));

      const amountCents = quote(state).members.find((m) => m.userId === user.id)!.totalCents;
      const now = this.now();
      let payment = payments.find((p) => p.user_id === user.id);

      if (!payment) {
        const id = randomUUID();
        this.db
          .prepare(
            `INSERT INTO payments (id, order_id, user_id, lock_version, amount_cents, status,
                                   payment_method, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
          )
          .run(id, orderId, user.id, row.lock_version, amountCents, paymentMethod, now, now);
      } else if (payment.status !== "pending") {
        // A new try after a decline (or after a hold was returned). Bumping
        // the attempt number gives it a new idempotency key, because the old
        // key would just replay the old answer.
        this.db
          .prepare(
            `UPDATE payments SET status = 'pending', attempt = attempt + 1, payment_method = ?,
                                 amount_cents = ?, gateway_ref = NULL, failure = NULL, updated_at = ?
             WHERE id = ?`,
          )
          .run(paymentMethod, amountCents, now, payment.id);
      }
      // A payment that is already pending is left exactly as it was: we never
      // heard back last time, so we ask again with the same idempotency key.

      payment = this.currentPayments(orderId, row.lock_version).find((p) => p.user_id === user.id)!;
      await this.settle(payment, `SplitCart: ${row.store} order`);
      return this.done(orderId, user);
    });
  }

  // ----- money ----------------------------------------------------------------

  /** Ask the provider for the hold and record its answer. */
  private async settle(payment: PaymentRow, description: string): Promise<void> {
    const result = await this.provider(() =>
      this.gateway.authorize({
        amountCents: payment.amount_cents,
        currency: this.currency,
        paymentMethod: payment.payment_method,
        description,
        idempotencyKey: `hold:${payment.id}:${payment.attempt}`,
      }),
    );

    if (result.ok) this.setPayment(payment, "authorized", { ref: result.ref });
    else this.setPayment(payment, "failed", { failure: result.reason });
  }

  private async captureAll(payments: PaymentRow[]): Promise<void> {
    for (const payment of payments) {
      if (payment.status !== "authorized") continue; // captured ones are already done
      await this.provider(() =>
        this.gateway.capture(payment.gateway_ref!, `capture:${payment.id}:${payment.attempt}`),
      );
      this.setPayment(payment, "captured");
    }
  }

  /** Give everyone their money back: release holds, refund captured payments. */
  private async returnAll(orderId: string, lockVersion: number): Promise<void> {
    for (const payment of this.currentPayments(orderId, lockVersion)) {
      // A pending payment may or may not have a hold behind it. Ask again
      // (same key, so no second hold) to find out before deciding what to undo.
      if (payment.status === "pending") await this.settle(payment, "SplitCart order");
    }

    for (const payment of this.currentPayments(orderId, lockVersion)) {
      const key = `${payment.id}:${payment.attempt}`;
      if (payment.status === "authorized") {
        await this.provider(() => this.gateway.release(payment.gateway_ref!, `release:${key}`));
        this.setPayment(payment, "released");
      } else if (payment.status === "captured") {
        await this.provider(() => this.gateway.refund(payment.gateway_ref!, `refund:${key}`));
        this.setPayment(payment, "refunded");
      }
    }
  }

  /** Run a call to the payment provider, turning an outage into a clear, retryable error. */
  private async provider<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof GatewayError) {
        throw new AppError(
          502,
          "payments_unavailable",
          "The payment provider did not respond. Nothing was lost. Please try again.",
        );
      }
      throw error;
    }
  }

  private setPayment(
    payment: PaymentRow,
    status: PaymentRow["status"],
    extra: { ref?: string; failure?: string } = {},
  ): void {
    this.db
      .prepare(
        `UPDATE payments SET status = ?, gateway_ref = COALESCE(?, gateway_ref), failure = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(status, extra.ref ?? null, extra.failure ?? null, this.now(), payment.id);
  }

  private currentPayments(orderId: string, lockVersion: number): PaymentRow[] {
    return this.db
      .prepare("SELECT * FROM payments WHERE order_id = ? AND lock_version = ? ORDER BY created_at, rowid")
      .all(orderId, lockVersion) as PaymentRow[];
  }

  // ----- loading and viewing --------------------------------------------------

  /** Read an order into an OrderState. Orders in other buildings look like they do not exist. */
  private load(orderId: string, user: User): Loaded {
    const row = this.db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId) as OrderRow | undefined;
    if (!row || row.building_id !== user.buildingId) throw notFound("Order");

    const members = this.db
      .prepare(
        `SELECT users.id AS userId, users.name AS name FROM members
         JOIN users ON users.id = members.user_id
         WHERE members.order_id = ? ORDER BY members.joined_at, members.rowid`,
      )
      .all(orderId) as { userId: string; name: string }[];

    const items = this.db
      .prepare(
        `SELECT id, user_id AS userId, name, price_cents AS priceCents, quantity
         FROM items WHERE order_id = ? ORDER BY created_at, rowid`,
      )
      .all(orderId) as OrderState["items"];

    const payments = this.currentPayments(orderId, row.lock_version);

    // While an order is open nobody has a hold: any earlier ones were
    // returned when it was unlocked.
    const holds: Record<string, HoldStatus> = {};
    if (row.status !== "open") {
      for (const payment of payments) holds[payment.user_id] = payment.status;
    }

    return {
      row,
      payments,
      state: {
        status: row.status,
        hostId: row.host_id,
        cutoffAt: row.cutoff_at,
        deliveryFeeCents: row.delivery_fee_cents,
        splitMode: row.split_mode,
        members,
        items,
        holds,
      },
    };
  }

  /** Everything one person's screen needs to draw the order, including what they may do. */
  private view({ row, state, payments }: Loaded, user: User): OrderView {
    const q = quote(state);
    const now = this.now();
    const viewerIsHost = user.id === state.hostId;
    const permission = (refusal: Refusal | null): Permission => refusal?.message ?? null;

    const members: MemberView[] = state.members.map((member, i) => {
      const own = state.items.filter((item) => item.userId === member.userId);
      const isYou = member.userId === user.id;
      const payment = payments.find((p) => p.user_id === member.userId);
      const hold = state.holds[member.userId] ?? "none";
      return {
        userId: member.userId,
        name: member.name,
        isHost: member.userId === state.hostId,
        isYou,
        items:
          isYou || viewerIsHost
            ? own.map(({ id, name, priceCents, quantity }) => ({ id, name, priceCents, quantity }))
            : null,
        itemCount: own.reduce((sum, item) => sum + item.quantity, 0),
        itemsCents: q.members[i].itemsCents,
        feeShareCents: q.members[i].feeShareCents,
        totalCents: q.members[i].totalCents,
        hold,
        // Only the person whose card it is sees why it was declined.
        holdFailure: isYou && hold === "failed" ? (payment?.failure ?? null) : null,
      };
    });

    const mine = members.find((m) => m.isYou);
    const can = {} as OrderView["can"];
    for (const action of ["lock", "unlock", "place", "deliver", "cancel"] as const) {
      can[action] = permission(checkAction(state, action, user.id));
    }
    can.join = permission(checkJoin(state, user.id));
    can.leave = permission(checkLeave(state, user.id));
    can.editItems = permission(checkEditItems(state, user.id, now));
    can.hold = permission(checkHold(state, user.id));

    return {
      id: row.id,
      store: row.store,
      deliverySlot: row.delivery_slot,
      cutoffAt: row.cutoff_at,
      pastCutoff: now >= row.cutoff_at,
      deliveryFeeCents: row.delivery_fee_cents,
      splitMode: row.split_mode,
      status: row.status,
      hostName: state.members.find((m) => m.userId === state.hostId)?.name ?? "",
      members,
      payingCount: q.payingCount,
      itemsCents: q.itemsCents,
      totalCents: q.totalCents,
      waitingOn: state.status === "locked" ? membersStillToPay(state).map((m) => m.name) : [],
      you: {
        isMember: mine !== undefined,
        isHost: viewerIsHost,
        feeShareCents: mine?.feeShareCents ?? 0,
        totalCents: mine?.totalCents ?? 0,
        hold: mine?.hold ?? "none",
      },
      feeIfOneMoreJoinsCents: state.splitMode === "even" ? feeShareIfOneMoreJoins(state) : null,
      can,
      payment: { gateway: this.gateway.name, testCards: TEST_CARDS },
    };
  }

  /** After a change: tell everyone watching, then return the fresh view. */
  private done(orderId: string, user: User): OrderView {
    this.changed(orderId, user.buildingId);
    return this.getOrder(user, orderId);
  }

  private changed(orderId: string, buildingId: string): void {
    this.events.publish(orderTopic(orderId));
    this.events.publish(buildingTopic(buildingId));
  }

  /**
   * Run `work` for an order only after any earlier work on the same order has
   * finished.
   *
   * Talking to a payment provider takes time, and without this two requests
   * could interleave: two people pressing "place" at once, or a hold landing
   * while an unlock is half way through returning money. Queuing the work per
   * order means each request sees the finished result of the one before it.
   * Different orders do not wait for each other.
   */
  private async exclusive<T>(orderId: string, work: () => Promise<T>): Promise<T> {
    const before = this.queues.get(orderId) ?? Promise.resolve();
    const result = before.then(work);
    // The queue must keep moving even when this piece of work fails.
    const settled = result.catch(() => undefined);
    this.queues.set(orderId, settled);
    try {
      return await result;
    } finally {
      if (this.queues.get(orderId) === settled) this.queues.delete(orderId);
    }
  }
}

/** Turn a refusal from the order rules into an exception. */
function allow(refusal: Refusal | null): void {
  if (refusal) throw new OrderError(refusal);
}
