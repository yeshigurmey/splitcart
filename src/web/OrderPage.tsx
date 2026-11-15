import { useState, type FormEvent, type ReactNode } from "react";
import { api, useLive, type OrderAction, type OrderView } from "./api";
import { formatCents, formatTime, parseDollars, plural } from "./format";

type Member = OrderView["members"][number];

const STEPS: { status: OrderView["status"]; label: string }[] = [
  { status: "open", label: "Add items" },
  { status: "locked", label: "Hold cards" },
  { status: "placed", label: "Order placed" },
  { status: "delivered", label: "Delivered" },
];

const HOLD_LABEL: Record<Member["hold"], string> = {
  none: "Not paid yet",
  pending: "Checking card…",
  authorized: "Card hold in place",
  captured: "Paid",
  released: "Hold released",
  refunded: "Refunded",
  failed: "Card declined",
};

export function OrderPage({ orderId }: { orderId: string }) {
  const live = useLive<OrderView>(`/orders/${orderId}/events`);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** Run one request, show its result straight away, and surface any refusal. */
  async function run(request: () => Promise<OrderView>): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      live.set(await request());
      return true;
    } catch (problem) {
      setError((problem as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (live.failed && !live.value) {
    return (
      <div className="empty">
        <p>
          <strong>This order could not be opened.</strong>
        </p>
        <p>It may belong to another building, or the link may be wrong.</p>
        <a href="#/">Back to your building's orders</a>
      </div>
    );
  }
  if (!live.value) return <p className="loading">Loading order…</p>;

  const order = live.value;
  const act = (action: OrderAction) => run(() => api.act(order.id, action));

  return (
    <>
      <a className="back" href="#/">
        ← All orders
      </a>

      <header className="order-head">
        <h1>{order.store}</h1>
        <p className="muted">
          {order.deliverySlot} · hosted by {order.you.isHost ? "you" : order.hostName}
        </p>
      </header>

      <FeeHero order={order} />
      <Steps order={order} />

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {live.failed && <p className="error">Connection lost. Trying to reconnect…</p>}

      <NextStep order={order} busy={busy} act={act} run={run} />

      <section>
        <div className="section-head">
          <h2>Who is ordering</h2>
          <p className="muted">
            Items {formatCents(order.itemsCents)} + delivery {formatCents(order.deliveryFeeCents)}
          </p>
        </div>
        <ul className="members">
          {order.members.map((member) => (
            <MemberRow
              key={member.userId}
              order={order}
              member={member}
              busy={busy}
              onRemove={(itemId) => run(() => api.removeItem(order.id, itemId))}
            />
          ))}
        </ul>
      </section>

      {order.can.editItems === null && (
        <AddItemForm busy={busy} onAdd={(item) => run(() => api.addItem(order.id, item))} />
      )}
      {order.you.isMember && order.status === "open" && order.can.editItems !== null && (
        <p className="note">{order.can.editItems}</p>
      )}

      <Footer order={order} busy={busy} act={act} run={run} />
    </>
  );
}

/** The one number this app exists for: what delivery costs you now. */
function FeeHero({ order }: { order: OrderView }) {
  const full = order.deliveryFeeCents;
  const ordering = order.you.totalCents > 0;
  const live = order.status === "open";

  let label: string;
  let amount: number;
  let detail: ReactNode;

  if (ordering) {
    label = "Your delivery";
    amount = order.you.feeShareCents;
    const others = order.payingCount - 1;
    detail =
      others === 0 ? (
        <>You are the only one ordering so far. Every neighbour who adds an item cuts this.</>
      ) : (
        <>
          Split with {plural(others, "neighbour")}.
          {live && order.feeIfOneMoreJoinsCents !== null && (
            <> One more brings it to {formatCents(order.feeIfOneMoreJoinsCents)}.</>
          )}
        </>
      );
  } else if (order.feeIfOneMoreJoinsCents !== null && live) {
    label = order.payingCount === 0 ? "Delivery for this order" : "Your delivery if you add an item";
    amount = order.feeIfOneMoreJoinsCents;
    detail =
      order.payingCount === 0 ? (
        <>Nobody has added items yet. The fee is shared between everyone who does.</>
      ) : (
        <>{plural(order.payingCount, "neighbour")} already ordering. Add an item to share the fee.</>
      );
  } else {
    label = "Delivery fee";
    amount = full;
    detail =
      order.splitMode === "by_size" ? (
        <>Shared between {plural(order.payingCount, "neighbour")} by order size.</>
      ) : (
        <>Shared between {plural(order.payingCount, "neighbour")}.</>
      );
  }

  const saved = full - amount;

  return (
    <section className="hero" aria-live="polite">
      <p className="hero-label">{label}</p>
      <p className="hero-amount">
        <strong>{formatCents(amount)}</strong>
        {saved > 0 && (
          <span className="hero-was">
            instead of <s>{formatCents(full)}</s>
          </span>
        )}
      </p>
      <p className="hero-detail">{detail}</p>
    </section>
  );
}

function Steps({ order }: { order: OrderView }) {
  if (order.status === "cancelled") return <p className="chip chip-cancelled steps-cancelled">Cancelled</p>;
  const current = STEPS.findIndex((step) => step.status === order.status);

  return (
    <ol className="steps">
      {STEPS.map((step, i) => (
        <li
          key={step.status}
          className={i < current ? "done" : i === current ? "current" : ""}
          aria-current={i === current ? "step" : undefined}
        >
          {step.label}
        </li>
      ))}
    </ol>
  );
}

interface ActionProps {
  order: OrderView;
  busy: boolean;
  act: (action: OrderAction) => Promise<boolean>;
  run: (request: () => Promise<OrderView>) => Promise<boolean>;
}

/** What is happening now and the one thing this person should do next. */
function NextStep({ order, busy, act, run }: ActionProps) {
  const host = order.you.isHost ? "you" : order.hostName;

  if (!order.you.isMember) {
    return (
      <section className="card next">
        {order.can.join === null ? (
          <>
            <p>Join to add your items. Looking is free: you only share the fee once you add something.</p>
            <button className="primary" disabled={busy} onClick={() => run(() => api.join(order.id))}>
              Join this order
            </button>
          </>
        ) : (
          <p>{order.can.join}</p>
        )}
      </section>
    );
  }

  if (order.status === "open") {
    return (
      <section className="card next">
        <p>
          Items close <strong>{formatTime(order.cutoffAt)}</strong>
        </p>
        <p>
          Add what you need. When everyone is done, lock the cart so people can pay. Anyone in the
          order can lock it.
        </p>
        <button className="primary" disabled={busy || order.can.lock !== null} onClick={() => act("lock")}>
          Lock the cart
        </button>
        {order.can.lock !== null && <p className="hint">{order.can.lock}</p>}
      </section>
    );
  }

  if (order.status === "locked") {
    return (
      <section className="card next">
        <p>
          The cart is frozen. Everyone puts a hold on their card for their items and their share of
          delivery. <strong>Nothing is charged</strong> until the host places the order.
        </p>

        {order.can.hold === null && <HoldForm order={order} busy={busy} run={run} />}
        {order.you.hold === "authorized" && (
          <p className="ok">Your hold of {formatCents(order.you.totalCents)} is in place.</p>
        )}
        {order.you.totalCents === 0 && <p className="note">You have no items, so there is nothing for you to pay.</p>}

        {order.waitingOn.length > 0 && (
          <p className="muted">Still waiting for: {order.waitingOn.join(", ")}.</p>
        )}

        <div className="actions">
          {order.you.isHost && (
            <button className="primary" disabled={busy || order.can.place !== null} onClick={() => act("place")}>
              Everyone has paid: charge the holds
            </button>
          )}
          <button className="secondary" disabled={busy || order.can.unlock !== null} onClick={() => act("unlock")}>
            Unlock to change items
          </button>
        </div>
        {order.you.isHost && order.can.place === null && (
          <p className="hint">Do this right before you place the real order with {order.store}.</p>
        )}
        <p className="hint">Unlocking releases every hold. People pay again once it is locked.</p>
      </section>
    );
  }

  if (order.status === "placed") {
    return (
      <section className="card next">
        <p>
          Everyone has paid and {host === "you" ? "you are" : `${host} is`} placing the order with{" "}
          {order.store}. Delivery: {order.deliverySlot}.
        </p>
        <button className="primary" disabled={busy || order.can.deliver !== null} onClick={() => act("deliver")}>
          The groceries arrived
        </button>
      </section>
    );
  }

  if (order.status === "delivered") {
    return (
      <section className="card next">
        <p className="ok">Delivered. Pick up your bags in the lobby.</p>
      </section>
    );
  }

  return (
    <section className="card next">
      <p>This order was cancelled. Every hold was released and every payment refunded.</p>
    </section>
  );
}

function HoldForm({ order, busy, run }: Pick<ActionProps, "order" | "busy" | "run">) {
  const [card, setCard] = useState<string>(order.payment.testCards[0].id);
  const mine = order.members.find((member) => member.isYou);

  return (
    <div className="hold">
      {mine?.holdFailure && (
        <p className="error" role="alert">
          {mine.holdFailure} Try another card.
        </p>
      )}
      <div className="field">
        <label>
          Card
          <select value={card} onChange={(event) => setCard(event.target.value)}>
            {order.payment.testCards.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <p className="hint">
          Test mode: these are practice cards, and no real money moves.
        </p>
      </div>
      <button className="primary" disabled={busy} onClick={() => run(() => api.hold(order.id, card))}>
        Hold {formatCents(order.you.totalCents)} on my card
      </button>
    </div>
  );
}

function MemberRow({
  order,
  member,
  busy,
  onRemove,
}: {
  order: OrderView;
  member: Member;
  busy: boolean;
  onRemove: (itemId: string) => void;
}) {
  const canEdit = member.isYou && order.can.editItems === null;
  const showHold = order.status !== "open" && member.totalCents > 0;

  return (
    <li className="card member">
      <div className="member-head">
        <p className="member-name">
          {member.name}
          {member.isYou && <span className="tag">You</span>}
          {member.isHost && <span className="tag">Host</span>}
        </p>
        {showHold && <span className={`chip hold-${member.hold}`}>{HOLD_LABEL[member.hold]}</span>}
      </div>

      {member.items === null ? (
        <p className="muted">{member.itemCount === 0 ? "No items yet" : plural(member.itemCount, "item")}</p>
      ) : member.items.length === 0 ? (
        <p className="muted">No items yet</p>
      ) : (
        <ul className="items">
          {member.items.map((item) => (
            <li key={item.id}>
              <span className="item-name">
                {item.quantity > 1 && <span className="qty">{item.quantity} ×</span>} {item.name}
              </span>
              <span className="item-price">{formatCents(item.priceCents * item.quantity)}</span>
              {canEdit && (
                <button
                  className="link remove"
                  disabled={busy}
                  onClick={() => onRemove(item.id)}
                  aria-label={`Remove ${item.name}`}
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {member.totalCents > 0 && (
        <p className="member-total">
          <span>
            Items {formatCents(member.itemsCents)} + delivery {formatCents(member.feeShareCents)}
          </span>
          <strong>{formatCents(member.totalCents)}</strong>
        </p>
      )}
    </li>
  );
}

function AddItemForm({
  busy,
  onAdd,
}: {
  busy: boolean;
  onAdd: (item: { name: string; priceCents: number; quantity: number }) => Promise<boolean>;
}) {
  const [problem, setProblem] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);

    const priceCents = parseDollars(String(form.get("price") ?? ""));
    if (priceCents === null || priceCents === 0) return setProblem("Enter the price as an amount, like 3.49.");
    const quantity = Number(form.get("quantity"));
    if (!Number.isInteger(quantity) || quantity < 1) return setProblem("Quantity must be 1 or more.");

    setProblem(null);
    const added = await onAdd({ name: String(form.get("name") ?? ""), priceCents, quantity });
    if (added) {
      formElement.reset();
      formElement.querySelector<HTMLInputElement>("input[name=name]")?.focus();
    }
  }

  return (
    <form className="card add-item" onSubmit={submit}>
      <h3>Add an item</h3>
      <div className="add-item-row">
        <label className="grow">
          Item
          <input name="name" required maxLength={80} placeholder="Eggs, 12 pack" />
        </label>
        <label>
          Price each
          <input name="price" required inputMode="decimal" placeholder="3.49" size={6} />
        </label>
        <label>
          Qty
          <input name="quantity" type="number" min={1} max={99} defaultValue={1} required />
        </label>
        <button className="primary" disabled={busy}>
          Add
        </button>
      </div>
      {problem && (
        <p className="error" role="alert">
          {problem}
        </p>
      )}
      <p className="hint">Use the price the store shows. Only you and the host can see what you add.</p>
    </form>
  );
}

function Footer({ order, busy, act, run }: ActionProps) {
  const [confirming, setConfirming] = useState(false);
  const canLeave = order.can.leave === null;
  const canCancel = order.can.cancel === null;
  if (!canLeave && !canCancel) return null;

  return (
    <footer className="order-foot">
      {canLeave && (
        <button className="link" disabled={busy} onClick={() => run(() => api.leave(order.id))}>
          Leave this order
        </button>
      )}
      {canCancel && !confirming && (
        <button className="link danger" disabled={busy} onClick={() => setConfirming(true)}>
          {order.status === "placed" ? "Order fell through: refund everyone" : "Cancel this order"}
        </button>
      )}
      {canCancel && confirming && (
        <div className="confirm">
          <p>Cancel for everyone? All holds are released and all payments refunded. This cannot be undone.</p>
          <div className="actions">
            <button
              className="danger-button"
              disabled={busy}
              onClick={async () => {
                await act("cancel");
                setConfirming(false);
              }}
            >
              Yes, cancel the order
            </button>
            <button className="secondary" onClick={() => setConfirming(false)}>
              Keep it
            </button>
          </div>
        </div>
      )}
    </footer>
  );
}
