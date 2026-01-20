/**
 * Device detection utilities for API layer
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
export function parseUserAgent(userAgent: string): DeviceInfo {
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
  } else if (ua.includes("safari") && !ua.includes("chrome") && !ua.includes("chromium")) {
    browserName = "Safari";
    const match = userAgent.match(/Version\/(\d+\.?\d*\.?\d*)/i);
    if (match?.[1]) browserVersion = match[1];
  } else if (ua.includes("chrome") || ua.includes("crios")) {
    browserName = "Chrome";
    const match = userAgent.match(/(?:Chrome|CriOS)\/(\d+\.?\d*\.?\d*)/i);
    if (match?.[1]) browserVersion = match[1];
  }

  // Determine platform
  let platform: DeviceInfo["platform"] = "web";
  if (ua.includes("iphone") || ua.includes("ipad") || (ua.includes("ios") && ua.includes("mobile"))) {
    platform = "ios";
  } else if (ua.includes("android")) {
    platform = "android";
  }

  // Generate device name
  const parts: string[] = [];
  if (browserName) parts.push(browserName);
  if (osName) parts.push(`on ${osName}`);
  const deviceName = parts.length > 0 ? parts.join(" ") : "Unknown Device";

  return {
    deviceName,
    platform,
    browserName,
    browserVersion,
    osName,
    osVersion,
  };
}
