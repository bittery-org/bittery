export const GITHUB_REPO = "bittery-org/bittery";

export const RELEASES_PAGE_URL = `https://github.com/${GITHUB_REPO}/releases`;

export const RELEASE_ASSETS = {
	macos: "Bittery.dmg",
	windowsSetup: "Bittery-setup.exe",
	windowsPortable: "Bittery.exe",
	linuxAppImage: "Bittery.AppImage",
	linuxDeb: "Bittery.deb",
	extension: "bittery-extension.zip",
} as const;

export type DesktopPlatform = "macos" | "windows" | "linux" | "unknown";

export function latestDownloadUrl(filename: string): string {
	return `${RELEASES_PAGE_URL}/latest/download/${encodeURIComponent(filename)}`;
}

export const DESKTOP_DOWNLOADS = {
	macos: {
		filename: RELEASE_ASSETS.macos,
		url: latestDownloadUrl(RELEASE_ASSETS.macos),
	},
	windows: {
		filename: RELEASE_ASSETS.windowsSetup,
		url: latestDownloadUrl(RELEASE_ASSETS.windowsSetup),
	},
	windowsPortable: {
		filename: RELEASE_ASSETS.windowsPortable,
		url: latestDownloadUrl(RELEASE_ASSETS.windowsPortable),
	},
	linuxAppImage: {
		filename: RELEASE_ASSETS.linuxAppImage,
		url: latestDownloadUrl(RELEASE_ASSETS.linuxAppImage),
	},
	linuxDeb: {
		filename: RELEASE_ASSETS.linuxDeb,
		url: latestDownloadUrl(RELEASE_ASSETS.linuxDeb),
	},
	extension: {
		filename: RELEASE_ASSETS.extension,
		url: latestDownloadUrl(RELEASE_ASSETS.extension),
	},
} as const;

export function detectOS(): DesktopPlatform {
	if (typeof navigator === "undefined") return "unknown";
	const ua = navigator.userAgent.toLowerCase();
	if (ua.includes("mac")) return "macos";
	if (ua.includes("win")) return "windows";
	if (ua.includes("linux")) return "linux";
	return "unknown";
}

export function getPrimaryDownloadForOS(os: DesktopPlatform): {
	filename: string;
	url: string;
} | null {
	switch (os) {
		case "macos":
			return DESKTOP_DOWNLOADS.macos;
		case "windows":
			return DESKTOP_DOWNLOADS.windows;
		case "linux":
			return DESKTOP_DOWNLOADS.linuxAppImage;
		default:
			return null;
	}
}

interface GitHubReleaseResponse {
	tag_name: string;
	assets: Array<{ name: string; browser_download_url: string }>;
}

let latestReleaseCache: {
	tagName: string;
	fetchedAt: number;
} | null = null;

const LATEST_RELEASE_CACHE_TTL_MS = 10 * 60 * 1000;

export async function resolveLatestRelease(): Promise<{
	tagName: string;
} | null> {
	if (
		latestReleaseCache &&
		Date.now() - latestReleaseCache.fetchedAt < LATEST_RELEASE_CACHE_TTL_MS
	) {
		return { tagName: latestReleaseCache.tagName };
	}

	try {
		const response = await fetch(
			`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
			{
				headers: {
					Accept: "application/vnd.github+json",
					"User-Agent": "bittery-marketing",
				},
			},
		);

		if (!response.ok) {
			return latestReleaseCache
				? { tagName: latestReleaseCache.tagName }
				: null;
		}

		const data = (await response.json()) as GitHubReleaseResponse;
		latestReleaseCache = {
			tagName: data.tag_name,
			fetchedAt: Date.now(),
		};
		return { tagName: data.tag_name };
	} catch {
		return latestReleaseCache ? { tagName: latestReleaseCache.tagName } : null;
	}
}
