import { NATIVE_HOST_NAME } from "./constants";

export function sendNativeMessage(message: unknown): Promise<unknown> {
	return new Promise((resolve, reject) => {
		try {
			const port = chrome.runtime.connectNative(NATIVE_HOST_NAME);

			const timeout = setTimeout(() => {
				port.disconnect();
				reject(new Error("Native messaging timeout"));
			}, 30000);

			port.onMessage.addListener((response) => {
				clearTimeout(timeout);
				port.disconnect();
				resolve(response);
			});

			port.onDisconnect.addListener(() => {
				clearTimeout(timeout);
				const error = chrome.runtime.lastError;
				if (error) {
					reject(
						new Error(
							`Native host disconnected: ${error.message || "Unknown error"}`,
						),
					);
					return;
				}

				reject(new Error("Native host disconnected"));
			});

			port.postMessage(message);
		} catch (error) {
			reject(error);
		}
	});
}
