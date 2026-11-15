import { useState, type FormEvent } from "react";
import { api, useLive, type Me, type OrderSummary } from "./api";
import { formatCents, formatTime, localInputValue, parseDollars, plural } from "./format";

const STATUS_LABEL: Record<OrderSummary["status"], string> = {
  open: "Open",
  locked: "Collecting holds",
  placed: "Placed",
  delivered: "Delivered",
  cancelled: "Cancelled",
};

export function HomePage({ me }: { me: Me }) {
  const orders = useLive<OrderSummary[]>("/events");
  const [starting, setStarting] = useState(false);

  const active = orders.value?.filter((o) => o.status !== "delivered" && o.status !== "cancelled") ?? [];
  const past = orders.value?.filter((o) => o.status === "delivered" || o.status === "cancelled") ?? [];

  return (
    <>
      <section className="building">
        <div>
          <p className="eyebrow">Your building</p>
          <h1>{me.building.name}</h1>
        </div>
        <InviteCode code={me.building.code} />
      </section>

      <section>
        <div className="section-head">
          <h2>Orders</h2>
          {!starting && (
            <button className="primary" onClick={() => setStarting(true)}>
              Start an order
            </button>
          )}
        </div>

        {starting && <NewOrderForm onCancel={() => setStarting(false)} />}

        {orders.failed && <p className="error">Live updates are unavailable. Reload the page to try again.</p>}
        {orders.value === null && !orders.failed && <p className="muted">Loading orders…</p>}
        {orders.value?.length === 0 && !starting && (
          <div className="empty">
            <p>
              <strong>No orders yet.</strong>
            </p>
            <p>
              Start one before your next grocery run, then share the building code so neighbours can
              add their items and bring the delivery fee down for everyone.
            </p>
          </div>
        )}

        <ul className="order-list">
          {active.map((order) => (
            <OrderCard key={order.id} order={order} />
          ))}
        </ul>

        {past.length > 0 && (
          <>
            <h3 className="past-head">Finished</h3>
            <ul className="order-list">
              {past.map((order) => (
                <OrderCard key={order.id} order={order} />
              ))}
            </ul>
          </>
        )}
      </section>
    </>
  );
}

function InviteCode({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be blocked. The code is on screen to copy by hand.
    }
  }

  return (
    <div className="invite">
      <p className="eyebrow">Invite neighbours with this code</p>
      <div className="invite-row">
        <code>{code}</code>
        <button className="link" onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

function OrderCard({ order }: { order: OrderSummary }) {
  const finished = order.status === "delivered" || order.status === "cancelled";
  const saving = order.yourFeeCents !== null && order.yourFeeCents < order.deliveryFeeCents;

  return (
    <li>
      <a className={`card order-card${finished ? " is-finished" : ""}`} href={`#/orders/${order.id}`}>
        <div className="order-card-main">
          <p className="order-store">{order.store}</p>
          <p className="muted">
            {order.deliverySlot} · hosted by {order.hostName}
          </p>
          <p className="muted">
            {plural(order.payingCount, "neighbour")} ordering
            {order.status === "open" && <> · items close {formatTime(order.cutoffAt)}</>}
          </p>
        </div>
        <div className="order-card-side">
          <span className={`chip chip-${order.status}`}>{STATUS_LABEL[order.status]}</span>
          {!finished && order.yourFeeCents !== null && (
            <p className="order-fee">
              <span className="order-fee-label">{order.isMember ? "Your delivery" : "Delivery if you join"}</span>
              <strong>{formatCents(order.yourFeeCents)}</strong>
              {saving && <s>{formatCents(order.deliveryFeeCents)}</s>}
            </p>
          )}
        </div>
      </a>
    </li>
  );
}

function NewOrderForm({ onCancel }: { onCancel: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const field = (name: string) => String(form.get(name) ?? "");

    const deliveryFeeCents = parseDollars(field("fee"));
    if (deliveryFeeCents === null || deliveryFeeCents === 0) {
      return setError("Enter the delivery fee as an amount, like 4.99.");
    }
    const cutoffAt = new Date(field("cutoff")).getTime();
    if (Number.isNaN(cutoffAt)) return setError("Pick a cutoff time.");

    setBusy(true);
    setError(null);
    try {
      const order = await api.createOrder({
        store: field("store"),
        deliverySlot: field("slot"),
        cutoffAt,
        deliveryFeeCents,
        splitMode: field("split") === "by_size" ? "by_size" : "even",
      });
      window.location.hash = `/orders/${order.id}`;
    } catch (problem) {
      setError((problem as Error).message);
      setBusy(false);
    }
  }

  return (
    <form className="card new-order" onSubmit={submit}>
      <h3>Start an order</h3>
      <p className="muted">
        You are the host: you will place the real order with the store once everyone has paid.
      </p>
      <div className="grid-2">
        <label>
          Store
          <input name="store" required maxLength={60} placeholder="FreshCo" />
        </label>
        <div className="field">
          <label>
            Delivery fee
            <input name="fee" required inputMode="decimal" placeholder="4.99" />
          </label>
          <p className="hint">The fee the store or app shows for one delivery.</p>
        </div>
        <label>
          Delivery time
          <input name="slot" required maxLength={60} placeholder="Saturday 2 to 4 pm" />
        </label>
        <div className="field">
          <label>
            Items close at
            <input name="cutoff" type="datetime-local" required defaultValue={localInputValue(3)} />
          </label>
          <p className="hint">After this, nobody can change their items.</p>
        </div>
      </div>
      <fieldset>
        <legend>How to split the delivery fee</legend>
        <label className="choice">
          <input type="radio" name="split" value="even" defaultChecked />
          Evenly between everyone who orders
        </label>
        <label className="choice">
          <input type="radio" name="split" value="by_size" />
          By order size, so smaller orders pay less
        </label>
      </fieldset>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="actions">
        <button className="primary" disabled={busy}>
          {busy ? "Creating…" : "Create order"}
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          Never mind
        </button>
      </div>
    </form>
  );
}
