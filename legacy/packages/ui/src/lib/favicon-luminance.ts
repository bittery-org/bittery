// Detects whether a favicon image is predominantly "dark" so callers can
// swap in a light backdrop behind it in dark mode (otherwise dark marks like
// GitHub's octocat become nearly invisible on a near-black tile).
//
// Analysis results are cached per URL for the session, and in-flight
// analyses are de-duplicated so a given favicon URL is only ever decoded and
// sampled once.

type LuminanceResult = "dark" | "light" | "unknown";

const CANVAS_SIZE = 16;
const MIN_OPAQUE_COVERAGE = 0.15;
const DARK_LUMINANCE_THRESHOLD = 90;
const MIN_ALPHA = 25;

const luminanceCache = new Map<string, LuminanceResult>();
const inFlight = new Map<string, Promise<LuminanceResult>>();

/**
 * Synchronously reads a previously computed (cached) luminance result for a
 * favicon URL, without triggering any analysis. Returns "unknown" if the
 * URL hasn't been analyzed yet (or analysis is still in flight).
 */
function readCachedLuminance(url: string | null | undefined): LuminanceResult {
	if (!url) return "unknown";
	return luminanceCache.get(url) ?? "unknown";
}

function computeLuminanceFromCanvas(image: HTMLImageElement): LuminanceResult {
	const canvas = document.createElement("canvas");
	canvas.width = CANVAS_SIZE;
	canvas.height = CANVAS_SIZE;

	const ctx = canvas.getContext("2d");
	if (!ctx) return "unknown";

	ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
	ctx.drawImage(image, 0, 0, CANVAS_SIZE, CANVAS_SIZE);

	try {
		const { data } = ctx.getImageData(0, 0, CANVAS_SIZE, CANVAS_SIZE);

		let luminanceSum = 0;
		let opaquePixels = 0;
		const totalPixels = CANVAS_SIZE * CANVAS_SIZE;

		for (let i = 0; i < data.length; i += 4) {
			const alpha = data[i + 3] ?? 0;
			if (alpha <= MIN_ALPHA) continue;

			const r = data[i] ?? 0;
			const g = data[i + 1] ?? 0;
			const b = data[i + 2] ?? 0;

			luminanceSum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
			opaquePixels += 1;
		}

		if (opaquePixels === 0) return "unknown";

		const coverage = opaquePixels / totalPixels;
		const averageLuminance = luminanceSum / opaquePixels;

		if (
			averageLuminance < DARK_LUMINANCE_THRESHOLD &&
			coverage >= MIN_OPAQUE_COVERAGE
		) {
			return "dark";
		}

		return "light";
	} catch {
		// Tainted canvas (no CORS headers on the favicon response) or any
		// other read failure — we simply can't inspect the pixels.
		return "unknown";
	}
}

// The displayed favicon <img> loads without CORS, so browsers may cache its
// response (which can lack CORS headers) and replay it for our crossOrigin
// analysis request, tainting the canvas even when the server is configured
// correctly. Fetching the analysis copy under its own query param gives it a
// separate cache entry that is always requested in CORS mode.
function toAnalysisUrl(url: string): string {
	return url.includes("?") ? `${url}&canvas=1` : `${url}?canvas=1`;
}

function loadAndAnalyze(url: string): Promise<LuminanceResult> {
	return new Promise((resolve) => {
		const image = new Image();
		image.crossOrigin = "anonymous";

		image.onload = () => {
			resolve(computeLuminanceFromCanvas(image));
		};
		image.onerror = () => {
			resolve("unknown");
		};

		image.src = toAnalysisUrl(url);
	});
}

/**
 * Analyzes a favicon URL's average luminance, caching the result for the
 * session. Safe to call repeatedly for the same URL — concurrent calls
 * share a single in-flight analysis.
 */
function analyzeFaviconLuminance(
	url: string | null | undefined,
): Promise<LuminanceResult> {
	if (!url) return Promise.resolve("unknown");
	if (typeof document === "undefined") return Promise.resolve("unknown");

	const cached = luminanceCache.get(url);
	if (cached) return Promise.resolve(cached);

	const pending = inFlight.get(url);
	if (pending) return pending;

	const promise = loadAndAnalyze(url).then((result) => {
		luminanceCache.set(url, result);
		inFlight.delete(url);
		return result;
	});

	inFlight.set(url, promise);
	return promise;
}

/**
 * Convenience wrapper: returns the cached result synchronously if already
 * known, otherwise kicks off (or reuses) an async analysis and returns a
 * promise.
 */
function getFaviconLuminance(
	url: string | null | undefined,
): LuminanceResult | Promise<LuminanceResult> {
	if (!url) return "unknown";

	const cached = luminanceCache.get(url);
	if (cached) return cached;

	return analyzeFaviconLuminance(url);
}

export type { LuminanceResult };
export { analyzeFaviconLuminance, getFaviconLuminance, readCachedLuminance };

// Deterministic per-item gradient stops (mid -> deep), 135deg. Mirrors the
// palette used elsewhere for avatar-style gradients so login tiles without a
// favicon get a consistent, recognizable hue per domain/title.
const FAVICON_GRADIENT_STOPS: Array<[string, string]> = [
	["#ef4444", "#b91c1c"], // red
	["#f97316", "#c2410c"], // orange
	["#f59e0b", "#b45309"], // amber
	["#eab308", "#a16207"], // yellow
	["#84cc16", "#4d7c0f"], // lime
	["#22c55e", "#15803d"], // green
	["#10b981", "#047857"], // emerald
	["#14b8a6", "#0f766e"], // teal
	["#06b6d4", "#0e7490"], // cyan
	["#0ea5e9", "#0369a1"], // sky
	["#3b82f6", "#1d4ed8"], // blue
	["#6366f1", "#4338ca"], // indigo
	["#8b5cf6", "#6d28d9"], // violet
	["#a855f7", "#7e22ce"], // purple
	["#d946ef", "#a21caf"], // fuchsia
	["#ec4899", "#be185d"], // pink
	["#f43f5e", "#be123c"], // rose
];

function getFaviconGradient(name: string): [string, string] {
	let hash = 0;
	for (let i = 0; i < name.length; i++) {
		hash = name.charCodeAt(i) + ((hash << 5) - hash);
	}

	return (
		FAVICON_GRADIENT_STOPS[Math.abs(hash) % FAVICON_GRADIENT_STOPS.length] ?? [
			"#6b7280",
			"#374151",
		]
	);
}

export { FAVICON_GRADIENT_STOPS, getFaviconGradient };
