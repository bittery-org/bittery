import type { CompiledMessages } from "@bittery/i18n";
import { useI18n } from "@bittery/i18n/react";
import { useMemo, useState } from "react";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "../../alert-dialog";
import { Badge } from "../../badge";
import { Button } from "../../button";
import { Label } from "../../label";
import { InlineTotpDisplay } from "../../inline-totp-display";
import { TagInput } from "../../tag-input";
import { IconCopy, IconTrash, IconTriangleAlert } from "../../../icons";
import {
	DetailCustomField,
	DetailField,
	DetailFieldActionButton,
	DetailFieldGroup,
	DetailGroupLabel,
	DetailHeader,
	DetailNoteField,
	DetailPasswordField,
	DetailRow,
	DetailUrlField,
} from "./field-components";
import { type CategoryDetailProps, handleCopy, type LoginDisplayData } from "./shared";

function formatPasskeyLastUsed(
	value: string | undefined,
	m: CompiledMessages,
): string {
	if (!value) {
		return m.vaults_detail_items_detail_login_passkeys_last_used_never();
	}

	const timestamp = Date.parse(value);
	if (Number.isNaN(timestamp)) {
		return m.vaults_detail_items_detail_login_passkeys_last_used_recently();
	}

	const deltaMs = Date.now() - timestamp;
	const deltaDays = Math.floor(deltaMs / (24 * 60 * 60 * 1000));

	if (deltaDays <= 0) {
		return m.vaults_detail_items_detail_login_passkeys_last_used_today();
	}
	if (deltaDays === 1) {
		return m.vaults_detail_items_detail_login_passkeys_last_used_yesterday();
	}
	if (deltaDays < 30) {
		return deltaDays === 1
			? m.vaults_detail_items_detail_login_passkeys_last_used_days_ago_single({ count: deltaDays })
			: m.vaults_detail_items_detail_login_passkeys_last_used_days_ago_plural({ count: deltaDays });
	}

	return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(timestamp);
}

function formatStatusDate(
	value: string | undefined,
	m: CompiledMessages,
): string {
	if (!value) {
		return m.vaults_detail_items_detail_login_passkeys_last_used_recently();
	}

	const timestamp = Date.parse(value);
	if (Number.isNaN(timestamp)) {
		return m.vaults_detail_items_detail_login_passkeys_last_used_recently();
	}

	return new Intl.DateTimeFormat(undefined, {
		dateStyle: "medium",
		timeStyle: "short",
	}).format(timestamp);
}

export function LoginDetail({
	data,
	icon,
	onEdit,
	onDelete,
	onRemovePasskey,
	onTagsChange,
	onTagClick,
	availableTags = [],
	isUpdatingTags,
	onOpenUrl,
}: CategoryDetailProps<LoginDisplayData>) {
	const { m } = useI18n();
	const [removingCredentialId, setRemovingCredentialId] = useState<string | null>(null);
	const [pendingRemoval, setPendingRemoval] = useState<{ credentialId: string; label: string } | null>(null);

	const passkeys = useMemo(() => {
		return [...(data.passkeys ?? [])].sort((left, right) => {
			const leftTs = Date.parse(left.lastUsedAt ?? left.createdAt);
			const rightTs = Date.parse(right.lastUsedAt ?? right.createdAt);
			return rightTs - leftTs;
		});
	}, [data.passkeys]);

	const handleConfirmRemovePasskey = async () => {
		if (!onRemovePasskey || !pendingRemoval) {
			return;
		}

		let removed = false;
		try {
			setRemovingCredentialId(pendingRemoval.credentialId);
			await onRemovePasskey(pendingRemoval.credentialId);
			removed = true;
		} finally {
			setRemovingCredentialId((current) =>
				current === pendingRemoval.credentialId ? null : current,
			);
			if (removed) {
				setPendingRemoval(null);
			}
		}
	};

	return (
		<>
			<div className="space-y-4">
				<DetailHeader icon={icon} title={data.title} subtitle={data.url} />

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
						<DetailUrlField
							label={m.vaults_detail_items_detail_login_field_website()}
							value={data.url}
							copyLabel={m.vaults_detail_items_copy_label_url()}
							onOpenUrl={onOpenUrl}
						/>
						<DetailField
							label={m.vaults_detail_items_detail_login_field_username()}
							value={data.username}
							copyLabel={m.vaults_detail_items_copy_label_username()}
						/>
						<DetailPasswordField
							label={m.vaults_detail_items_detail_login_field_password()}
							value={data.password}
							copyLabel={m.vaults_detail_items_copy_label_password()}
						/>

						{data.totpSecret && (
							<InlineTotpDisplay
								totpSecret={data.totpSecret}
								totpAlgorithm={data.totpAlgorithm}
								totpDigits={data.totpDigits}
								totpPeriod={data.totpPeriod}
							/>
						)}
					</DetailFieldGroup>

					{passkeys.length > 0 && (
						<div>
							<DetailGroupLabel>
								{passkeys.length === 1
									? m.vaults_detail_items_detail_login_passkeys_label_single({ count: passkeys.length })
									: m.vaults_detail_items_detail_login_passkeys_label_plural({ count: passkeys.length })}
							</DetailGroupLabel>
							<DetailFieldGroup>
								{passkeys.map((passkey, index) => {
									const displayName =
										passkey.userDisplayName ||
										passkey.userName ||
										m.vaults_detail_items_detail_login_passkeys_item_default_name();
									const isSuspect = passkey.status === "suspect";
									const isRemoving =
										Boolean(onRemovePasskey) &&
										removingCredentialId === passkey.credentialId;

									return (
										<DetailRow
											key={`${passkey.credentialId}-${index}`}
											align="start"
											actions={
												<>
													<DetailFieldActionButton
														title={m.vaults_detail_items_detail_login_passkeys_action_copy_credential_id()}
														onClick={() =>
															handleCopy(
																passkey.credentialId,
																m.vaults_detail_items_copy_label_passkey_id(),
																m,
															)
														}
													>
														<IconCopy className="size-4" />
													</DetailFieldActionButton>
													{onRemovePasskey && (
														<DetailFieldActionButton
															className="text-destructive hover:bg-destructive/10 hover:text-destructive"
															title={m.vaults_detail_items_detail_login_passkeys_action_remove()}
															disabled={isRemoving}
															onClick={() =>
																setPendingRemoval({ credentialId: passkey.credentialId, label: displayName })
															}
														>
															{isRemoving ? (
																<span className="text-[10px]">...</span>
															) : (
																<IconTrash className="size-4" />
															)}
														</DetailFieldActionButton>
													)}
												</>
											}
										>
											<div className="min-w-0">
												<div className="flex items-center gap-2">
													<p className="truncate text-sm text-foreground">{displayName}</p>
													{isSuspect && (
														<Badge variant="outline" className="border-destructive/40 text-destructive">
															{m.vaults_detail_items_detail_login_passkeys_item_badge_suspect()}
														</Badge>
													)}
												</div>
												<p className="truncate text-[11px] text-muted-foreground">
													{passkey.rpId}
													{" • "}
													{m.vaults_detail_items_detail_login_passkeys_meta_used({
														time: formatPasskeyLastUsed(passkey.lastUsedAt ?? passkey.createdAt, m),
													})}
													{" • "}
													{m.vaults_detail_items_detail_login_passkeys_meta_sign_count({
														count: passkey.signCount ?? 0,
													})}
												</p>
												{isSuspect && (
													<p className="mt-1 flex items-center gap-1 text-[11px] text-destructive">
														<IconTriangleAlert className="size-3.5 shrink-0" />
														{m.vaults_detail_items_detail_login_passkeys_item_suspect_reason({
															reason:
																passkey.statusReason ||
																m.vaults_detail_items_detail_login_passkeys_item_reason_unknown(),
															date: formatStatusDate(passkey.statusUpdatedAt, m),
														})}
													</p>
												)}
											</div>
										</DetailRow>
									);
								})}
							</DetailFieldGroup>
						</div>
					)}

					<DetailNoteField
						label={m.vaults_detail_items_form_field_notes_label()}
						value={data.notes}
					/>

					{data.urls && data.urls.length > 0 && (
						<div>
							<DetailGroupLabel>
								{m.vaults_detail_items_detail_login_field_additional_websites()}
							</DetailGroupLabel>
							<DetailFieldGroup>
								{data.urls.map((url) => (
									<DetailUrlField
										key={url}
										label=""
										value={url}
										copyLabel={m.vaults_detail_items_copy_label_url()}
										onOpenUrl={onOpenUrl}
									/>
								))}
							</DetailFieldGroup>
						</div>
					)}

					{data.customFields && data.customFields.length > 0 && (
						<DetailFieldGroup>
							{data.customFields.map((field) => (
								<DetailCustomField key={field.id} field={field} onOpenUrl={onOpenUrl} />
							))}
						</DetailFieldGroup>
					)}
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

			<AlertDialog
				open={Boolean(pendingRemoval)}
				onOpenChange={(open) => {
					if (!open && !removingCredentialId) {
						setPendingRemoval(null);
					}
				}}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							{m.vaults_detail_items_detail_login_passkeys_remove_dialog_title()}
						</AlertDialogTitle>
						<AlertDialogDescription>
							{m.vaults_detail_items_detail_login_passkeys_remove_dialog_description({
								label: pendingRemoval?.label ?? "",
							})}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={Boolean(removingCredentialId)}>
							{m.vaults_detail_items_detail_action_cancel()}
						</AlertDialogCancel>
						<AlertDialogAction
							onClick={handleConfirmRemovePasskey}
							disabled={Boolean(removingCredentialId)}
							className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
						>
							{removingCredentialId
								? m.vaults_detail_items_detail_login_passkeys_remove_dialog_action_removing()
								: m.vaults_detail_items_detail_login_passkeys_remove_dialog_action_remove()}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}
