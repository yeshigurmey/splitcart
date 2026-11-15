/**
 * The order model and its state machine.
 *
 * Everything in this file is a pure function of its inputs: no database, no
 * clock, no network. The server loads an order into an `OrderState`, asks
 * these functions what is allowed and what everyone owes, and only then
 * touches the database or a payment provider.
 *
 * Life of an order:
 *
 *   open  --lock-->  locked  --place-->  placed  --deliver-->  delivered
 *     ^                |                    |
 *     +----unlock------+                    |
 *     |                |                    |
 *     +----cancel------+-------cancel-------+-->  cancelled
 *
 *   open       neighbours join and add items; the fee share updates live
 *   locked     the cart is frozen and everyone puts a hold on their card
 *   placed     the holds are captured and the host buys the groceries
 *   delivered  done
 *   cancelled  every hold is released and every captured payment refunded
 */

import { splitEvenly, splitProportionally } from "./split";

export type OrderStatus = "open" | "locked" | "placed" | "delivered" | "cancelled";
export type OrderAction = "lock" | "unlock" | "place" | "deliver" | "cancel";
export type SplitMode = "even" | "by_size";

/**
 * Where one member's money is.
 *
 *   none        nothing has happened yet
 *   pending     we asked the payment provider for a hold and have no answer
 *   authorized  the money is held on their card but has not moved
 *   captured    the money has been taken
 *   released    a hold was cancelled before capture
 *   refunded    captured money was sent back
 *   failed      the card was declined
 */
export type HoldStatus =
  | "none"
  | "pending"
  | "authorized"
  | "captured"
  | "released"
  | "refunded"
  | "failed";

export interface Member {
  userId: string;
  name: string;
}

export interface Item {
  id: string;
  userId: string;
  name: string;
  priceCents: number;
  quantity: number;
}

export interface OrderState {
  status: OrderStatus;
  hostId: string;
  /** Epoch milliseconds. After this, nobody can change their items. */
  cutoffAt: number;
  deliveryFeeCents: number;
  splitMode: SplitMode;
  /** In the order people joined, host first. */
  members: Member[];
  items: Item[];
  /** Keyed by user id. A member who is missing here has status "none". */
  holds: Record<string, HoldStatus>;
}

// ---------------------------------------------------------------------------
// What everyone owes
// ---------------------------------------------------------------------------

export interface MemberQuote {
  userId: string;
  itemsCents: number;
  /** This member's part of the delivery fee. */
  feeShareCents: number;
  /** itemsCents + feeShareCents: the amount held on their card. */
  totalCents: number;
  /** What delivery would have cost them ordering alone. */
  soloFeeCents: number;
}

export interface Quote {
  members: MemberQuote[];
  /** Members with at least one item. Only they share the fee. */
  payingCount: number;
  itemsCents: number;
  totalCents: number;
}

export function itemsTotal(items: Item[], userId: string): number {
  return items
    .filter((item) => item.userId === userId)
    .reduce((sum, item) => sum + item.priceCents * item.quantity, 0);
}

/**
 * Work out each member's items, fee share and total.
 *
 * Someone who has joined but not added anything yet pays no part of the fee,
 * so browsing an order never costs anything. The fee shares of everyone else
 * always add up to exactly the delivery fee (see split.ts).
 */
export function quote(order: OrderState): Quote {
  const subtotals = order.members.map((m) => itemsTotal(order.items, m.userId));
  const paying = subtotals.map((cents) => cents > 0);
  const payingCount = paying.filter(Boolean).length;

  let feeShares: number[] = subtotals.map(() => 0);
  if (payingCount > 0) {
    if (order.splitMode === "by_size") {
      // Weight 0 already means "pays nothing", so no filtering is needed.
      feeShares = splitProportionally(order.deliveryFeeCents, subtotals);
    } else {
      const shares = splitEvenly(order.deliveryFeeCents, payingCount);
      let next = 0;
      feeShares = paying.map((pays) => (pays ? shares[next++] : 0));
    }
  }

  const members = order.members.map((member, i) => ({
    userId: member.userId,
    itemsCents: subtotals[i],
    feeShareCents: feeShares[i],
    totalCents: subtotals[i] + feeShares[i],
    soloFeeCents: paying[i] ? order.deliveryFeeCents : 0,
  }));

  return {
    members,
    payingCount,
    itemsCents: members.reduce((sum, m) => sum + m.itemsCents, 0),
    totalCents: members.reduce((sum, m) => sum + m.totalCents, 0),
  };
}

/**
 * The fee share a newcomer would get with an even split: the fee divided by
 * one more person. Used for the "join and pay $1.00 instead of $5.00" line.
 */
export function feeShareIfOneMoreJoins(order: OrderState): number {
  const { payingCount } = quote(order);
  return splitEvenly(order.deliveryFeeCents, payingCount + 1)[0];
}

// ---------------------------------------------------------------------------
// What is allowed
// ---------------------------------------------------------------------------

export type RefusalCode =
  | "not_member"
  | "not_host"
  | "wrong_status"
  | "empty_order"
  | "holds_missing"
  | "already_member"
  | "host_cannot_leave"
  | "past_cutoff"
  | "nothing_to_pay"
  | "already_paid";

/** Why something is not allowed. `message` is written for the person using the app. */
export interface Refusal {
  code: RefusalCode;
  message: string;
}

const refuse = (code: RefusalCode, message: string): Refusal => ({ code, message });

/** The whole state machine as data: where each action can start, where it ends, who may do it. */
export const TRANSITIONS: Record<
  OrderAction,
  { from: OrderStatus[]; to: OrderStatus; who: "host" | "member" }
> = {
  lock: { from: ["open"], to: "locked", who: "member" },
  unlock: { from: ["locked"], to: "open", who: "member" },
  place: { from: ["locked"], to: "placed", who: "host" },
  deliver: { from: ["placed"], to: "delivered", who: "member" },
  cancel: { from: ["open", "locked", "placed"], to: "cancelled", who: "host" },
};

/**
 * What an action does to the money.
 *
 *   capture  take the held money (the host is about to spend it)
 *   return   release every hold and refund every captured payment
 *   none     no money moves
 */
export const MONEY_EFFECT: Record<OrderAction, "capture" | "return" | "none"> = {
  lock: "none",
  unlock: "return",
  place: "capture",
  deliver: "none",
  cancel: "return",
};

const isMember = (order: OrderState, userId: string) =>
  order.members.some((m) => m.userId === userId);

const holdOf = (order: OrderState, userId: string): HoldStatus =>
  order.holds[userId] ?? "none";

/** Members who owe money and whose money is not yet held or captured. */
export function membersStillToPay(order: OrderState): Member[] {
  const quotes = quote(order).members;
  return order.members.filter((member, i) => {
    const hold = holdOf(order, member.userId);
    return quotes[i].totalCents > 0 && hold !== "authorized" && hold !== "captured";
  });
}

/** Returns null if `userId` may perform `action` right now, otherwise the reason not. */
export function checkAction(
  order: OrderState,
  action: OrderAction,
  userId: string,
): Refusal | null {
  const rule = TRANSITIONS[action];

  if (!isMember(order, userId)) {
    return refuse("not_member", "Join this order first.");
  }
  if (rule.who === "host" && userId !== order.hostId) {
    return refuse("not_host", "Only the host can do this.");
  }
  if (!rule.from.includes(order.status)) {
    return refuse("wrong_status", `An order that is ${order.status} cannot do this.`);
  }

  if (action === "lock" && order.items.length === 0) {
    return refuse("empty_order", "Add at least one item before locking the order.");
  }
  if (action === "place") {
    const waiting = membersStillToPay(order);
    if (waiting.length > 0) {
      const names = waiting.map((m) => m.name).join(", ");
      return refuse("holds_missing", `Still waiting for a card hold from: ${names}.`);
    }
  }
  return null;
}

/** The status after `action`. Throws if the action is not allowed. */
export function nextStatus(order: OrderState, action: OrderAction, userId: string): OrderStatus {
  const refusal = checkAction(order, action, userId);
  if (refusal) throw new OrderError(refusal);
  return TRANSITIONS[action].to;
}

export function checkJoin(order: OrderState, userId: string): Refusal | null {
  if (isMember(order, userId)) return refuse("already_member", "You are already in this order.");
  if (order.status !== "open") {
    return refuse("wrong_status", "This order is no longer taking new people.");
  }
  return null;
}

export function checkLeave(order: OrderState, userId: string): Refusal | null {
  if (!isMember(order, userId)) return refuse("not_member", "You are not in this order.");
  if (userId === order.hostId) {
    return refuse("host_cannot_leave", "The host cannot leave. Cancel the order instead.");
  }
  if (order.status !== "open") {
    return refuse("wrong_status", "Unlock the order before leaving it.");
  }
  return null;
}

/** May `userId` add or remove their own items at time `now`? */
export function checkEditItems(order: OrderState, userId: string, now: number): Refusal | null {
  if (!isMember(order, userId)) return refuse("not_member", "Join this order first.");
  if (order.status !== "open") {
    return refuse("wrong_status", "The cart is frozen. Unlock the order to change items.");
  }
  if (now >= order.cutoffAt) {
    return refuse("past_cutoff", "The cutoff time has passed, so items can no longer change.");
  }
  return null;
}

/** May `userId` put a hold on their card right now? */
export function checkHold(order: OrderState, userId: string): Refusal | null {
  if (!isMember(order, userId)) return refuse("not_member", "Join this order first.");
  if (order.status !== "locked") {
    return refuse("wrong_status", "Card holds are taken once the order is locked.");
  }
  const mine = quote(order).members.find((m) => m.userId === userId);
  if (!mine || mine.totalCents === 0) {
    return refuse("nothing_to_pay", "You have no items in this order, so there is nothing to pay.");
  }
  const hold = holdOf(order, userId);
  if (hold === "authorized" || hold === "captured") {
    return refuse("already_paid", "Your card hold is already in place.");
  }
  return null;
}

/** An action was refused by the rules above. */
export class OrderError extends Error {
  readonly code: RefusalCode;

  constructor(refusal: Refusal) {
    super(refusal.message);
    this.name = "OrderError";
    this.code = refusal.code;
  }
}
