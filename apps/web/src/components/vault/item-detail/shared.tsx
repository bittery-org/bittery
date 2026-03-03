import type {
	CreditCardDisplayData,
	CustomField,
	IdentityDisplayData,
	ItemCategory,
	LoginDisplayData,
	SecureNoteDisplayData,
	TotpDisplayData,
} from "@bittery/shared/types";
import { copyWithToast, type CopyWithToastOptions } from "@bittery/ui";
import { useI18n } from "@/providers/i18n-provider";

export type {
	CreditCardDisplayData,
	CustomField,
	IdentityDisplayData,
	LoginDisplayData,
	SecureNoteDisplayData,
	TotpDisplayData,
};

export type ItemDetailData =
	| LoginDisplayData
	| SecureNoteDisplayData
	| CreditCardDisplayData
	| IdentityDisplayData
	| TotpDisplayData;

export interface ItemDetailProps {
	category: ItemCategory;
	data: ItemDetailData;
	onEdit?: () => void;
	onDelete?: () => void;
	vaultId?: string;
	availableTags?: string[];
	canEdit?: boolean;
}

export interface CategoryDetailProps<T> {
	data: T;
	onEdit?: () => void;
	onDelete?: () => void;
}

export function handleCopy(
	text: string | null | undefined,
	label: string,
	m: ReturnType<typeof useI18n>["m"],
	options: Pick<CopyWithToastOptions, "autoClearMs" | "showAutoClearMessage"> = {},
) {
	const autoClearMs = options.autoClearMs ?? 30000;
	const showAutoClearMessage = options.showAutoClearMessage ?? true;

	return copyWithToast(text, label, {
		autoClearMs,
		showAutoClearMessage,
		successMessage:
			showAutoClearMessage && autoClearMs > 0
				? m["vaults.detail.items.copy.toast.success_auto_clear"]({
						label,
						seconds: Math.round(autoClearMs / 1000),
					})
				: m["vaults.detail.items.copy.toast.success"]({ label }),
		emptyErrorMessage: m["vaults.detail.items.copy.toast.empty"]({ label }),
		copyErrorMessage: m["vaults.detail.items.copy.toast.failed"](),
	});
}
