import type { PubSubAdapter, PubSubChannel, PubSubSubscriber } from "../types";

/**
 * Redis pub/sub adapter using Bun's built-in RedisClient.
 * Activated when REDIS_URL env var is set.
 * Uses two connections: one for publishing, one for subscribing.
 */
export class RedisPubSubAdapter implements PubSubAdapter {
	private pub: import("bun").RedisClient;
	private sub: import("bun").RedisClient;
	private localSubscribers = new Map<PubSubChannel, Set<PubSubSubscriber>>();

	constructor(redisUrl: string) {
		const { RedisClient } = globalThis.Bun ?? {};
		if (!RedisClient) {
			throw new Error(
				"RedisPubSubAdapter requires Bun runtime with RedisClient support",
			);
		}
		this.pub = new RedisClient(redisUrl);
		this.sub = new RedisClient(redisUrl);
	}

	async publish(channel: PubSubChannel, payload: unknown): Promise<void> {
		const message = JSON.stringify(payload);
		await this.pub.publish(channel, message);
	}

	subscribe(channel: PubSubChannel, subscriber: PubSubSubscriber): () => void {
		let subs = this.localSubscribers.get(channel);
		const isNewChannel = !subs;

		if (!subs) {
			subs = new Set();
			this.localSubscribers.set(channel, subs);
		}
		subs.add(subscriber);

		// Subscribe to Redis channel if this is the first local subscriber
		if (isNewChannel) {
			this.sub
				.subscribe(channel, (message: string) => {
					let payload: unknown;
					try {
						payload = JSON.parse(message);
					} catch {
						payload = message;
					}

					const channelSubs = this.localSubscribers.get(channel);
					if (!channelSubs) return;

					for (const sub of channelSubs) {
						try {
							void sub({ channel, payload });
						} catch (err) {
							console.error(
								`[pubsub:redis] Subscriber error on channel "${channel}":`,
								err,
							);
						}
					}
				})
				.catch((err: unknown) => {
					console.error(
						`[pubsub:redis] Failed to subscribe to "${channel}":`,
						err,
					);
				});
		}

		return () => {
			subs.delete(subscriber);
			if (subs.size === 0) {
				this.localSubscribers.delete(channel);
				this.sub.unsubscribe(channel).catch((err: unknown) => {
					console.error(
						`[pubsub:redis] Failed to unsubscribe from "${channel}":`,
						err,
					);
				});
			}
		};
	}

	async close(): Promise<void> {
		this.localSubscribers.clear();
		this.pub.close();
		this.sub.close();
	}
}
