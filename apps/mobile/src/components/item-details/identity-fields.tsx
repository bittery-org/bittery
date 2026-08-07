import { IconMail, IconUser } from "@/components/ui";
import { useI18n } from "@/providers/i18n-provider";
import { DetailSection } from "./detail-section";
import { FieldGroup } from "./field-row";
import type { FieldDefinition, ItemDetailProps } from "./types";

interface Address {
	street?: string;
	city?: string;
	state?: string;
	zip?: string;
	country?: string;
}

interface PhoneNumber {
	label?: string;
	number?: string;
}

export function IdentityFields({ item, onCopy }: ItemDetailProps) {
	const { m } = useI18n();

	const fullName = [item.firstName, item.middleName, item.lastName]
		.filter(Boolean)
		.join(" ");
	const addresses: Address[] = Array.isArray(item.addresses)
		? item.addresses
		: [];
	const phoneNumbers: PhoneNumber[] = Array.isArray(item.phoneNumbers)
		? item.phoneNumbers
		: [];

	const fields: FieldDefinition[] = [
		{
			key: "name",
			label: m.mob_detail_field_name(),
			value: fullName || undefined,
			icon: IconUser,
		},
		{
			key: "email",
			label: m.mob_detail_field_email(),
			value: item.email,
			icon: IconMail,
		},
		{
			key: "dateOfBirth",
			label: m.mob_detail_field_date_of_birth(),
			value: item.dateOfBirth,
		},
		{
			key: "ssn",
			label: m.mob_detail_field_ssn(),
			value: item.ssn,
			masked: true,
			mono: true,
		},
		{
			key: "passportNumber",
			label: m.mob_detail_field_passport_number(),
			value: item.passportNumber,
			mono: true,
		},
		{
			key: "driversLicense",
			label: m.mob_detail_field_drivers_license(),
			value: item.driversLicense,
			mono: true,
		},
		...addresses.map((address, index) => ({
			key: `address-${index}`,
			label:
				[address.city, address.country].filter(Boolean).join(", ") ||
				m.mob_detail_field_billing_address(),
			value:
				[
					address.street,
					address.city,
					address.state,
					address.zip,
					address.country,
				]
					.filter(Boolean)
					.join(", ") || undefined,
			multiline: true,
		})),
		...phoneNumbers.map((phone, index) => ({
			key: `phone-${index}`,
			label: phone.label || m.mob_detail_field_phone(),
			value: phone.number,
		})),
	];

	return (
		<DetailSection title={m.mob_detail_section_details()}>
			<FieldGroup fields={fields} onCopy={onCopy} />
		</DetailSection>
	);
}
