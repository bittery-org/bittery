/** biome-ignore-all lint/style/noNonNullAssertion: Thats fine here */

import {
	detectCardBrand,
	formatExpiryDate,
	getCardBrandDisplayName,
	maskCardNumber,
} from "@bittery/shared/credit-card";
import type { DecryptedItemWithContext } from "@bittery/shared/types";
import { Button, Card, Input, Label } from "@bittery/ui";
import {
	IconCopyOutlineDuo18 as Copy,
	IconEyeOutlineDuo18 as Eye,
	IconEyeSlashOutlineDuo18 as EyeOff,
} from "@bittery/ui/icons";
import { useState } from "react";
import { ShareHistoryDialog, ShareItemDialog } from "@/components/sharing";
import { useI18n } from "@/providers/i18n-provider";
import { Favicon } from "../favicon";
import {
	type CategoryDetailProps,
	type CreditCardDisplayData,
	handleCopy,
} from "./shared";

interface CreditCardDetailProps
	extends CategoryDetailProps<CreditCardDisplayData> {
	item?: DecryptedItemWithContext;
}

export function CreditCardDetail({
	data,
	onEdit,
	onDelete,
	item,
}: CreditCardDetailProps) {
	const { m } = useI18n();
	const [showCardNumber, setShowCardNumber] = useState(false);
	const [showCVV, setShowCVV] = useState(false);

	const cardBrand = detectCardBrand(data.cardNumber);
	const formattedExpiry = formatExpiryDate(data.expiryDate);
	const maskedCardNumber = maskCardNumber(data.cardNumber);

	return (
		<div className="space-y-4">
			<div className="flex items-center gap-4">
				<Favicon item={item ? { ...item, category: "credit-card" } : undefined} title={data.title} size="lg" />
				<div className="min-w-0 flex-1">
					<h2 className="truncate font-semibold text-2xl tracking-tight">
						{data.title}
					</h2>
					<p className="mt-1 text-muted-foreground text-sm">
						{getCardBrandDisplayName(cardBrand)} • {maskedCardNumber}
					</p>
				</div>
			</div>

			<div className="flex gap-2">
				{onEdit && (
					<Button size="sm" variant="outline" onClick={onEdit}>
						{m["vaults.detail.items.detail.action.edit"]()}
					</Button>
				)}
				{item && <ShareItemDialog item={item} />}
				{item && <ShareHistoryDialog itemId={item.id} />}
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

			<div className="space-y-4">
				<div className="space-y-2">
					<Label>
						{m[
							"vaults.detail.items.detail.credit_card.field.cardholder_name"
						]()}
					</Label>
					<div className="flex gap-2">
						<Input value={data.cardholderName} readOnly className="flex-1" />
						<Button
							size="icon"
							variant="outline"
							onClick={() =>
								handleCopy(
									data.cardholderName,
									m["vaults.detail.items.copy.label.cardholder_name"](),
									m,
								)
							}
						>
							<Copy size={16} />
						</Button>
					</div>
				</div>

				<div className="space-y-2">
					<Label>
						{m["vaults.detail.items.detail.credit_card.field.card_number"]()}
					</Label>
					<div className="flex gap-2">
						<Input
							type={showCardNumber ? "text" : "password"}
							value={data.cardNumber}
							readOnly
							className="flex-1 font-mono"
						/>
						<Button
							size="icon"
							variant="outline"
							onClick={() => setShowCardNumber(!showCardNumber)}
						>
							{showCardNumber ? <EyeOff size={16} /> : <Eye size={16} />}
						</Button>
						<Button
							size="icon"
							variant="outline"
							onClick={() =>
								handleCopy(
									data.cardNumber,
									m["vaults.detail.items.copy.label.card_number"](),
									m,
								)
							}
						>
							<Copy size={16} />
						</Button>
					</div>
				</div>

				<div className="grid grid-cols-2 gap-4">
					<div className="space-y-2">
						<Label>
							{m["vaults.detail.items.detail.credit_card.field.expiry_date"]()}
						</Label>
						<div className="flex gap-2">
							<Input
								value={formattedExpiry}
								readOnly
								className="flex-1 font-mono"
							/>
							<Button
								size="icon"
								variant="outline"
								onClick={() =>
									handleCopy(
										formattedExpiry,
										m["vaults.detail.items.copy.label.expiry_date"](),
										m,
									)
								}
							>
								<Copy size={16} />
							</Button>
						</div>
					</div>

					<div className="space-y-2">
						<Label>
							{m["vaults.detail.items.detail.credit_card.field.cvv"]()}
						</Label>
						<div className="flex gap-2">
							<Input
								type={showCVV ? "text" : "password"}
								value={data.cvv}
								readOnly
								className="flex-1 font-mono"
							/>
							<Button
								size="icon"
								variant="outline"
								onClick={() => setShowCVV(!showCVV)}
							>
								{showCVV ? <EyeOff size={16} /> : <Eye size={16} />}
							</Button>
							<Button
								size="icon"
								variant="outline"
								onClick={() =>
									handleCopy(
										data.cvv,
										m["vaults.detail.items.copy.label.cvv"](),
										m,
									)
								}
							>
								<Copy size={16} />
							</Button>
						</div>
					</div>
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
		</div>
	);
}
