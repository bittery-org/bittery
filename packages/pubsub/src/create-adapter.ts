import type { PubSubAdapter } from "./types";

/**
 * Create the appropriate PubSub adapter based on environment.
 * - If REDIS_URL is set → RedisPubSubAdapter (horizontal scaling)
 * - Otherwise → InMemoryPubSubAdapter (single process, zero deps)
 */
export async function createPubSubAdapter(): Promise<PubSubAdapter> {
	const redisUrl = process.env.REDIS_URL;

	if (redisUrl) {
		const { RedisPubSubAdapter } = await import("./adapters/redis");
		console.log("[pubsub] Using Redis adapter");
		return new RedisPubSubAdapter(redisUrl);
	}

	const { InMemoryPubSubAdapter } = await import("./adapters/in-memory");
	console.log("[pubsub] Using in-memory adapter");
	return new InMemoryPubSubAdapter();
}
