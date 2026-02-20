/** biome-ignore-all lint/style/noNonNullAssertion: Thats fine here */

import {
	detectCardBrand,
	formatExpiryDate,
	getCardBrandDisplayName,
	maskCardNumber,
} from "@bittery/shared/credit-card";
import type { DecryptedItem } from "@bittery/shared/types";
import { Button, Card, Input, Label } from "@bittery/ui";
import {
	IconCopyOutlineDuo18 as Copy,
	IconEyeOutlineDuo18 as Eye,
	IconEyeSlashOutlineDuo18 as EyeOff,
} from "@bittery/ui/icons";
import { useState } from "react";
import { ShareHistoryDialog, ShareItemDialog } from "@/components/sharing";
import { Favicon } from "../favicon";
import {
	type CategoryDetailProps,
	type CreditCardDisplayData,
	handleCopy,
} from "./shared";

interface CreditCardDetailProps
	extends CategoryDetailProps<CreditCardDisplayData> {
	item?: DecryptedItem;
}

export function CreditCardDetail({
	data,
	onEdit,
	onDelete,
	item,
}: CreditCardDetailProps) {
	const [showCardNumber, setShowCardNumber] = useState(false);
	const [showCVV, setShowCVV] = useState(false);

	const cardBrand = detectCardBrand(data.cardNumber);
	const formattedExpiry = formatExpiryDate(data.expiryDate);
	const maskedCardNumber = maskCardNumber(data.cardNumber);

	return (
		<div className="space-y-4">
			<div className="flex items-center gap-4">
				<Favicon
					title={data.title}
					category="credit-card"
					cardBrand={cardBrand}
					size="lg"
				/>
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
						Edit
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
						Delete
					</Button>
				)}
			</div>

			<div className="space-y-4">
				<div className="space-y-2">
					<Label>Cardholder Name</Label>
					<div className="flex gap-2">
						<Input value={data.cardholderName} readOnly className="flex-1" />
						<Button
							size="icon"
							variant="outline"
							onClick={() => handleCopy(data.cardholderName, "Cardholder name")}
						>
							<Copy size={16} />
						</Button>
					</div>
				</div>

				<div className="space-y-2">
					<Label>Card Number</Label>
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
							onClick={() => handleCopy(data.cardNumber, "Card number")}
						>
							<Copy size={16} />
						</Button>
					</div>
				</div>

				<div className="grid grid-cols-2 gap-4">
					<div className="space-y-2">
						<Label>Expiry Date</Label>
						<div className="flex gap-2">
							<Input
								value={formattedExpiry}
								readOnly
								className="flex-1 font-mono"
							/>
							<Button
								size="icon"
								variant="outline"
								onClick={() => handleCopy(formattedExpiry, "Expiry date")}
							>
								<Copy size={16} />
							</Button>
						</div>
					</div>

					<div className="space-y-2">
						<Label>CVV</Label>
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
								onClick={() => handleCopy(data.cvv, "CVV")}
							>
								<Copy size={16} />
							</Button>
						</div>
					</div>
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
		</div>
	);
}
