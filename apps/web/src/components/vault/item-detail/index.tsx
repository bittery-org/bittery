import type {
	CreditCardDisplayData,
	IdentityDisplayData,
	LoginDisplayData,
	SecureNoteDisplayData,
	TotpDisplayData,
} from "@bittery/shared/types";
import { CreditCardDetail } from "./credit-card-detail";
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
export type { CustomField, ItemDetailData, ItemDetailProps } from "./shared";

export default function ItemDetail({
	category,
	data,
	onEdit,
	onDelete,
}: ItemDetailProps) {
	if (category === "login") {
		return (
			<LoginDetail
				data={data as LoginDisplayData}
				onEdit={onEdit}
				onDelete={onDelete}
			/>
		);
	}
	if (category === "credit-card") {
		return (
			<CreditCardDetail
				data={data as CreditCardDisplayData}
				onEdit={onEdit}
				onDelete={onDelete}
			/>
		);
	}
	if (category === "identity") {
		return (
			<IdentityDetail
				data={data as IdentityDisplayData}
				onEdit={onEdit}
				onDelete={onDelete}
			/>
		);
	}
	if (category === "totp") {
		return (
			<TotpDetail
				data={data as TotpDisplayData}
				onEdit={onEdit}
				onDelete={onDelete}
			/>
		);
	}
	return (
		<SecureNoteDetail
			data={data as SecureNoteDisplayData}
			onEdit={onEdit}
			onDelete={onDelete}
		/>
	);
}
