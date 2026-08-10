import { View } from "react-native";
import { IconKeyRound, IconUser, ListCard } from "@/components/ui";
import { useI18n } from "@/providers/i18n-provider";
import { TotpDisplay } from "../totp-display";
import { DetailSection } from "./detail-section";
import { FieldGroup } from "./field-row";
import type { FieldDefinition, ItemDetailProps } from "./types";

export function TotpFields({ item, onCopy }: ItemDetailProps) {
	const { m } = useI18n();

	const fields: FieldDefinition[] = [
		{
			key: "secret",
			label: m.mob_detail_field_secret(),
			value: item.totpSecret,
			icon: IconKeyRound,
			masked: true,
			mono: true,
		},
		{
			key: "issuer",
			label: m.mob_detail_field_issuer(),
			value: item.totpIssuer,
		},
		{
			key: "account",
			label: m.mob_detail_field_account(),
			value: item.totpAccountName,
			icon: IconUser,
		},
		{
			key: "algorithm",
			label: m.mob_detail_field_algorithm(),
			value:
				item.totpAlgorithm && item.totpAlgorithm !== "SHA1"
					? item.totpAlgorithm
					: undefined,
			mono: true,
		},
		{
			key: "digits",
			label: m.mob_detail_field_digits(),
			value:
				item.totpDigits && item.totpDigits !== 6
					? String(item.totpDigits)
					: undefined,
			mono: true,
		},
		{
			key: "period",
			label: m.mob_detail_field_period(),
			value:
				item.totpPeriod && item.totpPeriod !== 30
					? m.mob_detail_field_period_seconds({
							seconds: String(item.totpPeriod),
						})
					: undefined,
		},
	];

	return (
		<>
			{item.totpSecret ? (
				<DetailSection title={m.mob_detail_field_current_code()}>
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

			<DetailSection title={m.mob_detail_section_details()}>
				<FieldGroup fields={fields} onCopy={onCopy} />
			</DetailSection>
		</>
	);
}
