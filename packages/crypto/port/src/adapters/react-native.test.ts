import { expect, test } from "bun:test";
import { runCryptoPortConformance } from "./port-conformance";
import { createReactNativeCryptoPort } from "./react-native";
import { createWasmDoubles } from "./wasm-test-doubles";

async function makeReactNativePort() {
	const doubles = createWasmDoubles();
	const port = createReactNativeCryptoPort(doubles.deps);
	await port.initialize();
	return { doubles, port };
}

runCryptoPortConformance(
	"react-native",
	async () => (await makeReactNativePort()).port,
);

test("React Native destroys generated KeyHandle objects exactly once", async () => {
	const { doubles, port } = await makeReactNativePort();
	const key = await port.generateEncryptionKey();

	await port.destroyKey(key);
	await port.destroyKey(key);

	expect(doubles.wasm.destroyCalls).toBe(1);
	expect(doubles.wasm.liveHandleCount).toBe(0);
});
