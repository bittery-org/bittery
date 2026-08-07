import { View } from "react-native";
import { IconGlobe, IconKey, IconUser, ListCard } from "@/components/ui";
import { useI18n } from "@/providers/i18n-provider";
import { TotpDisplay } from "../totp-display";
import { DetailSection } from "./detail-section";
import { FieldGroup } from "./field-row";
import type { FieldDefinition, ItemDetailProps } from "./types";

export function LoginFields({ item, onCopy }: ItemDetailProps) {
	const { m } = useI18n();
	const extraUrls: string[] = Array.isArray(item.urls)
		? item.urls.slice(1)
		: [];

	const fields: FieldDefinition[] = [
		{
			key: "username",
			label: m.mob_detail_field_username(),
			value: item.username,
			icon: IconUser,
		},
		{
			key: "password",
			label: m.mob_detail_field_password(),
			value: item.password,
			icon: IconKey,
			masked: true,
			mono: true,
		},
		{
			key: "url",
			label: m.mob_detail_field_website(),
			value: item.url,
			icon: IconGlobe,
		},
		...extraUrls.map((url, index) => ({
			key: `url-${index + 2}`,
			label: m.mob_detail_field_website_n({ index: String(index + 2) }),
			value: url,
			icon: IconGlobe,
		})),
	];

	return (
		<>
			<DetailSection title={m.mob_detail_section_details()}>
				<FieldGroup fields={fields} onCopy={onCopy} />
			</DetailSection>

			{item.totpSecret ? (
				<DetailSection title={m.mob_detail_field_two_factor_code()}>
					<ListCard>
						<View className="p-4">
							<TotpDisplay
								totpSecret={item.totpSecret}
								totpAlgorithm={item.totpAlgorithm}
								totpDigits={item.totpDigits}
								totpPeriod={item.totpPeriod}
								label={item.totpIssuer || undefined}
							/>
						</View>
					</ListCard>
				</DetailSection>
			) : null}
		</>
	);
}
