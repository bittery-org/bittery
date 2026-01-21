/** biome-ignore-all lint/style/noNonNullAssertion: Thats fine here */

import {
	formatAddress,
	formatPhoneNumber,
	formatSSN,
	maskDriversLicense,
	maskPassportNumber,
	maskSSN,
} from "@bittery/shared/identity";
import { Button, Card, Input, Label } from "@bittery/ui";
import { Copy, Eye, EyeOff } from "lucide-react";
import { useState } from "react";
import { Favicon } from "../favicon";
import { TagInput } from "../tag-input";
import {
	type CategoryDetailProps,
	handleCopy,
	type IdentityDisplayData,
} from "./shared";

export function IdentityDetail({
	data,
	onEdit,
	onDelete,
	onTagsChange,
	onTagClick,
	availableTags = [],
	isUpdatingTags,
}: CategoryDetailProps<IdentityDisplayData>) {
	const [showSSN, setShowSSN] = useState(false);
	const [showPassport, setShowPassport] = useState(false);
	const [showDriversLicense, setShowDriversLicense] = useState(false);

	const fullName = [data.firstName, data.middleName, data.lastName]
		.filter(Boolean)
		.join(" ");

	return (
		<div className="space-y-4">
			<div className="flex items-center gap-4">
				<Favicon title={data.title} category="identity" size="lg" />
				<div className="min-w-0 flex-1">
					<h2 className="truncate font-semibold text-2xl tracking-tight">
						{data.title}
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

			{/* Tags */}
			{onTagsChange && (
				<div className="space-y-2">
					<Label>Tags</Label>
					<TagInput
						tags={data.tags || []}
						availableTags={availableTags}
						onChange={onTagsChange}
						onTagClick={onTagClick}
						disabled={isUpdatingTags}
					/>
				</div>
			)}

			<div className="space-y-4">
				{(data.firstName ||
					data.lastName ||
					data.email ||
					data.dateOfBirth) && (
					<div className="space-y-4 rounded-lg border p-4">
						<h3 className="font-medium text-sm">Personal Information</h3>

						{data.firstName && (
							<div className="space-y-2">
								<Label>First Name</Label>
								<div className="flex gap-2">
									<Input value={data.firstName} readOnly className="flex-1" />
									<Button
										size="icon"
										variant="outline"
										onClick={() => handleCopy(data.firstName!, "First name")}
									>
										<Copy size={16} />
									</Button>
								</div>
							</div>
						)}

						{data.middleName && (
							<div className="space-y-2">
								<Label>Middle Name</Label>
								<div className="flex gap-2">
									<Input value={data.middleName} readOnly className="flex-1" />
									<Button
										size="icon"
										variant="outline"
										onClick={() => handleCopy(data.middleName!, "Middle name")}
									>
										<Copy size={16} />
									</Button>
								</div>
							</div>
						)}

						{data.lastName && (
							<div className="space-y-2">
								<Label>Last Name</Label>
								<div className="flex gap-2">
									<Input value={data.lastName} readOnly className="flex-1" />
									<Button
										size="icon"
										variant="outline"
										onClick={() => handleCopy(data.lastName!, "Last name")}
									>
										<Copy size={16} />
									</Button>
								</div>
							</div>
						)}

						{data.email && (
							<div className="space-y-2">
								<Label>Email</Label>
								<div className="flex gap-2">
									<Input value={data.email} readOnly className="flex-1" />
									<Button
										size="icon"
										variant="outline"
										onClick={() => handleCopy(data.email!, "Email")}
									>
										<Copy size={16} />
									</Button>
								</div>
							</div>
						)}

						{data.dateOfBirth && (
							<div className="space-y-2">
								<Label>Date of Birth</Label>
								<div className="flex gap-2">
									<Input value={data.dateOfBirth} readOnly className="flex-1" />
									<Button
										size="icon"
										variant="outline"
										onClick={() =>
											handleCopy(data.dateOfBirth!, "Date of birth")
										}
									>
										<Copy size={16} />
									</Button>
								</div>
							</div>
						)}
					</div>
				)}

				{data.phoneNumbers && data.phoneNumbers.length > 0 && (
					<div className="space-y-2">
						<Label>Phone Numbers</Label>
						{data.phoneNumbers.map((phone) => (
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

				{data.addresses && data.addresses.length > 0 && (
					<div className="space-y-2">
						<Label>Addresses</Label>
						{data.addresses.map((address) => (
							<div key={address.id} className="space-y-2">
								<Card>
									<div className="px-4 py-3">
										<div className="text-sm">{formatAddress(address)}</div>
									</div>
								</Card>
								<Button
									size="sm"
									variant="outline"
									onClick={() => handleCopy(formatAddress(address), "Address")}
									className="w-full"
								>
									<Copy size={16} className="mr-2" />
									Copy Address
								</Button>
							</div>
						))}
					</div>
				)}

				{(data.ssn || data.passportNumber || data.driversLicense) && (
					<div className="space-y-4 rounded-lg border p-4">
						<h3 className="font-medium text-sm">Government IDs</h3>

						{data.ssn && (
							<div className="space-y-2">
								<Label>Social Security Number</Label>
								<div className="flex gap-2">
									<Input
										type={showSSN ? "text" : "password"}
										value={showSSN ? formatSSN(data.ssn) : maskSSN(data.ssn)}
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
										onClick={() => handleCopy(data.ssn!, "SSN")}
									>
										<Copy size={16} />
									</Button>
								</div>
							</div>
						)}

						{data.passportNumber && (
							<div className="space-y-2">
								<Label>Passport Number</Label>
								<div className="flex gap-2">
									<Input
										type={showPassport ? "text" : "password"}
										value={
											showPassport
												? data.passportNumber
												: maskPassportNumber(data.passportNumber)
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
											handleCopy(data.passportNumber!, "Passport number")
										}
									>
										<Copy size={16} />
									</Button>
								</div>
							</div>
						)}

						{data.driversLicense && (
							<div className="space-y-2">
								<Label>Driver's License</Label>
								<div className="flex gap-2">
									<Input
										type={showDriversLicense ? "text" : "password"}
										value={
											showDriversLicense
												? data.driversLicense
												: maskDriversLicense(data.driversLicense)
										}
										readOnly
										className="flex-1 font-mono"
									/>
									<Button
										size="icon"
										variant="outline"
										onClick={() => setShowDriversLicense(!showDriversLicense)}
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
											handleCopy(data.driversLicense!, "Driver's license")
										}
									>
										<Copy size={16} />
									</Button>
								</div>
							</div>
						)}
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
