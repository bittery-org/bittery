/**
 * Turning Android's document picker into the `FileInput` shape `@bittery/core`'s attachment
 * hooks expect — the WebView equivalent of `apps/mobile`'s `expo-document-picker` +
 * `expo-file-system` pair in `src/components/item-details/item-attachments.tsx`.
 *
 * An `<input type="file">` would be the obvious answer and is the wrong one here: Tauri's
 * Android WebView has no file-chooser callback wired up, so tapping one does nothing at all.
 * `tauri-plugin-dialog`'s `open()` goes through the Storage Access Framework instead, and
 * `tauri-plugin-fs`'s `readFile` reads back the SAF URI it returns. That pair was proven on a
 * device by the migration's `/debug` self-test (since deleted) rather than trusted from the
 * support table, because `dialog` and `fs` are both only partially implemented on mobile.
 */

import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";

/**
 * Structurally `@bittery/core`'s `FileInput`, restated rather than imported so this module
 * stays a platform primitive with no dependency on the attachment feature.
 */
export interface PickedFile {
	name: string;
	type: string;
	size: number;
	arrayBuffer(): Promise<ArrayBuffer>;
}

/**
 * SAF hands back a URI and no MIME type, but `createVault` rejects anything whose content
 * type is not `image/*`, so a picked vault image has to be typed from its extension. Only the
 * formats the picker is filtered to are listed; everything else stays `application/octet-stream`
 * and is refused upstream rather than mislabelled here.
 */
const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	webp: "image/webp",
	gif: "image/gif",
	avif: "image/avif",
};

export const IMAGE_EXTENSIONS = Object.keys(IMAGE_MIME_BY_EXTENSION);

/** Everything after the last `/` or `\`, or the whole string when a SAF URI has neither. */
function basename(path: string): string {
	const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	const name = separator >= 0 ? path.slice(separator + 1) : path;
	// SAF content URIs frequently end in `…%2Fmy%20file.pdf`; without this the attachment
	// would be named with the percent-escapes still in it.
	try {
		return decodeURIComponent(name) || name;
	} catch {
		return name;
	}
}

/**
 * Opens the system document picker and reads the chosen file into memory.
 *
 * Returns `null` when the user cancels — that is an outcome, not an error, and the caller
 * should stay silent about it. Anything else (a picker that will not open, an unreadable URI)
 * throws so the caller can say why.
 *
 * The whole file is read eagerly. That is what the upload path needs anyway (it base64s the
 * bytes to encrypt them), and the plan's attachment size cap keeps it bounded.
 */
export async function pickFile(
	options: { extensions?: readonly string[] } = {},
): Promise<PickedFile | null> {
	// `multiple: false, directory: false` narrows the plugin's overloads to `string | null`.
	const path = await open({
		multiple: false,
		directory: false,
		filters: options.extensions
			? [{ name: "files", extensions: [...options.extensions] }]
			: undefined,
	});
	if (path === null) return null;

	const bytes = await readFile(path);
	const name = basename(path);
	const extension = name.split(".").pop()?.toLowerCase() ?? "";

	return {
		name,
		// SAF gives no MIME type back through this API. For an attachment that costs nothing
		// (the encoder falls back to the same value anyway); for a vault image it does, so the
		// extension is the only signal available.
		type: IMAGE_MIME_BY_EXTENSION[extension] ?? "application/octet-stream",
		size: bytes.byteLength,
		arrayBuffer: async () => {
			// `bytes.buffer` may be a pooled ArrayBuffer with a non-zero offset; slicing by the
			// view's own bounds is what makes this correct rather than usually correct.
			const { buffer, byteOffset, byteLength } = bytes;
			return buffer.slice(byteOffset, byteOffset + byteLength) as ArrayBuffer;
		},
	};
}
