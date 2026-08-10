import {
	detectCardBrand,
	getCardBrandDisplayName,
} from "@bittery/shared/credit-card";
import { IconCreditCard, IconUser } from "@/components/ui";
import { useI18n } from "@/providers/i18n-provider";
import { DetailSection } from "./detail-section";
import { FieldGroup } from "./field-row";
import type { FieldDefinition, ItemDetailProps } from "./types";
import { formatCardNumber } from "./utils";

export function CreditCardFields({ item, onCopy }: ItemDetailProps) {
	const { m } = useI18n();

	const cardBrand = item.cardNumber ? detectCardBrand(item.cardNumber) : null;
	const brandDisplayName =
		cardBrand && cardBrand !== "unknown"
			? getCardBrandDisplayName(cardBrand)
			: undefined;

	const fields: FieldDefinition[] = [
		{
			key: "cardholderName",
			label: m.mob_detail_field_cardholder_name(),
			value: item.cardholderName,
			icon: IconUser,
		},
		{
			key: "cardNumber",
			label: m.mob_detail_field_card_number(),
			value: item.cardNumber,
			icon: IconCreditCard,
			masked: true,
			mono: true,
			badge: brandDisplayName,
			formattedValue: item.cardNumber
				? formatCardNumber(item.cardNumber)
				: undefined,
		},
		{
			key: "expiryDate",
			label: m.mob_detail_field_expiry_date(),
			value: item.expiryDate,
			mono: true,
		},
		{
			key: "cvv",
			label: m.mob_detail_field_cvv(),
			value: item.cvv,
			masked: true,
			mono: true,
		},
		{
			key: "billingAddress",
			label: m.mob_detail_field_billing_address(),
			value: item.billingAddress,
			multiline: true,
		},
	];

	return (
		<DetailSection title={m.mob_detail_section_details()}>
			<FieldGroup fields={fields} onCopy={onCopy} />
		</DetailSection>
	);
}
