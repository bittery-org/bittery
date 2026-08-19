/**
 * SSE wire-format parsing, split out of `sync-manager` so the frame handlers —
 * above all `session_revoked` — are drivable without a live stream.
 *
 * Pure: no chrome globals, no I/O, no module state.
 */

export interface SseFrame {
	/** The `event:` field. Empty when the server sent a bare `data:` frame. */
	event: string;
	/** The `data:` field, JSON-parsed. Always a non-null object. */
	data: unknown;
}

/**
 * Parse one `\n\n`-delimited SSE frame. Returns `null` for anything that
 * carries no usable payload: heartbeat comments, empty data, malformed JSON,
 * or a JSON scalar.
 */
export function parseSseFrame(raw: string): SseFrame | null {
	const lines = raw.trim().split("\n");
	let data = "";
	let event = "";

	for (const line of lines) {
		if (line.startsWith(":")) {
			continue; // Heartbeats/comments.
		}
		if (line.startsWith("event: ")) {
			event = line.slice(7);
		} else if (line.startsWith("data: ")) {
			data = line.slice(6);
		} else if (line.startsWith("data:")) {
			data = line.slice(5).trimStart();
		}
	}

	if (!data) {
		return null;
	}

	try {
		const parsed = JSON.parse(data) as unknown;
		if (!parsed || typeof parsed !== "object") {
			return null;
		}
		return { event, data: parsed };
	} catch (error) {
		console.error("[sse-frame] Failed to parse SSE event:", error, data);
		return null;
	}
}
