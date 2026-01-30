/** biome-ignore-all lint/style/noNonNullAssertion: Thats fine here */

import {
	detectCardBrand,
	formatExpiryDate,
	getCardBrandDisplayName,
	maskCardNumber,
} from "@bittery/shared/credit-card";
import { Button, Card, Label } from "@bittery/ui";
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
	onEdit,
	onDelete,
	onTagsChange,
	onTagClick,
	availableTags = [],
	isUpdatingTags,
}: CategoryDetailProps<CreditCardDisplayData>) {
	const cardBrand = detectCardBrand(data.cardNumber);
	const formattedExpiry = formatExpiryDate(data.expiryDate);
	const maskedCardNumber = maskCardNumber(data.cardNumber);

	return (
		<div className="space-y-4">
			<DetailHeader
				icon={
					<Favicon
						title={data.title}
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
						Edit
					</Button>
				)}
				{onDelete && (
					<Button
						size="sm"
						variant="ghost"
						className="text-destructive hover:bg-destructive/10 hover:text-destructive"
						onClick={onDelete}
					>
						Delete
					</Button>
				)}
			</div>

			<div className="space-y-3">
				<DetailField label="Cardholder Name" value={data.cardholderName} />
				<DetailPasswordField label="Card Number" value={data.cardNumber} />

				<div className="grid grid-cols-2 gap-4">
					<DetailField label="Expiry Date" value={formattedExpiry} />
					<DetailPasswordField label="CVV" value={data.cvv} />
				</div>

				{data.billingAddress && (
					<div className="space-y-2">
						<Label className="font-medium text-sm">Billing Address</Label>
						<Card>
							<div className="whitespace-pre-wrap px-4 py-1 text-sm">
								{data.billingAddress}
							</div>
						</Card>
					</div>
				)}

				{data.notes && (
					<div className="space-y-2">
						<Label className="font-medium text-sm">Notes</Label>
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
					<Label>Tags</Label>
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
