import { useI18n } from "@bittery/i18n/react";
import { formatSecretForDisplay } from "@bittery/shared/totp";
import { Button } from "../../button";
import { Card } from "../../card";
import { InlineTotpDisplay } from "../../inline-totp-display";
import { Label } from "../../label";
import { TagInput } from "../../tag-input";
import { DetailHeader, DetailPasswordField } from "./field-components";
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

			<Card>
				<div className="p-6">
					<InlineTotpDisplay
						totpSecret={data.totpSecret}
						totpAlgorithm={data.totpAlgorithm}
						totpDigits={data.totpDigits}
						totpPeriod={data.totpPeriod}
					/>
				</div>
			</Card>

			<div className="space-y-3">
				<DetailPasswordField
					label={m.vaults_detail_items_copy_label_secret_key()}
					value={data.totpSecret}
					maskValue={formatSecretForDisplay(data.totpSecret)}
					copyLabel={m.vaults_detail_items_copy_label_secret_key()}
				/>

				<div className="rounded-lg border p-4">
					<h3 className="mb-3 font-semibold text-sm">
						{m.vaults_detail_items_detail_totp_section_settings()}
					</h3>
					<div className="grid grid-cols-3 gap-4 text-sm">
						<div>
							<Label className="text-muted-foreground text-xs">
								{m.vaults_detail_items_totp_settings_field_algorithm()}
							</Label>
							<p className="font-medium">{data.totpAlgorithm || "SHA-1"}</p>
						</div>
						<div>
							<Label className="text-muted-foreground text-xs">
								{m.vaults_detail_items_totp_settings_field_digits()}
							</Label>
							<p className="font-medium">{data.totpDigits || 6}</p>
						</div>
						<div>
							<Label className="text-muted-foreground text-xs">
								{m.vaults_detail_items_totp_settings_field_period()}
							</Label>
							<p className="font-medium">{data.totpPeriod || 30}s</p>
						</div>
					</div>
				</div>

				{data.notes && (
					<div className="space-y-2">
						<Label className="font-medium text-sm">
							{m.vaults_detail_items_form_field_notes_label()}
						</Label>
						<Card>
							<div className="whitespace-pre-wrap px-4 py-1 text-sm">{data.notes}</div>
						</Card>
					</div>
				)}

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
