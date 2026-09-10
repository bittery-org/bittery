import { ConfigurableIndexedDbReplicaExecutor } from "./indexeddb-executor-internal.ts";

/** The single production IndexedDB Replica owner, fixed to the application database. */
export class IndexedDbReplicaExecutor {
	readonly #executor = new ConfigurableIndexedDbReplicaExecutor();

	async invoke(requestJson: string): Promise<string> {
		return this.#executor.invoke(requestJson);
	}
}
