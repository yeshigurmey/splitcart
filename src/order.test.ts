import { describe, expect, it } from "vitest";
import {
  MONEY_EFFECT,
  OrderError,
  TRANSITIONS,
  checkAction,
  checkEditItems,
  checkHold,
  checkJoin,
  checkLeave,
  feeShareIfOneMoreJoins,
  membersStillToPay,
  nextStatus,
  quote,
  type Item,
  type OrderAction,
  type OrderState,
  type OrderStatus,
} from "./order";

const CUTOFF = 1_000_000;

let nextItemId = 1;
const item = (userId: string, priceCents: number, quantity = 1): Item => ({
  id: `item-${nextItemId++}`,
  userId,
  name: "thing",
  priceCents,
  quantity,
});

/** An order hosted by Ana with Ben and Cy as members. */
function order(overrides: Partial<OrderState> = {}): OrderState {
  return {
    status: "open",
    hostId: "ana",
    cutoffAt: CUTOFF,
    deliveryFeeCents: 500,
    splitMode: "even",
    members: [
      { userId: "ana", name: "Ana" },
      { userId: "ben", name: "Ben" },
      { userId: "cy", name: "Cy" },
    ],
    items: [],
    holds: {},
    ...overrides,
  };
}

describe("quote", () => {
  it("splits the fee evenly between members who have items", () => {
    const q = quote(order({ items: [item("ana", 1200), item("ben", 800, 2)] }));

    expect(q.payingCount).toBe(2);
    expect(q.members).toEqual([
      { userId: "ana", itemsCents: 1200, feeShareCents: 250, totalCents: 1450, soloFeeCents: 500 },
      { userId: "ben", itemsCents: 1600, feeShareCents: 250, totalCents: 1850, soloFeeCents: 500 },
      { userId: "cy", itemsCents: 0, feeShareCents: 0, totalCents: 0, soloFeeCents: 0 },
    ]);
    expect(q.itemsCents).toBe(2800);
    expect(q.totalCents).toBe(3300);
  });

  it("gives leftover cents to whoever joined first", () => {
    const q = quote(
      order({ items: [item("ana", 100), item("ben", 100), item("cy", 100)] }),
    );
    // 500 / 3 = 166 remainder 2
    expect(q.members.map((m) => m.feeShareCents)).toEqual([167, 167, 166]);
  });

  it("skips empty-handed members when handing out leftover cents", () => {
    const q = quote(
      order({ deliveryFeeCents: 501, items: [item("ben", 100), item("cy", 100)] }),
    );
    expect(q.members.map((m) => m.feeShareCents)).toEqual([0, 251, 250]);
  });

  it("splits by order size when asked to", () => {
    const q = quote(
      order({
        splitMode: "by_size",
        deliveryFeeCents: 699,
        items: [item("ana", 4500), item("ben", 2500), item("cy", 1000)],
      }),
    );
    expect(q.members.map((m) => m.feeShareCents)).toEqual([393, 219, 87]);
  });

  it("charges no fee at all while the cart is empty", () => {
    const q = quote(order());
    expect(q.payingCount).toBe(0);
    expect(q.totalCents).toBe(0);
  });

  it("always hands out exactly the delivery fee, in both modes", () => {
    for (const splitMode of ["even", "by_size"] as const) {
      for (let fee = 0; fee <= 700; fee += 7) {
        const q = quote(
          order({
            splitMode,
            deliveryFeeCents: fee,
            items: [item("ana", 333), item("ben", 1999, 3), item("cy", 5)],
          }),
        );
        const shares = q.members.reduce((sum, m) => sum + m.feeShareCents, 0);
        expect(shares).toBe(fee);
        expect(q.totalCents).toBe(q.itemsCents + fee);
      }
    }
  });

  it("gets cheaper for everyone as more neighbours add items", () => {
    const one = quote(order({ items: [item("ana", 100)] }));
    const two = quote(order({ items: [item("ana", 100), item("ben", 100)] }));
    expect(one.members[0].feeShareCents).toBe(500);
    expect(two.members[0].feeShareCents).toBe(250);
  });
});

describe("feeShareIfOneMoreJoins", () => {
  it("is the whole fee for the first person and shrinks from there", () => {
    expect(feeShareIfOneMoreJoins(order())).toBe(500);
    expect(feeShareIfOneMoreJoins(order({ items: [item("ana", 100)] }))).toBe(250);
    expect(
      feeShareIfOneMoreJoins(order({ items: [item("ana", 100), item("ben", 100)] })),
    ).toBe(167);
  });
});

describe("the state machine", () => {
  const withItems = { items: [item("ana", 1000), item("ben", 500)] };
  const allHeld = { holds: { ana: "authorized", ben: "authorized" } as const };

  it("walks the happy path from open to delivered", () => {
    expect(nextStatus(order(withItems), "lock", "ben")).toBe("locked");
    expect(
      nextStatus(order({ ...withItems, ...allHeld, status: "locked" }), "place", "ana"),
    ).toBe("placed");
    expect(nextStatus(order({ ...withItems, status: "placed" }), "deliver", "cy")).toBe(
      "delivered",
    );
  });

  it("allows exactly the transitions in the table and no others", () => {
    const statuses: OrderStatus[] = ["open", "locked", "placed", "delivered", "cancelled"];
    const actions = Object.keys(TRANSITIONS) as OrderAction[];

    for (const status of statuses) {
      for (const action of actions) {
        // The host, with items in the cart and every hold in place, so the
        // only thing that can stop an action is the status it starts from.
        const state = order({ ...withItems, ...allHeld, status });
        const allowed = checkAction(state, action, "ana") === null;
        expect(allowed, `${action} from ${status}`).toBe(
          TRANSITIONS[action].from.includes(status),
        );
      }
    }
  });

  it("has no way out of delivered or cancelled", () => {
    for (const rule of Object.values(TRANSITIONS)) {
      expect(rule.from).not.toContain("delivered");
      expect(rule.from).not.toContain("cancelled");
    }
  });

  it("lets any member lock and unlock, so control is shared", () => {
    expect(checkAction(order(withItems), "lock", "cy")).toBeNull();
    expect(checkAction(order({ ...withItems, status: "locked" }), "unlock", "ben")).toBeNull();
  });

  it("keeps placing and cancelling for the host", () => {
    const locked = order({ ...withItems, ...allHeld, status: "locked" });
    expect(checkAction(locked, "place", "ben")?.code).toBe("not_host");
    expect(checkAction(locked, "cancel", "ben")?.code).toBe("not_host");
    expect(checkAction(locked, "cancel", "ana")).toBeNull();
  });

  it("refuses people who are not in the order", () => {
    expect(checkAction(order(withItems), "lock", "stranger")?.code).toBe("not_member");
  });

  it("refuses to lock an empty cart", () => {
    expect(checkAction(order(), "lock", "ana")?.code).toBe("empty_order");
  });

  it("refuses to place until every paying member's money is held", () => {
    const locked = order({ ...withItems, status: "locked", holds: { ana: "authorized" } });

    const refusal = checkAction(locked, "place", "ana");
    expect(refusal?.code).toBe("holds_missing");
    expect(refusal?.message).toContain("Ben");
    expect(membersStillToPay(locked).map((m) => m.userId)).toEqual(["ben"]);
  });

  it("does not wait on a member who has nothing to pay", () => {
    // Cy joined but added no items, so Cy owes nothing and needs no hold.
    const locked = order({ ...withItems, ...allHeld, status: "locked" });
    expect(membersStillToPay(locked)).toEqual([]);
    expect(checkAction(locked, "place", "ana")).toBeNull();
  });

  it("treats a declined or released hold as still unpaid", () => {
    for (const hold of ["failed", "released", "refunded", "pending", "none"] as const) {
      const locked = order({ ...withItems, status: "locked", holds: { ana: "authorized", ben: hold } });
      expect(checkAction(locked, "place", "ana")?.code, hold).toBe("holds_missing");
    }
  });

  it("lets a half-finished place be retried once some holds are captured", () => {
    const locked = order({
      ...withItems,
      status: "locked",
      holds: { ana: "captured", ben: "authorized" },
    });
    expect(checkAction(locked, "place", "ana")).toBeNull();
  });

  it("throws an OrderError carrying the reason", () => {
    try {
      nextStatus(order(), "lock", "ana");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(OrderError);
      expect((error as OrderError).code).toBe("empty_order");
    }
  });

  it("returns money on every path back out, and takes it only on place", () => {
    expect(MONEY_EFFECT).toEqual({
      lock: "none",
      unlock: "return",
      place: "capture",
      deliver: "none",
      cancel: "return",
    });
  });
});

describe("joining and leaving", () => {
  it("lets a neighbour join an open order once", () => {
    expect(checkJoin(order(), "dee")).toBeNull();
    expect(checkJoin(order(), "ben")?.code).toBe("already_member");
    expect(checkJoin(order({ status: "locked" }), "dee")?.code).toBe("wrong_status");
  });

  it("lets a member leave an open order, but not the host", () => {
    expect(checkLeave(order(), "ben")).toBeNull();
    expect(checkLeave(order(), "ana")?.code).toBe("host_cannot_leave");
    expect(checkLeave(order(), "dee")?.code).toBe("not_member");
    expect(checkLeave(order({ status: "locked" }), "ben")?.code).toBe("wrong_status");
  });
});

describe("editing items", () => {
  it("is allowed for members of an open order before the cutoff", () => {
    expect(checkEditItems(order(), "ben", CUTOFF - 1)).toBeNull();
  });

  it("stops at the cutoff", () => {
    expect(checkEditItems(order(), "ben", CUTOFF)?.code).toBe("past_cutoff");
  });

  it("stops when the order is locked", () => {
    expect(checkEditItems(order({ status: "locked" }), "ben", 0)?.code).toBe("wrong_status");
  });

  it("is refused for non-members", () => {
    expect(checkEditItems(order(), "dee", 0)?.code).toBe("not_member");
  });
});

describe("card holds", () => {
  const locked = (holds: OrderState["holds"] = {}) =>
    order({ status: "locked", items: [item("ana", 1000), item("ben", 500)], holds });

  it("can be taken once the order is locked", () => {
    expect(checkHold(locked(), "ben")).toBeNull();
    expect(checkHold(order({ items: [item("ben", 500)] }), "ben")?.code).toBe("wrong_status");
  });

  it("can be retried after a decline", () => {
    expect(checkHold(locked({ ben: "failed" }), "ben")).toBeNull();
  });

  it("cannot be taken twice", () => {
    expect(checkHold(locked({ ben: "authorized" }), "ben")?.code).toBe("already_paid");
  });

  it("is not needed by someone with no items", () => {
    expect(checkHold(locked(), "cy")?.code).toBe("nothing_to_pay");
  });
});
