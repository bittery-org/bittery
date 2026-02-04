import Constants from "expo-constants";
import { Platform } from "react-native";

// For development: Get your Mac's IP address from Expo's dev server
// This works when running `pnpm run dev:mobile` and connecting via Expo Go or dev build
const getDevServerUrl = (): string => {
	// Try multiple sources to get the dev machine IP
	let devIp: string | undefined;

	// 1. Try debuggerHost (most reliable in dev)
	if (Constants.debuggerHost) {
		devIp = Constants.debuggerHost.split(":").shift();
	}

	// 2. Fallback to hostUri from expoConfig
	if (!devIp && Constants.expoConfig?.hostUri) {
		devIp = Constants.expoConfig.hostUri.split(":").shift();
	}

	// 3. Manual override via app.json extra config (add "apiDevHost": "192.168.1.100" to extra)
	if (!devIp && Constants.expoConfig?.extra?.apiDevHost) {
		devIp = Constants.expoConfig.extra.apiDevHost;
	}

	// 4. Platform-specific fallbacks
	if (!devIp) {
		if (Platform.OS === "ios") {
			devIp = "localhost"; // iOS simulator can use localhost
		} else if (Platform.OS === "android") {
			// Use localhost with adb reverse (run: adb reverse tcp:3000 tcp:3000)
			// This is more reliable than 10.0.2.2
			devIp = "localhost";
			console.warn(
				"Could not detect dev IP. Using localhost with adb reverse.\n" +
					"Run this command: adb reverse tcp:3000 tcp:3000\n" +
					"Or add your Mac's IP to app.json: " +
					'{ "extra": { "apiDevHost": "192.168.1.XXX" } }',
			);
		}
	}

	return devIp ? `http://${devIp}:3000` : "https://api.bittery.com";
};

export const defaultServerUrl =
	__DEV__ ? getDevServerUrl() : "https://api.bittery.com";

// Log in dev for debugging
if (__DEV__) {
	console.log("API Server URL:", defaultServerUrl);
}
