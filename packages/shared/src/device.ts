/**
 * Device detection utilities
 * Parses user agent strings to extract browser and OS information
 */

export interface DeviceInfo {
	deviceName: string;
	platform: "web" | "desktop" | "extension" | "ios" | "android";
	browserName: string | null;
	browserVersion: string | null;
	osName: string | null;
	osVersion: string | null;
}

/**
 * Parse User-Agent string to extract device information
 */
export function parseUserAgent(
	userAgent: string,
	appPlatform?: string | null,
): DeviceInfo {
	const ua = userAgent.toLowerCase();

	// Detect OS
	let osName: string | null = null;
	let osVersion: string | null = null;

	if (ua.includes("windows")) {
		osName = "Windows";
		const match = userAgent.match(/Windows NT (\d+\.?\d*)/i);
		if (match?.[1]) {
			const ntVersion = match[1];
			// Map NT versions to Windows versions
			const versionMap: Record<string, string> = {
				"10.0": "10/11",
				"6.3": "8.1",
				"6.2": "8",
				"6.1": "7",
				"6.0": "Vista",
				"5.1": "XP",
			};
			osVersion = versionMap[ntVersion] ?? ntVersion;
		}
	} else if (ua.includes("mac os x") || ua.includes("macos")) {
		osName = "macOS";
		const match = userAgent.match(/Mac OS X (\d+[._]\d+(?:[._]\d+)?)/i);
		if (match?.[1]) {
			osVersion = match[1].replace(/_/g, ".");
		}
	} else if (ua.includes("iphone") || ua.includes("ipad")) {
		osName = ua.includes("ipad") ? "iPadOS" : "iOS";
		const match = userAgent.match(/OS (\d+[._]\d+(?:[._]\d+)?)/i);
		if (match?.[1]) {
			osVersion = match[1].replace(/_/g, ".");
		}
	} else if (ua.includes("android")) {
		osName = "Android";
		const match = userAgent.match(/Android (\d+\.?\d*\.?\d*)/i);
		if (match?.[1]) {
			osVersion = match[1];
		}
	} else if (ua.includes("linux")) {
		osName = "Linux";
	} else if (ua.includes("cros")) {
		osName = "Chrome OS";
	}

	// Detect Browser
	let browserName: string | null = null;
	let browserVersion: string | null = null;

	// Check for specific browsers (order matters - more specific first)
	if (ua.includes("edg/")) {
		browserName = "Edge";
		const match = userAgent.match(/Edg\/(\d+\.?\d*\.?\d*)/i);
		if (match?.[1]) browserVersion = match[1];
	} else if (ua.includes("opr/") || ua.includes("opera")) {
		browserName = "Opera";
		const match = userAgent.match(/(?:OPR|Opera)\/(\d+\.?\d*\.?\d*)/i);
		if (match?.[1]) browserVersion = match[1];
	} else if (ua.includes("brave")) {
		browserName = "Brave";
		const match = userAgent.match(/Brave\/(\d+\.?\d*\.?\d*)/i);
		if (match?.[1]) browserVersion = match[1];
	} else if (ua.includes("vivaldi")) {
		browserName = "Vivaldi";
		const match = userAgent.match(/Vivaldi\/(\d+\.?\d*\.?\d*)/i);
		if (match?.[1]) browserVersion = match[1];
	} else if (ua.includes("firefox") || ua.includes("fxios")) {
		browserName = "Firefox";
		const match = userAgent.match(/(?:Firefox|FxiOS)\/(\d+\.?\d*\.?\d*)/i);
		if (match?.[1]) browserVersion = match[1];
	} else if (
		ua.includes("safari") &&
		!ua.includes("chrome") &&
		!ua.includes("chromium")
	) {
		browserName = "Safari";
		const match = userAgent.match(/Version\/(\d+\.?\d*\.?\d*)/i);
		if (match?.[1]) browserVersion = match[1];
	} else if (ua.includes("chrome") || ua.includes("crios")) {
		browserName = "Chrome";
		const match = userAgent.match(/(?:Chrome|CriOS)\/(\d+\.?\d*\.?\d*)/i);
		if (match?.[1]) browserVersion = match[1];
	}

	// Determine platform — prefer explicit X-App-Platform header over UA sniffing
	let platform: DeviceInfo["platform"] = "web";
	if (appPlatform === "desktop") {
		platform = "desktop";
	} else if (appPlatform === "ios") {
		platform = "ios";
	} else if (appPlatform === "android") {
		platform = "android";
	} else if (appPlatform === "extension") {
		platform = "extension";
	} else if (
		ua.includes("iphone") ||
		ua.includes("ipad") ||
		(ua.includes("ios") && ua.includes("mobile"))
	) {
		platform = "ios";
	} else if (ua.includes("android")) {
		platform = "android";
	}

	// Generate device name based on platform
	let deviceName: string;
	if (platform === "desktop") {
		deviceName = osName ? `Bittery Desktop on ${osName}` : "Bittery Desktop";
	} else if (platform === "extension") {
		const browserLabel = browserName ?? "Browser";
		const osLabel = osName ? ` on ${osName}` : "";
		deviceName = `Bittery Extension (${browserLabel}${osLabel})`;
	} else if (platform === "ios") {
		const osLabel = osName ?? "iOS";
		deviceName = osVersion
			? `Bittery on ${osLabel} ${osVersion}`
			: `Bittery on ${osLabel}`;
	} else if (platform === "android") {
		const osLabel = osVersion ? `Android ${osVersion}` : "Android";
		deviceName = `Bittery on ${osLabel}`;
	} else {
		const parts: string[] = [];
		if (browserName) parts.push(browserName);
		if (osName) parts.push(`on ${osName}`);
		deviceName = parts.length > 0 ? parts.join(" ") : "Unknown Device";
	}

	return {
		deviceName,
		platform,
		browserName,
		browserVersion,
		osName,
		osVersion,
	};
}

/**
 * Get device information for desktop apps (Tauri)
 */
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

/**
 * Get device information for browser extensions
 */
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

/**
 * Format device info for display
 */
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

/**
 * Get relative time string for last active display
 */
export function formatLastActive(date: Date | string): string {
	const now = new Date();
	const lastActive = typeof date === "string" ? new Date(date) : date;
	const diffMs = now.getTime() - lastActive.getTime();
	const diffMins = Math.floor(diffMs / 60000);
	const diffHours = Math.floor(diffMs / 3600000);
	const diffDays = Math.floor(diffMs / 86400000);

	if (diffMins < 1) return "Just now";
	if (diffMins < 60)
		return `${diffMins} minute${diffMins !== 1 ? "s" : ""} ago`;
	if (diffHours < 24)
		return `${diffHours} hour${diffHours !== 1 ? "s" : ""} ago`;
	if (diffDays < 7) return `${diffDays} day${diffDays !== 1 ? "s" : ""} ago`;

	return lastActive.toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
		year:
			lastActive.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
	});
}
