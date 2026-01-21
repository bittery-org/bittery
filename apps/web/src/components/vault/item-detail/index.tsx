import type {
	CreditCardDisplayData,
	DecryptedItem,
	IdentityDisplayData,
	LoginDisplayData,
	SecureNoteDisplayData,
	TotpDisplayData,
} from "@bittery/shared/types";
import { Label, Separator } from "@bittery/ui";
import { TagInput } from "../tag-input";
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

	// Note: Tag changes require updating the item's encrypted data.
	// For the web app (read-only), we just display tags.
	// Full editing is done in the desktop app.

	return (
		<div className="space-y-6">
			{renderDetail()}

			{/* Tags section - display only in web app */}
			{item && vaultId && (
				<>
					<Separator />
					<div className="space-y-2">
						<Label className="text-muted-foreground text-sm">Tags</Label>
						{itemTags.length > 0 ? (
							<TagInput
								tags={itemTags}
								availableTags={availableTags}
								onChange={() => {
									// Tags are read-only in web app
									// Full editing is done in desktop app
								}}
								disabled={!canEdit}
							/>
						) : (
							<p className="text-muted-foreground text-sm">
								No tags. Edit in the desktop app to add tags.
							</p>
						)}
					</div>
				</>
			)}
		</div>
	);
}
