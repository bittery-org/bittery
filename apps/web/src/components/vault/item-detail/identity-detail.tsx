/** biome-ignore-all lint/style/noNonNullAssertion: Thats fine here */

import {
	formatAddress,
	formatPhoneNumber,
	formatSSN,
	maskDriversLicense,
	maskPassportNumber,
	maskSSN,
} from "@bittery/shared/identity";
import type { DecryptedItem } from "@bittery/shared/types";
import { Button, Card, Input, Label } from "@bittery/ui";
import {
	IconCopyOutlineDuo18 as Copy,
	IconEyeOutlineDuo18 as Eye,
	IconEyeSlashOutlineDuo18 as EyeOff,
} from "@bittery/ui/icons";
import { useState } from "react";
import { ShareHistoryDialog, ShareItemDialog } from "@/components/sharing";
import { useI18n } from "@/providers/i18n-provider";
import { Favicon } from "../favicon";
import {
	type CategoryDetailProps,
	handleCopy,
	type IdentityDisplayData,
} from "./shared";

interface IdentityDetailProps extends CategoryDetailProps<IdentityDisplayData> {
	item?: DecryptedItem;
}

export function IdentityDetail({
	data,
	onEdit,
	onDelete,
	item,
}: IdentityDetailProps) {
	const { m } = useI18n();
	const [showSSN, setShowSSN] = useState(false);
	const [showPassport, setShowPassport] = useState(false);
	const [showDriversLicense, setShowDriversLicense] = useState(false);

	const fullName = [data.firstName, data.middleName, data.lastName]
		.filter(Boolean)
		.join(" ");

	const getPhoneLabel = (label: string) => {
		switch (label) {
			case "Mobile":
				return m["vaults.detail.items.form.identity.phone_type.mobile"]();
			case "Home":
				return m["vaults.detail.items.form.identity.phone_type.home"]();
			case "Work":
				return m["vaults.detail.items.form.identity.phone_type.work"]();
			case "Other":
				return m["vaults.detail.items.form.identity.phone_type.other"]();
			default:
				return label;
		}
	};

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
						{m["vaults.detail.items.detail.action.edit"]()}
					</Button>
				)}
				{item && <ShareItemDialog item={item} />}
				{item && <ShareHistoryDialog itemId={item.id} />}
				{onDelete && (
					<Button
						size="sm"
						variant="ghost"
						className="text-destructive hover:bg-destructive/10 hover:text-destructive"
						onClick={onDelete}
					>
						{m["vaults.detail.items.detail.action.delete"]()}
					</Button>
				)}
			</div>

			<div className="space-y-4">
				{(data.firstName ||
					data.lastName ||
					data.email ||
					data.dateOfBirth) && (
					<div className="space-y-4 rounded-lg border p-4">
						<h3 className="font-medium text-sm">
							{m[
								"vaults.detail.items.detail.identity.section.personal_information"
							]()}
						</h3>

						{data.firstName && (
							<div className="space-y-2">
								<Label>
									{m["vaults.detail.items.form.identity.field.first_name"]()}
								</Label>
								<div className="flex gap-2">
									<Input value={data.firstName} readOnly className="flex-1" />
									<Button
										size="icon"
										variant="outline"
										onClick={() =>
											handleCopy(
												data.firstName!,
												m["vaults.detail.items.copy.label.first_name"](),
												m,
											)
										}
									>
										<Copy size={16} />
									</Button>
								</div>
							</div>
						)}

						{data.middleName && (
							<div className="space-y-2">
								<Label>
									{m["vaults.detail.items.form.identity.field.middle_name"]()}
								</Label>
								<div className="flex gap-2">
									<Input value={data.middleName} readOnly className="flex-1" />
									<Button
										size="icon"
										variant="outline"
										onClick={() =>
											handleCopy(
												data.middleName!,
												m["vaults.detail.items.copy.label.middle_name"](),
												m,
											)
										}
									>
										<Copy size={16} />
									</Button>
								</div>
							</div>
						)}

						{data.lastName && (
							<div className="space-y-2">
								<Label>
									{m["vaults.detail.items.form.identity.field.last_name"]()}
								</Label>
								<div className="flex gap-2">
									<Input value={data.lastName} readOnly className="flex-1" />
									<Button
										size="icon"
										variant="outline"
										onClick={() =>
											handleCopy(
												data.lastName!,
												m["vaults.detail.items.copy.label.last_name"](),
												m,
											)
										}
									>
										<Copy size={16} />
									</Button>
								</div>
							</div>
						)}

						{data.email && (
							<div className="space-y-2">
								<Label>
									{m["vaults.detail.items.form.identity.field.email"]()}
								</Label>
								<div className="flex gap-2">
									<Input value={data.email} readOnly className="flex-1" />
									<Button
										size="icon"
										variant="outline"
										onClick={() =>
											handleCopy(
												data.email!,
												m["vaults.detail.items.copy.label.email"](),
												m,
											)
										}
									>
										<Copy size={16} />
									</Button>
								</div>
							</div>
						)}

						{data.dateOfBirth && (
							<div className="space-y-2">
								<Label>
									{m["vaults.detail.items.form.identity.field.date_of_birth"]()}
								</Label>
								<div className="flex gap-2">
									<Input value={data.dateOfBirth} readOnly className="flex-1" />
									<Button
										size="icon"
										variant="outline"
										onClick={() =>
											handleCopy(
												data.dateOfBirth!,
												m["vaults.detail.items.copy.label.date_of_birth"](),
												m,
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

				{data.phoneNumbers && data.phoneNumbers.length > 0 && (
					<div className="space-y-2">
						<Label>
							{m["vaults.detail.items.form.identity.section.phone_numbers"]()}
						</Label>
						{data.phoneNumbers.map((phone) => (
							<div key={phone.id} className="space-y-1">
								<Label className="text-muted-foreground text-xs">
									{getPhoneLabel(phone.label)}
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
											handleCopy(
												phone.number,
												m["vaults.detail.items.copy.label.phone"]({
													label: getPhoneLabel(phone.label),
												}),
												m,
											)
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
						<Label>
							{m["vaults.detail.items.form.identity.section.addresses"]()}
						</Label>
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
									onClick={() =>
										handleCopy(
											formatAddress(address),
											m["vaults.detail.items.copy.label.address"](),
											m,
										)
									}
									className="w-full"
								>
									<Copy size={16} className="mr-2" />
									{m[
										"vaults.detail.items.detail.identity.action.copy_address"
									]()}
								</Button>
							</div>
						))}
					</div>
				)}

				{(data.ssn || data.passportNumber || data.driversLicense) && (
					<div className="space-y-4 rounded-lg border p-4">
						<h3 className="font-medium text-sm">
							{m["vaults.detail.items.form.identity.section.government_ids"]()}
						</h3>

						{data.ssn && (
							<div className="space-y-2">
								<Label>
									{m[
										"vaults.detail.items.form.identity.field.social_security_number"
									]()}
								</Label>
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
										onClick={() =>
											handleCopy(
												data.ssn!,
												m["vaults.detail.items.copy.label.ssn"](),
												m,
											)
										}
									>
										<Copy size={16} />
									</Button>
								</div>
							</div>
						)}

						{data.passportNumber && (
							<div className="space-y-2">
								<Label>
									{m[
										"vaults.detail.items.form.identity.field.passport_number"
									]()}
								</Label>
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
											handleCopy(
												data.passportNumber!,
												m["vaults.detail.items.copy.label.passport_number"](),
												m,
											)
										}
									>
										<Copy size={16} />
									</Button>
								</div>
							</div>
						)}

						{data.driversLicense && (
							<div className="space-y-2">
								<Label>
									{m[
										"vaults.detail.items.form.identity.field.drivers_license"
									]()}
								</Label>
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
											handleCopy(
												data.driversLicense!,
												m["vaults.detail.items.copy.label.drivers_license"](),
												m,
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

				{data.notes && (
					<div className="space-y-2">
						<Label className="font-medium text-sm">
							{m["vaults.detail.items.form.field.notes.label"]()}
						</Label>
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
