export interface DeviceInfo {
	deviceName: string;
	platform: "web" | "desktop" | "extension" | "ios" | "android";
	clientId?: string | null;
	browserName: string | null;
	browserVersion: string | null;
	osName: string | null;
	osVersion: string | null;
}

type Detector<T> = {
	match: (ua: string) => boolean;
	detect: (userAgent: string, ua: string) => T;
};

type OsDetection = Pick<DeviceInfo, "osName" | "osVersion">;
type BrowserDetection = Pick<DeviceInfo, "browserName" | "browserVersion">;

function detectFirst<T>(
	userAgent: string,
	ua: string,
	detectors: readonly Detector<T>[],
	fallback: T,
): T {
	for (const detector of detectors) {
		if (detector.match(ua)) {
			return detector.detect(userAgent, ua);
		}
	}

	return fallback;
}

const osDetectors: readonly Detector<OsDetection>[] = [
	{
		match: (ua) => ua.includes("iphone") || ua.includes("ipad"),
		detect: (userAgent, ua) => {
			const match = userAgent.match(/OS (\d+[._]\d+(?:[._]\d+)?)/i);
			return {
				osName: ua.includes("ipad") ? "iPadOS" : "iOS",
				osVersion: match?.[1] ? match[1].replace(/_/g, ".") : null,
			};
		},
	},
	{
		match: (ua) => ua.includes("windows"),
		detect: (userAgent) => {
			const match = userAgent.match(/Windows NT (\d+\.?\d*)/i);
			const versionMap: Record<string, string> = {
				"10.0": "10/11",
				"6.3": "8.1",
				"6.2": "8",
				"6.1": "7",
				"6.0": "Vista",
				"5.1": "XP",
			};

			return {
				osName: "Windows",
				osVersion: match?.[1] ? (versionMap[match[1]] ?? match[1]) : null,
			};
		},
	},
	{
		match: (ua) => ua.includes("mac os x") || ua.includes("macos"),
		detect: (userAgent) => {
			const match = userAgent.match(/Mac OS X (\d+[._]\d+(?:[._]\d+)?)/i);
			return {
				osName: "macOS",
				osVersion: match?.[1] ? match[1].replace(/_/g, ".") : null,
			};
		},
	},
	{
		match: (ua) => ua.includes("android"),
		detect: (userAgent) => {
			const match = userAgent.match(/Android (\d+\.?\d*\.?\d*)/i);
			return {
				osName: "Android",
				osVersion: match?.[1] ?? null,
			};
		},
	},
	{
		match: (ua) => ua.includes("linux"),
		detect: () => ({
			osName: "Linux",
			osVersion: null,
		}),
	},
	{
		match: (ua) => ua.includes("cros"),
		detect: () => ({
			osName: "Chrome OS",
			osVersion: null,
		}),
	},
];

const browserDetectors: readonly Detector<BrowserDetection>[] = [
	{
		match: (ua) => ua.includes("edg/"),
		detect: (userAgent) => {
			const match = userAgent.match(/Edg\/(\d+\.?\d*\.?\d*)/i);
			return {
				browserName: "Edge",
				browserVersion: match?.[1] ?? null,
			};
		},
	},
	{
		match: (ua) => ua.includes("opr/") || ua.includes("opera"),
		detect: (userAgent) => {
			const match = userAgent.match(/(?:OPR|Opera)\/(\d+\.?\d*\.?\d*)/i);
			return {
				browserName: "Opera",
				browserVersion: match?.[1] ?? null,
			};
		},
	},
	{
		match: (ua) => ua.includes("brave"),
		detect: (userAgent) => {
			const match = userAgent.match(/Brave\/(\d+\.?\d*\.?\d*)/i);
			return {
				browserName: "Brave",
				browserVersion: match?.[1] ?? null,
			};
		},
	},
	{
		match: (ua) => ua.includes("vivaldi"),
		detect: (userAgent) => {
			const match = userAgent.match(/Vivaldi\/(\d+\.?\d*\.?\d*)/i);
			return {
				browserName: "Vivaldi",
				browserVersion: match?.[1] ?? null,
			};
		},
	},
	{
		match: (ua) => ua.includes("firefox") || ua.includes("fxios"),
		detect: (userAgent) => {
			const match = userAgent.match(/(?:Firefox|FxiOS)\/(\d+\.?\d*\.?\d*)/i);
			return {
				browserName: "Firefox",
				browserVersion: match?.[1] ?? null,
			};
		},
	},
	{
		match: (ua) =>
			ua.includes("safari") &&
			!ua.includes("chrome") &&
			!ua.includes("chromium"),
		detect: (userAgent) => {
			const match = userAgent.match(/Version\/(\d+\.?\d*\.?\d*)/i);
			return {
				browserName: "Safari",
				browserVersion: match?.[1] ?? null,
			};
		},
	},
	{
		match: (ua) => ua.includes("chrome") || ua.includes("crios"),
		detect: (userAgent) => {
			const match = userAgent.match(/(?:Chrome|CriOS)\/(\d+\.?\d*\.?\d*)/i);
			return {
				browserName: "Chrome",
				browserVersion: match?.[1] ?? null,
			};
		},
	},
];

function detectPlatform(
	ua: string,
	appPlatform?: string | null,
): DeviceInfo["platform"] {
	if (appPlatform === "desktop") return "desktop";
	if (appPlatform === "ios") return "ios";
	if (appPlatform === "android") return "android";
	if (appPlatform === "extension") return "extension";

	if (
		ua.includes("iphone") ||
		ua.includes("ipad") ||
		(ua.includes("ios") && ua.includes("mobile"))
	) {
		return "ios";
	}
	if (ua.includes("android")) {
		return "android";
	}

	return "web";
}

function buildDeviceName(
	platform: DeviceInfo["platform"],
	osName: string | null,
	osVersion: string | null,
	browserName: string | null,
): string {
	if (platform === "desktop") {
		return osName ? `Bittery Desktop on ${osName}` : "Bittery Desktop";
	}

	if (platform === "extension") {
		const browserLabel = browserName ?? "Browser";
		const osLabel = osName ? ` on ${osName}` : "";
		return `Bittery Extension (${browserLabel}${osLabel})`;
	}

	if (platform === "ios") {
		const osLabel = osName ?? "iOS";
		return osVersion
			? `Bittery on ${osLabel} ${osVersion}`
			: `Bittery on ${osLabel}`;
	}

	if (platform === "android") {
		const osLabel = osVersion ? `Android ${osVersion}` : "Android";
		return `Bittery on ${osLabel}`;
	}

	const parts: string[] = [];
	if (browserName) parts.push(browserName);
	if (osName) parts.push(`on ${osName}`);
	return parts.length > 0 ? parts.join(" ") : "Unknown Device";
}

export function parseUserAgent(
	userAgent: string,
	appPlatform?: string | null,
): DeviceInfo {
	const ua = userAgent.toLowerCase();
	const { osName, osVersion } = detectFirst<OsDetection>(
		userAgent,
		ua,
		osDetectors,
		{ osName: null, osVersion: null },
	);
	const { browserName, browserVersion } = detectFirst<BrowserDetection>(
		userAgent,
		ua,
		browserDetectors,
		{ browserName: null, browserVersion: null },
	);
	const platform = detectPlatform(ua, appPlatform);

	return {
		deviceName: buildDeviceName(platform, osName, osVersion, browserName),
		platform,
		browserName,
		browserVersion,
		osName,
		osVersion,
	};
}

export function getDesktopDeviceInfo(
	osName: string,
	osVersion?: string,
): DeviceInfo {
	return {
		deviceName: `Bittery Desktop on ${osName}`,
		platform: "desktop",
		browserName: null,
		browserVersion: null,
		osName,
		osVersion: osVersion ?? null,
	};
}

export function getExtensionDeviceInfo(
	browserName: string,
	browserVersion?: string,
): DeviceInfo {
	return {
		deviceName: `Bittery Extension (${browserName})`,
		platform: "extension",
		browserName,
		browserVersion: browserVersion ?? null,
		osName: null,
		osVersion: null,
	};
}

export function formatDeviceDisplay(device: {
	deviceName?: string | null;
	browserName?: string | null;
	browserVersion?: string | null;
	osName?: string | null;
	osVersion?: string | null;
	platform?: string | null;
}): { title: string; subtitle: string } {
	const title = device.deviceName ?? "Unknown Device";

	const parts: string[] = [];
	if (device.osName) {
		parts.push(
			device.osVersion ? `${device.osName} ${device.osVersion}` : device.osName,
		);
	}
	if (device.browserName && device.browserVersion) {
		parts.push(`${device.browserName} ${device.browserVersion}`);
	}

	const subtitle =
		parts.length > 0 ? parts.join(" - ") : (device.platform ?? "Unknown");

	return { title, subtitle };
}

export function formatLastActive(date: Date | string): string {
	const now = new Date();
	const lastActive = typeof date === "string" ? new Date(date) : date;
	const diffMs = now.getTime() - lastActive.getTime();
	const diffMins = Math.floor(diffMs / 60000);
	const diffHours = Math.floor(diffMs / 3600000);
	const diffDays = Math.floor(diffMs / 86400000);

	if (diffMins < 1) return "Just now";
	if (diffMins < 60) {
		return `${diffMins} minute${diffMins !== 1 ? "s" : ""} ago`;
	}
	if (diffHours < 24) {
		return `${diffHours} hour${diffHours !== 1 ? "s" : ""} ago`;
	}
	if (diffDays < 7) {
		return `${diffDays} day${diffDays !== 1 ? "s" : ""} ago`;
	}

	return lastActive.toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
		year:
			lastActive.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
	});
}
