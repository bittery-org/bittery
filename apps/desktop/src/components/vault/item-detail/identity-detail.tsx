/** biome-ignore-all lint/style/noNonNullAssertion: Thats fine here */

import {
	formatAddress,
	formatPhoneNumber,
	maskDriversLicense,
	maskPassportNumber,
	maskSSN,
} from "@bittery/shared/identity";
import { Button, Card, Label } from "@bittery/ui";
import { IconCopyOutlineDuo18 } from "@bittery/ui/icons";
import { useI18n } from "../../../providers/i18n-provider";
import { Favicon } from "../favicon";
import { TagInput } from "../tag-input";
import {
	DetailField,
	DetailHeader,
	DetailPasswordField,
	DetailSection,
} from "./field-components";
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
	const { m } = useI18n();
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
			<DetailHeader
				icon={<Favicon title={data.title} category="identity" size="lg" />}
				title={data.title}
				subtitle={fullName}
			/>

			<div className="flex gap-2">
				{onEdit && (
					<Button size="sm" variant="outline" onClick={onEdit}>
						{m["vaults.detail.items.detail.action.edit"]()}
					</Button>
				)}
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

			<div className="space-y-3">
				{(data.firstName ||
					data.lastName ||
					data.email ||
					data.dateOfBirth) && (
					<DetailSection
						title={m[
							"vaults.detail.items.detail.identity.section.personal_information"
						]()}
					>
						<DetailField
							label={m["vaults.detail.items.form.identity.field.first_name"]()}
							value={data.firstName}
							copyLabel={m["vaults.detail.items.copy.label.first_name"]()}
						/>
						<DetailField
							label={m["vaults.detail.items.form.identity.field.middle_name"]()}
							value={data.middleName}
							copyLabel={m["vaults.detail.items.copy.label.middle_name"]()}
						/>
						<DetailField
							label={m["vaults.detail.items.form.identity.field.last_name"]()}
							value={data.lastName}
							copyLabel={m["vaults.detail.items.copy.label.last_name"]()}
						/>
						<DetailField
							label={m["vaults.detail.items.form.identity.field.email"]()}
							value={data.email}
							copyLabel={m["vaults.detail.items.copy.label.email"]()}
						/>
						<DetailField
							label={m[
								"vaults.detail.items.form.identity.field.date_of_birth"
							]()}
							value={data.dateOfBirth}
							copyLabel={m["vaults.detail.items.copy.label.date_of_birth"]()}
						/>
					</DetailSection>
				)}

				{data.phoneNumbers && data.phoneNumbers.length > 0 && (
					<div className="space-y-3">
						<Label className="font-medium text-sm">
							{m["vaults.detail.items.form.identity.section.phone_numbers"]()}
						</Label>
						{data.phoneNumbers.map((phone) => (
							<DetailField
								key={phone.id}
								label={getPhoneLabel(phone.label)}
								value={formatPhoneNumber(phone.number)}
								copyLabel={m["vaults.detail.items.copy.label.phone"]({
									label: getPhoneLabel(phone.label),
								})}
							/>
						))}
					</div>
				)}

				{data.addresses && data.addresses.length > 0 && (
					<div className="space-y-3">
						<Label className="font-medium text-sm">
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
									<IconCopyOutlineDuo18 size={16} />
									{m[
										"vaults.detail.items.detail.identity.action.copy_address"
									]()}
								</Button>
							</div>
						))}
					</div>
				)}

				{(data.ssn || data.passportNumber || data.driversLicense) && (
					<DetailSection
						title={m[
							"vaults.detail.items.form.identity.section.government_ids"
						]()}
					>
						{data.ssn && (
							<DetailPasswordField
								label={m[
									"vaults.detail.items.form.identity.field.social_security_number"
								]()}
								value={data.ssn}
								maskValue={maskSSN(data.ssn)}
								copyLabel={m["vaults.detail.items.copy.label.ssn"]()}
							/>
						)}
						{data.passportNumber && (
							<DetailPasswordField
								label={m[
									"vaults.detail.items.form.identity.field.passport_number"
								]()}
								value={data.passportNumber}
								maskValue={maskPassportNumber(data.passportNumber)}
								copyLabel={m[
									"vaults.detail.items.copy.label.passport_number"
								]()}
							/>
						)}
						{data.driversLicense && (
							<DetailPasswordField
								label={m[
									"vaults.detail.items.form.identity.field.drivers_license"
								]()}
								value={data.driversLicense}
								maskValue={maskDriversLicense(data.driversLicense)}
								copyLabel={m[
									"vaults.detail.items.copy.label.drivers_license"
								]()}
							/>
						)}
					</DetailSection>
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

			{/* Tags */}
			{onTagsChange && (
				<div className="space-y-2">
					<Label>{m["vaults.detail.items.detail.tags.label"]()}</Label>
					<TagInput
						tags={data.tags || []}
						availableTags={availableTags}
						onChange={onTagsChange}
						onTagClick={onTagClick}
						disabled={isUpdatingTags}
					/>
				</div>
			)}
		</div>
	);
}
