import type { KeyHandleLike } from "@bittery/crypto-react-native";
import type { CryptoPort } from "../crypto-port";
import {
	createCryptoUniffiBackend,
	type UniffiBackend,
} from "../uniffi-bindings";
import { createHandleCryptoPort, type HandleCryptoPortDeps } from "./wasm";

export type ReactNativeCryptoPortDeps = HandleCryptoPortDeps<KeyHandleLike>;

const DEFAULT_DEPS: ReactNativeCryptoPortDeps = {
	loadBackend: async (): Promise<UniffiBackend<KeyHandleLike>> => {
		const bindings = await import("@bittery/crypto-react-native");
		await bindings.uniffiInitAsync();
		return createCryptoUniffiBackend(bindings);
	},
};

export function createReactNativeCryptoPort(
	deps: ReactNativeCryptoPortDeps = DEFAULT_DEPS,
): CryptoPort {
	return createHandleCryptoPort(deps);
}
