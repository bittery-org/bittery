import type {
	CreditCardDisplayData,
	DecryptedItem,
	IdentityDisplayData,
	LoginDisplayData,
	SecureNoteDisplayData,
	TotpDisplayData,
} from "@bittery/shared/types";
import { Label, Separator } from "@bittery/ui";
import { useI18n } from "@/providers/i18n-provider";
import { TagInput } from "../tag-input";
import { CreditCardDetail } from "./credit-card-detail";
import { IdentityDetail } from "./identity-detail";
import { ItemAttachments } from "./item-attachments";
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

interface ItemDetailComponentProps extends ItemDetailProps {
	item?: DecryptedItem;
	vaultId?: string;
	availableTags?: string[];
	canEdit?: boolean;
}

export default function ItemDetail({
	category,
	data,
	onEdit,
	onDelete,
	item,
	vaultId,
	availableTags = [],
	canEdit = false,
}: ItemDetailComponentProps) {
	const { m } = useI18n();
	// Get tags for this item directly from the item data
	const itemTags = item?.tags || [];

	// Render the category-specific detail
	const renderDetail = () => {
		if (category === "login") {
			return (
				<LoginDetail
					data={data as LoginDisplayData}
					onEdit={onEdit}
					onDelete={onDelete}
					item={item}
				/>
			);
		}
		if (category === "credit-card") {
			return (
				<CreditCardDetail
					data={data as CreditCardDisplayData}
					onEdit={onEdit}
					onDelete={onDelete}
					item={item}
				/>
			);
		}
		if (category === "identity") {
			return (
				<IdentityDetail
					data={data as IdentityDisplayData}
					onEdit={onEdit}
					onDelete={onDelete}
					item={item}
				/>
			);
		}
		if (category === "totp") {
			return (
				<TotpDetail
					data={data as TotpDisplayData}
					onEdit={onEdit}
					onDelete={onDelete}
					item={item}
				/>
			);
		}
		return (
			<SecureNoteDetail
				data={data as SecureNoteDisplayData}
				onEdit={onEdit}
				onDelete={onDelete}
				item={item}
			/>
		);
	};

	return (
		<div className="min-w-0 space-y-6">
			{renderDetail()}

			{/* Tags section */}
			{item && vaultId && (
				<>
					<Separator />
					<div className="space-y-2">
						<Label className="text-muted-foreground text-sm">
							{m["vaults.detail.items.detail.tags.label"]()}
						</Label>
						{itemTags.length > 0 ? (
							<TagInput
								tags={itemTags}
								availableTags={availableTags}
								onChange={() => {}}
								disabled
							/>
						) : (
							<p className="text-muted-foreground text-sm">
								{m["vaults.detail.items.detail.tags.empty"]()}
							</p>
						)}
					</div>
				</>
			)}

			{/* Attachments section */}
			{item && vaultId && (
				<>
					<Separator />
					<ItemAttachments
						itemId={item.id}
						vaultId={vaultId}
						canEdit={canEdit}
					/>
				</>
			)}
		</div>
	);
}
