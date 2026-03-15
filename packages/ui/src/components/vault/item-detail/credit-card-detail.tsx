import { useI18n } from "@bittery/i18n/react";
import {
	detectCardBrand,
	formatExpiryDate,
	getCardBrandDisplayName,
	maskCardNumber,
} from "@bittery/shared/credit-card";
import { Button } from "../../button";
import { Card } from "../../card";
import { Label } from "../../label";
import { TagInput } from "../../tag-input";
import { DetailField, DetailHeader, DetailPasswordField } from "./field-components";
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

			<div className="space-y-3">
				<DetailField
					label={m.vaults_detail_items_detail_credit_card_field_cardholder_name()}
					value={data.cardholderName}
				/>
				<DetailPasswordField
					label={m.vaults_detail_items_detail_credit_card_field_card_number()}
					value={data.cardNumber}
				/>

				<div className="grid grid-cols-2 gap-4">
					<DetailField
						label={m.vaults_detail_items_detail_credit_card_field_expiry_date()}
						value={formattedExpiry}
					/>
					<DetailPasswordField
						label={m.vaults_detail_items_detail_credit_card_field_cvv()}
						value={data.cvv}
					/>
				</div>

				{data.billingAddress && (
					<div className="space-y-2">
						<Label className="font-medium text-sm">
							{m.vaults_detail_items_detail_credit_card_field_billing_address()}
						</Label>
						<Card>
							<div className="whitespace-pre-wrap px-4 py-1 text-sm">
								{data.billingAddress}
							</div>
						</Card>
					</div>
				)}

				{data.notes && (
					<div className="space-y-2">
						<Label className="font-medium text-sm">
							{m.vaults_detail_items_form_field_notes_label()}
						</Label>
						<Card>
							<div className="whitespace-pre-wrap px-4 py-1 text-sm">{data.notes}</div>
						</Card>
					</div>
				)}
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
