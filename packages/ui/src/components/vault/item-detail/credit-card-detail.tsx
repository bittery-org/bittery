import { useI18n } from "@bittery/i18n/react";
import {
	detectCardBrand,
	formatExpiryDate,
	getCardBrandDisplayName,
	maskCardNumber,
} from "@bittery/shared/credit-card";
import { Button } from "../../button";
import { Label } from "../../label";
import { TagInput } from "../../tag-input";
import {
	DetailField,
	DetailFieldGroup,
	DetailHeader,
	DetailNoteField,
	DetailPasswordField,
} from "./field-components";
import type { CategoryDetailProps, CreditCardDisplayData } from "./shared";

export function CreditCardDetail({
	data,
	icon,
	onEdit,
	onDelete,
	onTagsChange,
	onTagClick,
	availableTags = [],
	isUpdatingTags,
}: CategoryDetailProps<CreditCardDisplayData>) {
	const { m } = useI18n();
	const cardBrand = detectCardBrand(data.cardNumber);
	const formattedExpiry = formatExpiryDate(data.expiryDate);
	const maskedCardNumber = maskCardNumber(data.cardNumber);

	return (
		<div className="space-y-4">
			<DetailHeader
				icon={icon}
				title={data.title}
				subtitle={`${getCardBrandDisplayName(cardBrand)} • ${maskedCardNumber}`}
			/>

			<div className="flex gap-2">
				{onEdit && (
					<Button size="sm" variant="outline" onClick={onEdit}>
						{m.vaults_detail_items_detail_action_edit()}
					</Button>
				)}
				{onDelete && (
					<Button
						size="sm"
						variant="ghost"
						className="text-destructive hover:bg-destructive/10 hover:text-destructive"
						onClick={onDelete}
					>
						{m.vaults_detail_items_detail_action_delete()}
					</Button>
				)}
			</div>

			<div className="space-y-3.5">
				<DetailFieldGroup>
					<DetailField
						label={m.vaults_detail_items_detail_credit_card_field_cardholder_name()}
						value={data.cardholderName}
					/>
					<DetailPasswordField
						label={m.vaults_detail_items_detail_credit_card_field_card_number()}
						value={data.cardNumber}
					/>
					<DetailField
						label={m.vaults_detail_items_detail_credit_card_field_expiry_date()}
						value={formattedExpiry}
					/>
					<DetailPasswordField
						label={m.vaults_detail_items_detail_credit_card_field_cvv()}
						value={data.cvv}
					/>
				</DetailFieldGroup>

				<DetailNoteField
					label={m.vaults_detail_items_detail_credit_card_field_billing_address()}
					value={data.billingAddress}
				/>

				<DetailNoteField
					label={m.vaults_detail_items_form_field_notes_label()}
					value={data.notes}
				/>
			</div>

			{onTagsChange && (
				<div className="space-y-2">
					<Label>{m.vaults_detail_items_detail_tags_label()}</Label>
					<TagInput
						tags={data.tags || []}
						availableTags={availableTags}
						onChange={onTagsChange}
						onTagClick={onTagClick}
						disabled={isUpdatingTags}
					/>
				</div>
			)}
		</div>
	);
}
