/**
 * Every platform adapter, as a `PlatformPort` + `RecordPort` pair.
 *
 * This barrel exists for discoverability only. **Apps must import the subpath they need**
 * (`@bittery/storage/adapters/tauri`, etc.), because each adapter reaches for optional peer
 * dependencies behind dynamic `import()` and a barrel import would defeat tree-shaking on
 * the platforms that do not have them installed.
 */

export { createChromePlatformPort, createChromeRecordPort } from "./chrome";
export {
	createReactNativePlatformPort,
	createReactNativeRecordPort,
} from "./react-native";
export { createTauriPlatformPort, createTauriRecordPort } from "./tauri";
export { createWebPlatformPort, createWebRecordPort } from "./web";
