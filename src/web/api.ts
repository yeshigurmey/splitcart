/**
 * Every call the browser makes to the server, in one place.
 *
 * The types are imported from the server code, so if the server changes what
 * it sends, the web app stops compiling until it is updated to match.
 */

import { useEffect, useState } from "react";
import type { OrderAction } from "../order";
import type { Building, OrderSummary, OrderView, User } from "../server/service";

export type { Building, OrderAction, OrderSummary, OrderView, User };
export type Me = { user: User; building: Building };

/** The server said no. `message` is already written for the person using the app. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "offline", "Could not reach SplitCart. Check your connection and try again.");
  }

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiError(
      response.status,
      data?.error?.code ?? "unknown",
      data?.error?.message ?? "Something went wrong. Please try again.",
    );
  }
  return data as T;
}

export const api = {
  me: () => call<Me>("GET", "/me"),
  signup: (details: {
    name: string;
    email: string;
    password: string;
    buildingName?: string;
    buildingCode?: string;
  }) => call<Me>("POST", "/signup", details),
  login: (details: { email: string; password: string }) => call<Me>("POST", "/login", details),
  logout: () => call<{ ok: true }>("POST", "/logout"),

  createOrder: (details: {
    store: string;
    deliverySlot: string;
    cutoffAt: number;
    deliveryFeeCents: number;
    splitMode: "even" | "by_size";
  }) => call<OrderView>("POST", "/orders", details),
  join: (id: string) => call<OrderView>("POST", `/orders/${id}/join`),
  leave: (id: string) => call<OrderView>("POST", `/orders/${id}/leave`),
  addItem: (id: string, item: { name: string; priceCents: number; quantity: number }) =>
    call<OrderView>("POST", `/orders/${id}/items`, item),
  removeItem: (id: string, itemId: string) => call<OrderView>("DELETE", `/orders/${id}/items/${itemId}`),
  act: (id: string, action: OrderAction) => call<OrderView>("POST", `/orders/${id}/${action}`),
  hold: (id: string, paymentMethod: string) =>
    call<OrderView>("POST", `/orders/${id}/hold`, { paymentMethod }),
};

/**
 * Keep a value in step with the server over a server-sent events stream.
 *
 * The browser's EventSource holds the connection open and reconnects by
 * itself if it drops. Every message is the complete, current value, so a
 * missed message never leaves the screen out of date for long.
 *
 * Returns the latest value (null until the first message arrives), whether
 * the stream is unavailable, and a setter for showing the result of your own
 * action straight away instead of waiting for it to come back down the stream.
 */
export function useLive<T>(path: string): { value: T | null; failed: boolean; set: (value: T) => void } {
  const [value, setValue] = useState<T | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setValue(null);
    setFailed(false);
    const source = new EventSource(`/api${path}`);
    source.onmessage = (event) => {
      setValue(JSON.parse(event.data) as T);
      setFailed(false);
    };
    // CLOSED means the server refused (not found, logged out) and the browser
    // has given up. Anything else is a dropped connection it will retry.
    source.onerror = () => setFailed(source.readyState === EventSource.CLOSED);
    return () => source.close();
  }, [path]);

  return { value, failed, set: setValue };
}
