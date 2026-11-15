/**
 * A tiny publish/subscribe hub for live updates.
 *
 * When something about an order changes, the service publishes to the topic
 * "order:<id>". Every browser with that order open has subscribed to the same
 * topic, so each one is told to refresh. This lives in memory, which is fine
 * for a single server process; running several would need a shared hub such
 * as Redis.
 */

type Listener = () => void;

export class Events {
  private readonly topics = new Map<string, Set<Listener>>();

  /** Returns a function that removes the listener again. */
  subscribe(topic: string, listener: Listener): () => void {
    let listeners = this.topics.get(topic);
    if (!listeners) {
      listeners = new Set();
      this.topics.set(topic, listeners);
    }
    listeners.add(listener);

    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.topics.delete(topic);
    };
  }

  publish(topic: string): void {
    // Copy first, so a listener that unsubscribes while being called is safe.
    for (const listener of [...(this.topics.get(topic) ?? [])]) {
      try {
        listener();
      } catch {
        // One broken connection must not stop the others from hearing.
      }
    }
  }

  listenerCount(topic: string): number {
    return this.topics.get(topic)?.size ?? 0;
  }
}

export const orderTopic = (orderId: string) => `order:${orderId}`;
export const buildingTopic = (buildingId: string) => `building:${buildingId}`;
