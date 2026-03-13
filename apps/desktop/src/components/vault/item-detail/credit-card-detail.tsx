/** biome-ignore-all lint/style/noNonNullAssertion: Thats fine here */

import {
	detectCardBrand,
	formatExpiryDate,
	getCardBrandDisplayName,
	maskCardNumber,
} from "@bittery/shared/credit-card";
import { Button, Card, Label } from "@bittery/ui";
import { useI18n } from "../../../providers/i18n-provider";
import { Favicon } from "../favicon";
import { TagInput } from "../tag-input";
import {
	DetailField,
	DetailHeader,
	DetailPasswordField,
} from "./field-components";
import type { CategoryDetailProps, CreditCardDisplayData } from "./shared";

export function CreditCardDetail({
	data,
	serverUrl,
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
				icon={
					<Favicon
						title={data.title}
						serverUrl={serverUrl}
						category="credit-card"
						cardBrand={cardBrand}
						size="lg"
					/>
				}
				title={data.title}
				subtitle={`${getCardBrandDisplayName(cardBrand)} • ${maskedCardNumber}`}
			/>

			<div className="flex gap-2">
				{onEdit && (
					<Button size="sm" variant="outline" onClick={onEdit}>
						{m["vaults.detail.items.detail.action.edit"]()}
					</Button>
				)}
				{onDelete && (
					<Button
						size="sm"
						variant="ghost"
						className="text-destructive hover:bg-destructive/10 hover:text-destructive"
						onClick={onDelete}
					>
						{m["vaults.detail.items.detail.action.delete"]()}
					</Button>
				)}
			</div>

			<div className="space-y-3">
				<DetailField
					label={m[
						"vaults.detail.items.detail.credit_card.field.cardholder_name"
					]()}
					value={data.cardholderName}
				/>
				<DetailPasswordField
					label={m[
						"vaults.detail.items.detail.credit_card.field.card_number"
					]()}
					value={data.cardNumber}
				/>

				<div className="grid grid-cols-2 gap-4">
					<DetailField
						label={m[
							"vaults.detail.items.detail.credit_card.field.expiry_date"
						]()}
						value={formattedExpiry}
					/>
					<DetailPasswordField
						label={m["vaults.detail.items.detail.credit_card.field.cvv"]()}
						value={data.cvv}
					/>
				</div>

				{data.billingAddress && (
					<div className="space-y-2">
						<Label className="font-medium text-sm">
							{m[
								"vaults.detail.items.detail.credit_card.field.billing_address"
							]()}
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
							{m["vaults.detail.items.form.field.notes.label"]()}
						</Label>
						<Card>
							<div className="whitespace-pre-wrap px-4 py-1 text-sm">
								{data.notes}
							</div>
						</Card>
					</div>
				)}
			</div>

			{/* Tags */}
			{onTagsChange && (
				<div className="space-y-2">
					<Label>{m["vaults.detail.items.detail.tags.label"]()}</Label>
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
