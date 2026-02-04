import { Button, Card } from "heroui-native";
import { Copy, Globe, Key, User } from "lucide-react-native";
import { useState } from "react";
import { View } from "react-native";
import { withUniwind } from "uniwind";
import { TotpDisplay } from "../totp-display";
import { FieldRow } from "./field-row";
import type { ItemDetailProps } from "./types";

const StyledGlobe = withUniwind(Globe);
const StyledCopy = withUniwind(Copy);
const StyledUser = withUniwind(User);
const StyledKey = withUniwind(Key);

export function LoginFields({ item, onCopy }: ItemDetailProps) {
	const [showPassword, setShowPassword] = useState(false);

	return (
		<>
			<FieldRow
				label="Username"
				value={item.username}
				onCopy={onCopy}
				options={{ icon: StyledUser }}
			/>
			<FieldRow
				label="Password"
				value={item.password}
				onCopy={onCopy}
				options={{
					masked: true,
					showState: showPassword,
					setShowState: setShowPassword,
					icon: StyledKey,
				}}
			/>
			<FieldRow
				label="Website"
				value={item.url}
				onCopy={onCopy}
				options={{ icon: StyledGlobe }}
			/>

			{/* Additional URLs */}
			{item.urls &&
				item.urls.length > 1 &&
				item.urls.slice(1).map((url: string, index: number) => (
					<Card key={url} variant="secondary" className="mb-2">
						<Card.Body className="py-3">
							<Card.Description className="mb-1.5">
								Website {index + 2}
							</Card.Description>
							<View className="flex-row items-center gap-2.5">
								<StyledGlobe size={16} className="text-muted" />
								<Card.Title className="flex-1 font-normal text-base" selectable>
									{url}
								</Card.Title>
								<Button
									isIconOnly
									size="sm"
									variant="ghost"
									onPress={() => onCopy(url, "URL")}
								>
									<StyledCopy size={18} className="text-muted" />
								</Button>
							</View>
						</Card.Body>
					</Card>
				))}

			{/* TOTP Section for Login Items */}
			{item.totpSecret && (
				<Card variant="default" className="mb-2">
					<Card.Body className="py-3">
						<Card.Description className="mb-2">
							Two-Factor Code
						</Card.Description>
						<TotpDisplay
							totpSecret={item.totpSecret}
							totpAlgorithm={item.totpAlgorithm}
							totpDigits={item.totpDigits}
							totpPeriod={item.totpPeriod}
							label={item.totpIssuer || "One-time password"}
						/>
					</Card.Body>
				</Card>
			)}
		</>
	);
}
