export type PubSubChannel = "sync" | (string & {});

export interface PubSubMessage {
	channel: PubSubChannel;
	payload: unknown;
}

export type PubSubSubscriber = (message: PubSubMessage) => void | Promise<void>;

export interface PubSubAdapter {
	publish(channel: PubSubChannel, payload: unknown): Promise<void>;
	subscribe(channel: PubSubChannel, subscriber: PubSubSubscriber): () => void;
	close(): Promise<void>;
}
