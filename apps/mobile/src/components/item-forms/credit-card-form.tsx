import {
	type CardBrand,
	detectCardBrand,
	formatCardNumber,
	getCardBrandDisplayName,
} from "@bittery/shared/credit-card";
import { TextField } from "heroui-native";
import { Eye, EyeOff } from "lucide-react-native";
import { forwardRef, useImperativeHandle, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { withUniwind } from "uniwind";

const StyledEye = withUniwind(Eye);
const StyledEyeOff = withUniwind(EyeOff);

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

export const CreditCardForm = forwardRef<CreditCardFormRef, CreditCardFormProps>(
	({ initialData }, ref) => {
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
		const [showCvv, setShowCvv] = useState(false);

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
			const brand = detectCardBrand(cleaned);
			setDetectedCardBrand(brand);
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
		const cleaned = value.replace(/\D/g, "");
		setCvv(cleaned);
	};

	return (
		<>
			<TextField className="mb-4">
				<TextField.Label>Cardholder Name</TextField.Label>
				<TextField.Input
					placeholder="Name on card"
					value={cardholderName}
					onChangeText={setCardholderName}
					autoCapitalize="words"
				/>
			</TextField>

			<TextField className="mb-4">
				<View className="mb-2 flex-row items-center justify-between">
					<TextField.Label>Card Number</TextField.Label>
					{detectedCardBrand && detectedCardBrand !== "unknown" && (
						<Text className="text-muted text-xs">
							{getCardBrandDisplayName(detectedCardBrand)}
						</Text>
					)}
				</View>
				<TextField.Input
					placeholder="1234 5678 9012 3456"
					value={formatCardNumber(cardNumber, detectedCardBrand || undefined)}
					onChangeText={handleCardNumberChange}
					keyboardType="numeric"
					maxLength={23}
					className="font-mono"
				/>
			</TextField>

			<View className="mb-4 flex-row gap-2">
				<TextField className="flex-1">
					<TextField.Label>Expiry</TextField.Label>
					<TextField.Input
						placeholder="MM/YY"
						value={expiryDate}
						onChangeText={handleExpiryChange}
						keyboardType="numeric"
						maxLength={5}
						className="font-mono"
					/>
				</TextField>

				<TextField className="flex-1">
					<TextField.Label>CVV</TextField.Label>
					<View className="w-full flex-row items-center">
						<TextField.Input
							placeholder="123"
							value={cvv}
							onChangeText={handleCvvChange}
							keyboardType="numeric"
							secureTextEntry={!showCvv}
							maxLength={detectedCardBrand === "amex" ? 4 : 3}
							className="flex-1 pr-12 font-mono"
						/>
						<Pressable
							onPress={() => setShowCvv(!showCvv)}
							className="absolute right-4"
						>
							{showCvv ? (
								<StyledEyeOff size={20} className="text-muted" />
							) : (
								<StyledEye size={20} className="text-muted" />
							)}
						</Pressable>
					</View>
				</TextField>
			</View>

			<TextField className="mb-4">
				<TextField.Label>Billing Address</TextField.Label>
				<TextField.Input
					placeholder="123 Main St, City, State ZIP"
					value={billingAddress}
					onChangeText={setBillingAddress}
					multiline
					numberOfLines={2}
					textAlignVertical="top"
					style={{ minHeight: 60 }}
				/>
			</TextField>
		</>
	);
	},
);

CreditCardForm.displayName = "CreditCardForm";
