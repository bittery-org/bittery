import type {
	CreditCardDisplayData,
	CustomField,
	IdentityDisplayData,
	ItemCategory,
	LoginDisplayData,
	SecureNoteDisplayData,
	TotpDisplayData,
} from "@bittery/shared/types";
import type { CompiledMessages } from "@bittery/i18n";
import { type CopyWithToastOptions, copyWithToast } from "../../clipboard";

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
	icon?: React.ReactNode;
	onEdit?: () => void;
	onDelete?: () => void;
	onRemovePasskey?: (credentialId: string) => Promise<void> | void;
	onTagsChange?: (tags: string[]) => void;
	onTagClick?: (tagName: string) => void;
	availableTags?: string[];
	isUpdatingTags?: boolean;
	onOpenUrl?: (url: string) => void;
}

export interface CategoryDetailProps<T> {
	data: T;
	icon?: React.ReactNode;
	onEdit?: () => void;
	onDelete?: () => void;
	onRemovePasskey?: (credentialId: string) => Promise<void> | void;
	onTagsChange?: (tags: string[]) => void;
	onTagClick?: (tagName: string) => void;
	availableTags?: string[];
	isUpdatingTags?: boolean;
	onOpenUrl?: (url: string) => void;
}

export function handleCopy(
	text: string | null | undefined,
	label: string,
	m: CompiledMessages,
	options: Pick<
		CopyWithToastOptions,
		"autoClearMs" | "showAutoClearMessage"
	> = {},
) {
	const autoClearMs = options.autoClearMs ?? 30000;
	const showAutoClearMessage = options.showAutoClearMessage ?? true;

	return copyWithToast(text, label, {
		autoClearMs,
		showAutoClearMessage,
		successMessage:
			showAutoClearMessage && autoClearMs > 0
				? m.vaults_detail_items_copy_toast_success_auto_clear({ label })
				: m.vaults_detail_items_copy_toast_success({ label }),
		emptyErrorMessage: m.vaults_detail_items_copy_toast_empty({ label }),
		copyErrorMessage: m.vaults_detail_items_copy_toast_failed(),
	});
}
