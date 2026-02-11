import type {
	CreditCardDisplayData,
	CustomField,
	IdentityDisplayData,
	ItemCategory,
	LoginDisplayData,
	SecureNoteDisplayData,
	TotpDisplayData,
} from "@bittery/shared/types";
import { copyWithToast } from "@bittery/ui";

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
	onRemovePasskey?: (credentialId: string) => Promise<void> | void;
	onTagsChange?: (tags: string[]) => void;
	onTagClick?: (tagName: string) => void;
	availableTags?: string[];
	isUpdatingTags?: boolean;
}

export interface CategoryDetailProps<T> {
	data: T;
	onEdit?: () => void;
	onDelete?: () => void;
	onRemovePasskey?: (credentialId: string) => Promise<void> | void;
	onTagsChange?: (tags: string[]) => void;
	onTagClick?: (tagName: string) => void;
	availableTags?: string[];
	isUpdatingTags?: boolean;
}

export { copyWithToast as handleCopy };
