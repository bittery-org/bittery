import type { PubSubAdapter, PubSubChannel, PubSubSubscriber } from "../types";

/**
 * In-memory pub/sub adapter.
 * Default adapter — synchronous in-process delivery, zero dependencies.
 */
export class InMemoryPubSubAdapter implements PubSubAdapter {
	private subscribers = new Map<PubSubChannel, Set<PubSubSubscriber>>();

	async publish(channel: PubSubChannel, payload: unknown): Promise<void> {
		const subs = this.subscribers.get(channel);
		if (!subs) return;

		for (const subscriber of subs) {
			try {
				await subscriber({ channel, payload });
			} catch (err) {
				console.error(
					`[pubsub:in-memory] Subscriber error on channel "${channel}":`,
					err,
				);
			}
		}
	}

	subscribe(channel: PubSubChannel, subscriber: PubSubSubscriber): () => void {
		let subs = this.subscribers.get(channel);
		if (!subs) {
			subs = new Set();
			this.subscribers.set(channel, subs);
		}
		subs.add(subscriber);

		return () => {
			subs.delete(subscriber);
			if (subs.size === 0) {
				this.subscribers.delete(channel);
			}
		};
	}

	async close(): Promise<void> {
		this.subscribers.clear();
	}
}
