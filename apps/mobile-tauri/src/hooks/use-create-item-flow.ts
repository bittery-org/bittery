import type { VaultKeyWithAccount } from "@bittery/core/hooks";
import { useCreateItem } from "@bittery/core/hooks";
import type { DecryptedItemData, ItemCategory } from "@bittery/shared/types";
import { toast, type VaultOption } from "@bittery/ui";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import {
	InvalidTotpSecretError,
	NotAnOtpAuthUriError,
	scanTotpSetupToClipboard,
} from "@/lib/barcode-scanner";
import { useI18n } from "@/providers/i18n-provider";

/**
 * Shared "+" create-item flow for every screen that offers it (Vaults tab, a single vault's item
 * list, All Items tab). Resolves the owning account from `vaultKeys` the same way desktop's
 * `/vault` route does (`apps/desktop/src/routes/vault/route.tsx`), then navigates to the new
 * item's detail screen in its vault on success.
 *
 * `scanTotpQr` is the second entry point these same screens offer, next to "+": scan a TOTP
 * `otpauth://` QR (`apps/mobile`'s equivalent lived inside its `TotpForm`, see
 * `src/lib/barcode-scanner.ts` for why it lands on the clipboard instead of a form field here),
 * then open this same sheet so the shared `TotpForm`'s existing clipboard auto-paste picks it up
 * once the user taps "Authenticator".
 */
export function useCreateItemFlow(vaultKeys: VaultKeyWithAccount[]) {
	const { m } = useI18n();
	const navigate = useNavigate();
	const [isOpen, setIsOpen] = useState(false);
	const createItem = useCreateItem();

	const vaultOptions: VaultOption[] = vaultKeys.map((v) => ({
		id: v.vaultId,
		name: v.vaultName,
		type: v.vaultType,
		icon: v.vaultIcon,
		imageUrl: v.vaultImageUrl,
	}));

	const handleCreateItem = async (
		data: DecryptedItemData,
		vaultId: string,
		category: ItemCategory,
	) => {
		const vault = vaultKeys.find((v) => v.vaultId === vaultId);
		const accountId = vault?.accountId;
		if (!accountId) {
			toast.error(m.mob_create_item_toast_vault_required());
			return;
		}

		try {
			const result = await createItem.mutateAsync({
				vaultId,
				category,
				data,
				accountId,
			});
			setIsOpen(false);
			toast.success(m.mob_create_item_toast_success());
			navigate({
				to: "/vault/$id/$itemId",
				params: { id: vaultId, itemId: result.itemId },
			});
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: m.mob_create_item_toast_failed(),
			);
			throw error;
		}
	};

	/**
	 * Scans a TOTP QR, validates it, writes it to the clipboard, and opens the create-item
	 * sheet. There is no prop to jump straight to the Authenticator step (`CreateItemSheet`
	 * has none to give — see the module doc), so this gets the user as close as the sheet
	 * allows: one tap on "Authenticator" away from a filled-in form.
	 */
	const scanTotpQr = async () => {
		try {
			await scanTotpSetupToClipboard();
			toast.success(m.mob_form_totp_toast_imported());
			setIsOpen(true);
		} catch (error) {
			if (error instanceof NotAnOtpAuthUriError) {
				toast.error(m.mob_qr_scanner_invalid_qr_message());
				return;
			}
			if (error instanceof InvalidTotpSecretError) {
				toast.error(m.mob_qr_scanner_invalid_secret_message());
				return;
			}
			// Includes a user-cancelled or permission-denied scan — `scan()` rejects for
			// both, and `apps/mobile`'s scanner treated a cancel as "say nothing", so this
			// does too rather than showing an error for a deliberate cancel.
			console.warn("[scanTotpQr] scan did not complete", error);
		}
	};

	return {
		isOpen,
		setIsOpen,
		vaultOptions,
		handleCreateItem,
		scanTotpQr,
		isPending: createItem.isPending,
	};
}
