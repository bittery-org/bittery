import {
	type CardBrand,
	detectCardBrand,
	formatCardNumber,
	getCardBrandDisplayName,
} from "@bittery/shared/credit-card";
import { Input } from "heroui-native";
import { forwardRef, useImperativeHandle, useState } from "react";
import { Text, View } from "react-native";
import { useI18n } from "@/providers/i18n-provider";
import { FormField, SecretInput } from "./form-field";

export interface CreditCardFormData {
	cardholderName: string;
	cardNumber: string;
	expiryDate: string;
	cvv: string;
	billingAddress?: string;
}

export interface CreditCardFormRef {
	getData: () => CreditCardFormData;
	isValid: () => boolean;
}

interface CreditCardFormProps {
	initialData?: Partial<CreditCardFormData>;
}

export const CreditCardForm = forwardRef<
	CreditCardFormRef,
	CreditCardFormProps
>(({ initialData }, ref) => {
	const { m } = useI18n();
	const [cardholderName, setCardholderName] = useState(
		initialData?.cardholderName || "",
	);
	const [cardNumber, setCardNumber] = useState(initialData?.cardNumber || "");
	const [expiryDate, setExpiryDate] = useState(initialData?.expiryDate || "");
	const [cvv, setCvv] = useState(initialData?.cvv || "");
	const [billingAddress, setBillingAddress] = useState(
		initialData?.billingAddress || "",
	);
	const [detectedCardBrand, setDetectedCardBrand] = useState<CardBrand | "">(
		initialData?.cardNumber && initialData.cardNumber.length >= 4
			? detectCardBrand(initialData.cardNumber)
			: "",
	);
	const [isCvvRevealed, setIsCvvRevealed] = useState(false);

	useImperativeHandle(ref, () => ({
		getData: () => ({
			cardholderName,
			cardNumber,
			expiryDate,
			cvv,
			billingAddress: billingAddress || undefined,
		}),
		isValid: () => true, // Add validation as needed
	}));

	const handleCardNumberChange = (value: string) => {
		const cleaned = value.replace(/\D/g, "");

		if (cleaned.length >= 4) {
			setDetectedCardBrand(detectCardBrand(cleaned));
		} else {
			setDetectedCardBrand("");
		}

		setCardNumber(cleaned);
	};

	const handleExpiryChange = (value: string) => {
		let cleaned = value.replace(/\D/g, "");
		if (cleaned.length >= 2) {
			cleaned = `${cleaned.slice(0, 2)}/${cleaned.slice(2, 4)}`;
		}
		setExpiryDate(cleaned);
	};

	const handleCvvChange = (value: string) => {
		setCvv(value.replace(/\D/g, ""));
	};

	const brandDisplayName =
		detectedCardBrand && detectedCardBrand !== "unknown"
			? getCardBrandDisplayName(detectedCardBrand)
			: null;

	return (
		<>
			<FormField label={m.mob_form_cc_cardholder_label()}>
				<Input
					placeholder={m.mob_form_cc_cardholder_placeholder()}
					value={cardholderName}
					onChangeText={setCardholderName}
					autoCapitalize="words"
				/>
			</FormField>

			<FormField
				label={m.mob_form_cc_number_label()}
				labelAccessory={
					brandDisplayName ? (
						<View className="rounded-lg bg-default px-2 py-0.5">
							<Text className="font-medium text-2xs text-muted">
								{brandDisplayName}
							</Text>
						</View>
					) : null
				}
			>
				<Input
					placeholder={m.mob_form_cc_number_placeholder()}
					value={formatCardNumber(cardNumber, detectedCardBrand || undefined)}
					onChangeText={handleCardNumberChange}
					keyboardType="numeric"
					maxLength={23}
					className="font-mono"
				/>
			</FormField>

			<View className="flex-row gap-3">
				<FormField label={m.mob_form_cc_expiry_label()} className="flex-1">
					<Input
						placeholder={m.mob_form_cc_expiry_placeholder()}
						value={expiryDate}
						onChangeText={handleExpiryChange}
						keyboardType="numeric"
						maxLength={5}
						className="font-mono"
					/>
				</FormField>

				<FormField label={m.mob_form_cc_cvv_label()} className="flex-1">
					<SecretInput
						placeholder={m.mob_form_cc_cvv_placeholder()}
						value={cvv}
						onChangeText={handleCvvChange}
						keyboardType="numeric"
						maxLength={detectedCardBrand === "amex" ? 4 : 3}
						isRevealed={isCvvRevealed}
						onToggleReveal={() => setIsCvvRevealed(!isCvvRevealed)}
						revealLabel={m.mob_form_cc_cvv_label()}
						className="font-mono"
					/>
				</FormField>
			</View>

			<FormField label={m.mob_form_cc_billing_label()}>
				<Input
					placeholder={m.mob_form_cc_billing_placeholder()}
					value={billingAddress}
					onChangeText={setBillingAddress}
					multiline
					numberOfLines={2}
					textAlignVertical="top"
					style={{ minHeight: 72 }}
				/>
			</FormField>
		</>
	);
});

CreditCardForm.displayName = "CreditCardForm";
