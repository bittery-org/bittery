import { Button, Card } from "heroui-native";
import { Copy, Mail } from "lucide-react-native";
import { useState } from "react";
import { View } from "react-native";
import { withUniwind } from "uniwind";
import { FieldRow } from "./field-row";
import type { ItemDetailProps } from "./types";

const StyledCopy = withUniwind(Copy);

export function IdentityFields({ item, onCopy }: ItemDetailProps) {
	const [showSsn, setShowSsn] = useState(false);

	return (
		<>
			{/* Full Name */}
			{(item.firstName || item.lastName) && (
				<Card variant="default" className="mb-2">
					<Card.Body className="py-3">
						<Card.Description className="mb-1.5">Name</Card.Description>
						<Card.Title className="font-normal text-base" selectable>
							{[item.firstName, item.middleName, item.lastName]
								.filter(Boolean)
								.join(" ")}
						</Card.Title>
					</Card.Body>
				</Card>
			)}

			<FieldRow
				label="Email"
				value={item.email}
				onCopy={onCopy}
				options={{ icon: Mail }}
			/>
			<FieldRow
				label="Date of Birth"
				value={item.dateOfBirth}
				onCopy={onCopy}
			/>
			<FieldRow
				label="SSN"
				value={item.ssn}
				onCopy={onCopy}
				options={{
					masked: true,
					showState: showSsn,
					setShowState: setShowSsn,
				}}
			/>
			<FieldRow
				label="Passport Number"
				value={item.passportNumber}
				onCopy={onCopy}
			/>
			<FieldRow
				label="Driver's License"
				value={item.driversLicense}
				onCopy={onCopy}
			/>

			{/* Addresses */}
			{item.addresses?.map((address: any, index: number) => (
				<Card key={`address-${index}`} variant="secondary" className="mb-2">
					<Card.Body className="py-3">
						<Card.Description className="mb-1.5">
							{address.city} {address.country}
						</Card.Description>
						<Card.Title className="font-normal text-base" selectable>
							{[
								address.street,
								address.city,
								address.state,
								address.zip,
								address.country,
							]
								.filter(Boolean)
								.join(", ")}
						</Card.Title>
					</Card.Body>
				</Card>
			))}

			{/* Phone Numbers */}
			{item.phoneNumbers?.map((phone: any, index: number) => (
				<Card key={`phone-${index}`} variant="secondary" className="mb-2">
					<Card.Body className="py-3">
						<Card.Description className="mb-1.5">
							{phone.label || `Phone ${index + 1}`}
						</Card.Description>
						<View className="flex-row items-center gap-2.5">
							<Card.Title className="flex-1 font-normal text-base" selectable>
								{phone.number}
							</Card.Title>
							<Button
								isIconOnly
								size="sm"
								variant="ghost"
								onPress={() => onCopy(phone.number, "Phone")}
							>
								<StyledCopy size={18} className="text-muted" />
							</Button>
						</View>
					</Card.Body>
				</Card>
			))}
		</>
	);
}
