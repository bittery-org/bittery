import { copyToClipboard } from "@bittery/shared/crypto";
import type {
	CreditCardDisplayData,
	CustomField,
	IdentityDisplayData,
	ItemCategory,
	LoginDisplayData,
	SecureNoteDisplayData,
	TotpDisplayData,
} from "@bittery/shared/types";
import { toast } from "@bittery/ui";

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
}

export interface CategoryDetailProps<T> {
	data: T;
	onEdit?: () => void;
	onDelete?: () => void;
}

export async function handleCopy(text: string, label: string) {
	await copyToClipboard(text, 30000);
	toast.success(`${label} copied to clipboard (auto-clear in 30s)`);
}
