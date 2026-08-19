import { copyToClipboard as sharedCopyToClipboard } from "@bittery/shared/password";
import { toast } from "./sonner";

export const copyToClipboard = sharedCopyToClipboard;

export interface CopyWithToastOptions {
	/** Auto-clear clipboard after this many milliseconds. Default: 30000 (30s). Set to 0 to disable. */
	autoClearMs?: number;
	/** Show auto-clear time in success message. Default: true */
	showAutoClearMessage?: boolean;
	/** Custom success message. If provided, overrides default "{label} copied to clipboard" */
	successMessage?: string;
	/** Custom error message when text is empty. If provided, overrides default "No {label} to copy" */
	emptyErrorMessage?: string;
	/** Custom error message when copying fails. If provided, overrides default "Failed to copy to clipboard" */
	copyErrorMessage?: string;
}

/**
 * Copy text to clipboard with toast notification
 * Handles null/undefined values with error toast
 */
export async function copyWithToast(
	text: string | null | undefined,
	label: string,
	options: CopyWithToastOptions = {},
): Promise<boolean> {
	const {
		autoClearMs = 30000,
		showAutoClearMessage = true,
		successMessage,
		emptyErrorMessage,
		copyErrorMessage,
	} = options;

	if (!text) {
		toast.error(emptyErrorMessage ?? `No ${label.toLowerCase()} to copy`);
		return false;
	}

	try {
		await sharedCopyToClipboard(text, autoClearMs);

		const message =
			successMessage ??
			(showAutoClearMessage && autoClearMs > 0
				? `${label} copied to clipboard (auto-clear in ${Math.round(autoClearMs / 1000)}s)`
				: `${label} copied to clipboard`);

		toast.success(message);
		return true;
	} catch {
		toast.error(copyErrorMessage ?? "Failed to copy to clipboard");
		return false;
	}
}
