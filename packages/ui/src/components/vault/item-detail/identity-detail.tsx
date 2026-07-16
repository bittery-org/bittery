import { useI18n } from "@bittery/i18n/react";
import {
	formatAddress,
	formatPhoneNumber,
	maskDriversLicense,
	maskPassportNumber,
	maskSSN,
} from "@bittery/shared/identity";
import { IconCopyOutlineDuo18 } from "../../../icons";
import { Button } from "../../button";
import { Label } from "../../label";
import { TagInput } from "../../tag-input";
import {
	DetailField,
	DetailFieldGroup,
	DetailGroupLabel,
	DetailHeader,
	DetailNoteField,
	DetailPasswordField,
	DetailRow,
	DetailSection,
} from "./field-components";
import {
	type CategoryDetailProps,
	handleCopy,
	type IdentityDisplayData,
} from "./shared";

export function IdentityDetail({
	data,
	icon,
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
				return m.vaults_detail_items_form_identity_phone_type_mobile();
			case "Home":
				return m.vaults_detail_items_form_identity_phone_type_home();
			case "Work":
				return m.vaults_detail_items_form_identity_phone_type_work();
			case "Other":
				return m.vaults_detail_items_form_identity_phone_type_other();
			default:
				return label;
		}
	};

	return (
		<div className="space-y-4">
			<DetailHeader icon={icon} title={data.title} subtitle={fullName} />

			<div className="flex gap-2">
				{onEdit && (
					<Button size="sm" variant="outline" onClick={onEdit}>
						{m.vaults_detail_items_detail_action_edit()}
					</Button>
				)}
				{onDelete && (
					<Button
						size="sm"
						variant="ghost"
						className="text-destructive hover:bg-destructive/10 hover:text-destructive"
						onClick={onDelete}
					>
						{m.vaults_detail_items_detail_action_delete()}
					</Button>
				)}
			</div>

			<div className="space-y-3.5">
				{(data.firstName || data.lastName || data.email || data.dateOfBirth) && (
					<DetailSection
						title={m.vaults_detail_items_detail_identity_section_personal_information()}
					>
						<DetailField
							label={m.vaults_detail_items_form_identity_field_first_name()}
							value={data.firstName}
							copyLabel={m.vaults_detail_items_copy_label_first_name()}
						/>
						<DetailField
							label={m.vaults_detail_items_form_identity_field_middle_name()}
							value={data.middleName}
							copyLabel={m.vaults_detail_items_copy_label_middle_name()}
						/>
						<DetailField
							label={m.vaults_detail_items_form_identity_field_last_name()}
							value={data.lastName}
							copyLabel={m.vaults_detail_items_copy_label_last_name()}
						/>
						<DetailField
							label={m.vaults_detail_items_form_identity_field_email()}
							value={data.email}
							copyLabel={m.vaults_detail_items_copy_label_email()}
						/>
						<DetailField
							label={m.vaults_detail_items_form_identity_field_date_of_birth()}
							value={data.dateOfBirth}
							copyLabel={m.vaults_detail_items_copy_label_date_of_birth()}
						/>
					</DetailSection>
				)}

				{data.phoneNumbers && data.phoneNumbers.length > 0 && (
					<DetailSection title={m.vaults_detail_items_form_identity_section_phone_numbers()}>
						{data.phoneNumbers.map((phone) => (
							<DetailField
								key={phone.id}
								label={getPhoneLabel(phone.label)}
								value={formatPhoneNumber(phone.number)}
								copyLabel={m.vaults_detail_items_copy_label_phone({ label: getPhoneLabel(phone.label) })}
							/>
						))}
					</DetailSection>
				)}

				{data.addresses && data.addresses.length > 0 && (
					<div>
						<DetailGroupLabel>
							{m.vaults_detail_items_form_identity_section_addresses()}
						</DetailGroupLabel>
						<div className="space-y-2">
							{data.addresses.map((address) => (
								<div key={address.id} className="space-y-2">
									<DetailFieldGroup>
										<DetailRow align="start">
											<p className="whitespace-pre-wrap text-sm text-foreground">
												{formatAddress(address)}
											</p>
										</DetailRow>
									</DetailFieldGroup>
									<Button
										size="sm"
										variant="outline"
										onClick={() =>
											handleCopy(formatAddress(address), m.vaults_detail_items_copy_label_address(), m)
										}
										className="w-full"
									>
										<IconCopyOutlineDuo18 size={16} />
										{m.vaults_detail_items_detail_identity_action_copy_address()}
									</Button>
								</div>
							))}
						</div>
					</div>
				)}

				{(data.ssn || data.passportNumber || data.driversLicense) && (
					<DetailSection title={m.vaults_detail_items_form_identity_section_government_ids()}>
						{data.ssn && (
							<DetailPasswordField
								label={m.vaults_detail_items_form_identity_field_social_security_number()}
								value={data.ssn}
								maskValue={maskSSN(data.ssn)}
								copyLabel={m.vaults_detail_items_copy_label_ssn()}
							/>
						)}
						{data.passportNumber && (
							<DetailPasswordField
								label={m.vaults_detail_items_form_identity_field_passport_number()}
								value={data.passportNumber}
								maskValue={maskPassportNumber(data.passportNumber)}
								copyLabel={m.vaults_detail_items_copy_label_passport_number()}
							/>
						)}
						{data.driversLicense && (
							<DetailPasswordField
								label={m.vaults_detail_items_form_identity_field_drivers_license()}
								value={data.driversLicense}
								maskValue={maskDriversLicense(data.driversLicense)}
								copyLabel={m.vaults_detail_items_copy_label_drivers_license()}
							/>
						)}
					</DetailSection>
				)}

				<DetailNoteField
					label={m.vaults_detail_items_form_field_notes_label()}
					value={data.notes}
				/>
			</div>

			{onTagsChange && (
				<div className="space-y-2">
					<Label>{m.vaults_detail_items_detail_tags_label()}</Label>
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
