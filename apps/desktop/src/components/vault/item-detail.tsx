/** biome-ignore-all lint/style/noNonNullAssertion: Thats fine here */

import {
	detectCardBrand,
	formatExpiryDate,
	getCardBrandDisplayName,
	maskCardNumber,
} from "@bittery/shared/credit-card";
import { copyToClipboard } from "@bittery/shared/crypto";
import {
	type Address,
	formatAddress,
	formatPhoneNumber,
	formatSSN,
	maskDriversLicense,
	maskPassportNumber,
	type PhoneNumber,
	maskSSN,
} from "@bittery/shared/identity";
import { Button, Card, Input, Label, toast } from "@bittery/ui";
import { Copy, ExternalLink, Eye, EyeOff } from "lucide-react";
import { useState } from "react";
import { Favicon } from "./favicon";

export interface CustomField {
	id: string;
	label: string;
	value: string;
	type: "text" | "password" | "email" | "url";
}

interface LoginData {
	title: string;
	url?: string;
	urls?: string[];
	username?: string;
	password?: string;
	notes?: string;
	customFields?: CustomField[];
}

interface SecureNoteData {
	title: string;
	note: string;
}

interface CreditCardData {
	title: string;
	cardholderName: string;
	cardNumber: string;
	cvv: string;
	expiryDate: string;
	billingAddress?: string;
	notes?: string;
}

interface IdentityData {
	title: string;
	firstName?: string;
	middleName?: string;
	lastName?: string;
	email?: string;
	addresses?: Address[];
	phoneNumbers?: PhoneNumber[];
	ssn?: string;
	passportNumber?: string;
	driversLicense?: string;
	dateOfBirth?: string;
	notes?: string;
}

interface ItemDetailProps {
	category: "login" | "secure-note" | "credit-card" | "identity";
	data: LoginData | SecureNoteData | CreditCardData | IdentityData;
	onEdit?: () => void;
	onDelete?: () => void;
}

export default function ItemDetail({
	category,
	data,
	onEdit,
	onDelete,
}: ItemDetailProps) {
	const [showPassword, setShowPassword] = useState(false);
	const [showCardNumber, setShowCardNumber] = useState(false);
	const [showCVV, setShowCVV] = useState(false);
	const [showSSN, setShowSSN] = useState(false);
	const [showPassport, setShowPassport] = useState(false);
	const [showDriversLicense, setShowDriversLicense] = useState(false);
	const [visibleCustomFields, setVisibleCustomFields] = useState<Set<string>>(
		new Set(),
	);

	const handleCopy = async (text: string, label: string) => {
		await copyToClipboard(text, 30000);
		toast.success(`${label} copied to clipboard (auto-clear in 30s)`);
	};

	const toggleCustomFieldVisibility = (fieldId: string) => {
		setVisibleCustomFields((prev) => {
			const next = new Set(prev);
			if (next.has(fieldId)) {
				next.delete(fieldId);
			} else {
				next.add(fieldId);
			}
			return next;
		});
	};

	if (category === "credit-card") {
		const cardData = data as CreditCardData;
		const cardBrand = detectCardBrand(cardData.cardNumber);
		const formattedExpiry = formatExpiryDate(cardData.expiryDate);
		const maskedCardNumber = maskCardNumber(cardData.cardNumber);

		return (
			<div className="space-y-4">
				{/* Header with credit card icon */}
				<div className="flex items-center gap-4">
					<Favicon
						title={cardData.title}
						category="credit-card"
						cardBrand={cardBrand}
						size="lg"
					/>
					<div className="min-w-0 flex-1">
						<h2 className="truncate font-semibold text-2xl tracking-tight">
							{cardData.title}
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
							<Input
								value={cardData.cardholderName}
								readOnly
								className="flex-1"
							/>
							<Button
								size="icon"
								variant="outline"
								onClick={() =>
									handleCopy(cardData.cardholderName, "Cardholder name")
								}
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
								value={cardData.cardNumber}
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
								onClick={() => handleCopy(cardData.cardNumber, "Card number")}
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
									value={cardData.cvv}
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
									onClick={() => handleCopy(cardData.cvv, "CVV")}
								>
									<Copy size={16} />
								</Button>
							</div>
						</div>
					</div>

					{cardData.billingAddress && (
						<div className="space-y-2">
							<Label className="font-medium text-sm">Billing Address</Label>
							<Card>
								<div className="whitespace-pre-wrap px-4 py-1 text-sm">
									{cardData.billingAddress}
								</div>
							</Card>
						</div>
					)}

					{cardData.notes && (
						<div className="space-y-2">
							<Label className="font-medium text-sm">Notes</Label>
							<Card>
								<div className="whitespace-pre-wrap px-4 py-1 text-sm">
									{cardData.notes}
								</div>
							</Card>
						</div>
					)}
				</div>
			</div>
		);
	}

	if (category === "login") {
		const loginData = data as LoginData;

		return (
			<div className="space-y-4">
				{/* Header with favicon */}
				<div className="flex items-center gap-4">
					<Favicon
						url={loginData.url}
						title={loginData.title}
						category="login"
						size="lg"
					/>
					<div className="min-w-0 flex-1">
						<h2 className="truncate font-semibold text-2xl tracking-tight">
							{loginData.title}
						</h2>
						{loginData.url && (
							<p className="mt-1 truncate text-muted-foreground text-sm">
								{loginData.url}
							</p>
						)}
					</div>
				</div>

				<div className="flex gap-2">
					{onEdit && (
						<Button size="sm" variant="outline" onClick={onEdit}>
							Edit
						</Button>
					)}
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
					{loginData.url && (
						<div className="space-y-2">
							<Label>Website</Label>
							<div className="flex gap-2">
								<Input value={loginData.url} readOnly className="flex-1" />
								<Button
									size="icon"
									variant="outline"
									onClick={() => handleCopy(loginData.url!, "URL")}
								>
									<Copy size={16} />
								</Button>
								<Button
									size="icon"
									variant="outline"
									onClick={() => window.open(loginData.url, "_blank")}
								>
									<ExternalLink size={16} />
								</Button>
							</div>
						</div>
					)}

					{loginData.username && (
						<div className="space-y-2">
							<Label>Username</Label>
							<div className="flex gap-2">
								<Input value={loginData.username} readOnly className="flex-1" />
								<Button
									size="icon"
									variant="outline"
									onClick={() => handleCopy(loginData.username!, "Username")}
								>
									<Copy size={16} />
								</Button>
							</div>
						</div>
					)}

					{loginData.password && (
						<div className="space-y-2">
							<Label>Password</Label>
							<div className="flex gap-2">
								<Input
									type={showPassword ? "text" : "password"}
									value={loginData.password}
									readOnly
									className="flex-1 font-mono"
								/>
								<Button
									size="icon"
									variant="outline"
									onClick={() => setShowPassword(!showPassword)}
								>
									{showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
								</Button>
								<Button
									size="icon"
									variant="outline"
									onClick={() => handleCopy(loginData.password!, "Password")}
								>
									<Copy size={16} />
								</Button>
							</div>
						</div>
					)}

					{loginData.notes && (
						<div className="space-y-2">
							<Label className="font-medium text-sm">Notes</Label>
							<Card>
								<div className="whitespace-pre-wrap px-4 py-1 text-sm">
									{loginData.notes}
								</div>
							</Card>
						</div>
					)}

					{/* Additional URLs */}
					{loginData.urls && loginData.urls.length > 0 && (
						<div className="space-y-2">
							<Label>Additional Websites</Label>
							{loginData.urls.map((url) => (
								<div key={url} className="flex gap-2">
									<Input value={url} readOnly className="flex-1" />
									<Button
										size="icon"
										variant="outline"
										onClick={() => handleCopy(url, "URL")}
									>
										<Copy size={16} />
									</Button>
									<Button
										size="icon"
										variant="outline"
										onClick={() => window.open(url, "_blank")}
									>
										<ExternalLink size={16} />
									</Button>
								</div>
							))}
						</div>
					)}

					{/* Custom Fields */}
					{loginData.customFields && loginData.customFields.length > 0 && (
						<div className="space-y-3">
							{loginData.customFields.map((field) => (
								<div key={field.id} className="space-y-2">
									<Label className="text-sm">{field.label}</Label>
									<div className="flex gap-2">
										<Input
											type={
												field.type === "password" &&
												!visibleCustomFields.has(field.id)
													? "password"
													: "text"
											}
											value={field.value}
											readOnly
											className="flex-1"
										/>
										{field.type === "password" && (
											<Button
												size="icon"
												variant="outline"
												onClick={() => toggleCustomFieldVisibility(field.id)}
											>
												{visibleCustomFields.has(field.id) ? (
													<EyeOff size={16} />
												) : (
													<Eye size={16} />
												)}
											</Button>
										)}
										<Button
											size="icon"
											variant="outline"
											onClick={() => handleCopy(field.value, field.label)}
										>
											<Copy size={16} />
										</Button>
										{field.type === "url" && (
											<Button
												size="icon"
												variant="outline"
												onClick={() => window.open(field.value, "_blank")}
											>
												<ExternalLink size={16} />
											</Button>
										)}
									</div>
								</div>
							))}
						</div>
					)}
				</div>
			</div>
		);
	}

	if (category === "identity") {
		const identityData = data as IdentityData;
		const fullName = [
			identityData.firstName,
			identityData.middleName,
			identityData.lastName,
		]
			.filter(Boolean)
			.join(" ");

		return (
			<div className="space-y-4">
				{/* Header */}
				<div className="flex items-center gap-4">
					<Favicon title={identityData.title} category="identity" size="lg" />
					<div className="min-w-0 flex-1">
						<h2 className="truncate font-semibold text-2xl tracking-tight">
							{identityData.title}
						</h2>
						{fullName && (
							<p className="mt-1 text-muted-foreground text-sm">{fullName}</p>
						)}
					</div>
				</div>

				<div className="flex gap-2">
					{onEdit && (
						<Button size="sm" variant="outline" onClick={onEdit}>
							Edit
						</Button>
					)}
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
					{/* Personal Information */}
					{(identityData.firstName ||
						identityData.lastName ||
						identityData.email ||
						identityData.dateOfBirth) && (
						<div className="space-y-4 rounded-lg border p-4">
							<h3 className="font-medium text-sm">Personal Information</h3>

							{identityData.firstName && (
								<div className="space-y-2">
									<Label>First Name</Label>
									<div className="flex gap-2">
										<Input
											value={identityData.firstName}
											readOnly
											className="flex-1"
										/>
										<Button
											size="icon"
											variant="outline"
											onClick={() =>
												handleCopy(identityData.firstName!, "First name")
											}
										>
											<Copy size={16} />
										</Button>
									</div>
								</div>
							)}

							{identityData.middleName && (
								<div className="space-y-2">
									<Label>Middle Name</Label>
									<div className="flex gap-2">
										<Input
											value={identityData.middleName}
											readOnly
											className="flex-1"
										/>
										<Button
											size="icon"
											variant="outline"
											onClick={() =>
												handleCopy(identityData.middleName!, "Middle name")
											}
										>
											<Copy size={16} />
										</Button>
									</div>
								</div>
							)}

							{identityData.lastName && (
								<div className="space-y-2">
									<Label>Last Name</Label>
									<div className="flex gap-2">
										<Input
											value={identityData.lastName}
											readOnly
											className="flex-1"
										/>
										<Button
											size="icon"
											variant="outline"
											onClick={() =>
												handleCopy(identityData.lastName!, "Last name")
											}
										>
											<Copy size={16} />
										</Button>
									</div>
								</div>
							)}

							{identityData.email && (
								<div className="space-y-2">
									<Label>Email</Label>
									<div className="flex gap-2">
										<Input
											value={identityData.email}
											readOnly
											className="flex-1"
										/>
										<Button
											size="icon"
											variant="outline"
											onClick={() => handleCopy(identityData.email!, "Email")}
										>
											<Copy size={16} />
										</Button>
									</div>
								</div>
							)}

							{identityData.dateOfBirth && (
								<div className="space-y-2">
									<Label>Date of Birth</Label>
									<div className="flex gap-2">
										<Input
											value={identityData.dateOfBirth}
											readOnly
											className="flex-1"
										/>
										<Button
											size="icon"
											variant="outline"
											onClick={() =>
												handleCopy(identityData.dateOfBirth!, "Date of birth")
											}
										>
											<Copy size={16} />
										</Button>
									</div>
								</div>
							)}
						</div>
					)}

					{/* Phone Numbers */}
					{identityData.phoneNumbers && identityData.phoneNumbers.length > 0 && (
						<div className="space-y-2">
							<Label>Phone Numbers</Label>
							{identityData.phoneNumbers.map((phone) => (
								<div key={phone.id} className="space-y-1">
									<Label className="text-muted-foreground text-xs">
										{phone.label}
									</Label>
									<div className="flex gap-2">
										<Input
											value={formatPhoneNumber(phone.number)}
											readOnly
											className="flex-1"
										/>
										<Button
											size="icon"
											variant="outline"
											onClick={() =>
												handleCopy(phone.number, `${phone.label} phone`)
											}
										>
											<Copy size={16} />
										</Button>
									</div>
								</div>
							))}
						</div>
					)}

					{/* Addresses */}
					{identityData.addresses && identityData.addresses.length > 0 && (
						<div className="space-y-2">
							<Label>Addresses</Label>
							{identityData.addresses.map((address) => (
								<div key={address.id} className="space-y-2">
									<Card>
										<div className="px-4 py-3">
											<div className="text-sm">{formatAddress(address)}</div>
										</div>
									</Card>
									<Button
										size="sm"
										variant="outline"
										onClick={() =>
											handleCopy(formatAddress(address), "Address")
										}
										className="w-full"
									>
										<Copy size={16} className="mr-2" />
										Copy Address
									</Button>
								</div>
							))}
						</div>
					)}

					{/* Government IDs */}
					{(identityData.ssn ||
						identityData.passportNumber ||
						identityData.driversLicense) && (
						<div className="space-y-4 rounded-lg border p-4">
							<h3 className="font-medium text-sm">Government IDs</h3>

							{identityData.ssn && (
								<div className="space-y-2">
									<Label>Social Security Number</Label>
									<div className="flex gap-2">
										<Input
											type={showSSN ? "text" : "password"}
											value={
												showSSN ? formatSSN(identityData.ssn) : maskSSN(identityData.ssn)
											}
											readOnly
											className="flex-1 font-mono"
										/>
										<Button
											size="icon"
											variant="outline"
											onClick={() => setShowSSN(!showSSN)}
										>
											{showSSN ? <EyeOff size={16} /> : <Eye size={16} />}
										</Button>
										<Button
											size="icon"
											variant="outline"
											onClick={() => handleCopy(identityData.ssn!, "SSN")}
										>
											<Copy size={16} />
										</Button>
									</div>
								</div>
							)}

							{identityData.passportNumber && (
								<div className="space-y-2">
									<Label>Passport Number</Label>
									<div className="flex gap-2">
										<Input
											type={showPassport ? "text" : "password"}
											value={
												showPassport
													? identityData.passportNumber
													: maskPassportNumber(identityData.passportNumber)
											}
											readOnly
											className="flex-1 font-mono"
										/>
										<Button
											size="icon"
											variant="outline"
											onClick={() => setShowPassport(!showPassport)}
										>
											{showPassport ? <EyeOff size={16} /> : <Eye size={16} />}
										</Button>
										<Button
											size="icon"
											variant="outline"
											onClick={() =>
												handleCopy(
													identityData.passportNumber!,
													"Passport number",
												)
											}
										>
											<Copy size={16} />
										</Button>
									</div>
								</div>
							)}

							{identityData.driversLicense && (
								<div className="space-y-2">
									<Label>Driver's License</Label>
									<div className="flex gap-2">
										<Input
											type={showDriversLicense ? "text" : "password"}
											value={
												showDriversLicense
													? identityData.driversLicense
													: maskDriversLicense(identityData.driversLicense)
											}
											readOnly
											className="flex-1 font-mono"
										/>
										<Button
											size="icon"
											variant="outline"
											onClick={() =>
												setShowDriversLicense(!showDriversLicense)
											}
										>
											{showDriversLicense ? (
												<EyeOff size={16} />
											) : (
												<Eye size={16} />
											)}
										</Button>
										<Button
											size="icon"
											variant="outline"
											onClick={() =>
												handleCopy(
													identityData.driversLicense!,
													"Driver's license",
												)
											}
										>
											<Copy size={16} />
										</Button>
									</div>
								</div>
							)}
						</div>
					)}

					{identityData.notes && (
						<div className="space-y-2">
							<Label className="font-medium text-sm">Notes</Label>
							<Card>
								<div className="whitespace-pre-wrap px-4 py-1 text-sm">
									{identityData.notes}
								</div>
							</Card>
						</div>
					)}
				</div>
			</div>
		);
	}

	// Secure Note
	const noteData = data as SecureNoteData;

	return (
		<div className="space-y-4">
			{/* Header with icon for secure notes */}
			<div className="flex items-center gap-4">
				<Favicon title={noteData.title} category="secure-note" size="lg" />
				<div className="min-w-0 flex-1">
					<h2 className="truncate font-semibold text-2xl tracking-tight">
						{noteData.title}
					</h2>
					<p className="mt-1 text-muted-foreground text-sm">Secure Note</p>
				</div>
			</div>

			<div className="flex gap-2">
				{onEdit && (
					<Button size="sm" variant="outline" onClick={onEdit}>
						Edit
					</Button>
				)}
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

			<Card>
				<div className="whitespace-pre-wrap p-6 leading-relaxed">
					{noteData.note}
				</div>
			</Card>
		</div>
	);
}
