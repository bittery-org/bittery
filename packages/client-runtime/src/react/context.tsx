import { createContext, type ReactNode, useContext } from "react";
import type { RuntimeClient } from "../client";

const RuntimeClientContext = createContext<RuntimeClient | null>(null);

export interface RuntimeProviderProps {
	/**
	 * An already-built client. The provider never builds one: the Worker behind it is
	 * process-wide and must outlive every mount, and a second one would mean a second
	 * Crypto key table whose `KeyRef` values the first rejects.
	 */
	client: RuntimeClient;
	children: ReactNode;
}

/** Passes the client down. It holds no state, so a re-render costs nothing. */
export function RuntimeProvider({ client, children }: RuntimeProviderProps) {
	return (
		<RuntimeClientContext.Provider value={client}>
			{children}
		</RuntimeClientContext.Provider>
	);
}

export function useRuntimeClient(): RuntimeClient {
	const client = useContext(RuntimeClientContext);
	if (client === null) {
		throw new Error("A Runtime hook needs a RuntimeProvider above it.");
	}
	return client;
}
