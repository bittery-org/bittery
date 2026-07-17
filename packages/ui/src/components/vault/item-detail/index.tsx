import type {
	CreditCardDisplayData,
	IdentityDisplayData,
	LoginDisplayData,
	SecureNoteDisplayData,
	TotpDisplayData,
} from "@bittery/shared/types";
import { CreditCardDetail } from "./credit-card-detail";
import {
	DetailCustomField,
	DetailField,
	DetailFieldActionButton,
	DetailFieldGroup,
	DetailGroupLabel,
	DetailHeader,
	DetailNoteField,
	DetailPasswordField,
	DetailRow,
	DetailSection,
	DetailUrlField,
} from "./field-components";
import { IdentityDetail } from "./identity-detail";
import { LoginDetail } from "./login-detail";
import { SecureNoteDetail } from "./secure-note-detail";
import type { ItemDetailProps } from "./shared";
import { TotpDetail } from "./totp-detail";

export type {
	CreditCardDisplayData,
	IdentityDisplayData,
	LoginDisplayData,
	SecureNoteDisplayData,
	TotpDisplayData,
};
export {
	DetailCustomField,
	DetailField,
	DetailFieldActionButton,
	DetailFieldGroup,
	DetailGroupLabel,
	DetailHeader,
	DetailNoteField,
	DetailPasswordField,
	DetailRow,
	DetailSection,
	DetailUrlField,
};
export { handleCopy } from "./shared";
export type { CustomField, ItemDetailData, ItemDetailProps } from "./shared";

export default function ItemDetail({
	category,
	data,
	icon,
	onEdit,
	onDelete,
	onRemovePasskey,
	onTagsChange,
	onTagClick,
	availableTags,
	isUpdatingTags,
	onOpenUrl,
}: ItemDetailProps) {
	if (category === "login") {
		return (
			<LoginDetail
				data={data as LoginDisplayData}
				icon={icon}
				onEdit={onEdit}
				onDelete={onDelete}
				onRemovePasskey={onRemovePasskey}
				onTagsChange={onTagsChange}
				onTagClick={onTagClick}
				availableTags={availableTags}
				isUpdatingTags={isUpdatingTags}
				onOpenUrl={onOpenUrl}
			/>
		);
	}
	if (category === "credit-card") {
		return (
			<CreditCardDetail
				data={data as CreditCardDisplayData}
				icon={icon}
				onEdit={onEdit}
				onDelete={onDelete}
				onTagsChange={onTagsChange}
				onTagClick={onTagClick}
				availableTags={availableTags}
				isUpdatingTags={isUpdatingTags}
			/>
		);
	}
	if (category === "identity") {
		return (
			<IdentityDetail
				data={data as IdentityDisplayData}
				icon={icon}
				onEdit={onEdit}
				onDelete={onDelete}
				onTagsChange={onTagsChange}
				onTagClick={onTagClick}
				availableTags={availableTags}
				isUpdatingTags={isUpdatingTags}
			/>
		);
	}
	if (category === "totp") {
		return (
			<TotpDetail
				data={data as TotpDisplayData}
				icon={icon}
				onEdit={onEdit}
				onDelete={onDelete}
				onTagsChange={onTagsChange}
				onTagClick={onTagClick}
				availableTags={availableTags}
				isUpdatingTags={isUpdatingTags}
			/>
		);
	}
	return (
		<SecureNoteDetail
			data={data as SecureNoteDisplayData}
			icon={icon}
			onEdit={onEdit}
			onDelete={onDelete}
			onTagsChange={onTagsChange}
			onTagClick={onTagClick}
			availableTags={availableTags}
			isUpdatingTags={isUpdatingTags}
		/>
	);
}
