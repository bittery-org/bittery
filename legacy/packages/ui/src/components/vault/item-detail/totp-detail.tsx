import { useI18n } from "@bittery/i18n/react";
import { formatSecretForDisplay } from "@bittery/shared/totp";
import { Button } from "../../button";
import { InlineTotpDisplay } from "../../inline-totp-display";
import { Label } from "../../label";
import { TagInput } from "../../tag-input";
import {
	DetailField,
	DetailFieldGroup,
	DetailHeader,
	DetailNoteField,
	DetailPasswordField,
	DetailSection,
} from "./field-components";
import type { CategoryDetailProps, TotpDisplayData } from "./shared";

export function TotpDetail({
	data,
	icon,
	onEdit,
	onDelete,
	onTagsChange,
	onTagClick,
	availableTags = [],
	isUpdatingTags,
}: CategoryDetailProps<TotpDisplayData>) {
	const { m } = useI18n();
	const subtitle = [data.totpIssuer, data.totpAccountName].filter(Boolean).join(" - ");

	return (
		<div className="space-y-4">
			<DetailHeader icon={icon} title={data.title} subtitle={subtitle} />

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
				<DetailFieldGroup>
					<InlineTotpDisplay
						totpSecret={data.totpSecret}
						totpAlgorithm={data.totpAlgorithm}
						totpDigits={data.totpDigits}
						totpPeriod={data.totpPeriod}
					/>
					<DetailPasswordField
						label={m.vaults_detail_items_copy_label_secret_key()}
						value={data.totpSecret}
						maskValue={formatSecretForDisplay(data.totpSecret)}
						copyLabel={m.vaults_detail_items_copy_label_secret_key()}
					/>
				</DetailFieldGroup>

				<DetailSection title={m.vaults_detail_items_detail_totp_section_settings()}>
					<DetailField
						label={m.vaults_detail_items_totp_settings_field_algorithm()}
						value={data.totpAlgorithm || "SHA-1"}
						onCopy={false}
					/>
					<DetailField
						label={m.vaults_detail_items_totp_settings_field_digits()}
						value={String(data.totpDigits || 6)}
						onCopy={false}
					/>
					<DetailField
						label={m.vaults_detail_items_totp_settings_field_period()}
						value={`${data.totpPeriod || 30}s`}
						onCopy={false}
					/>
				</DetailSection>

				<DetailNoteField
					label={m.vaults_detail_items_form_field_notes_label()}
					value={data.notes}
				/>

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
		</div>
	);
}
