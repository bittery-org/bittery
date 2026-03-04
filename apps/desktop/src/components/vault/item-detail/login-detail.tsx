/** biome-ignore-all lint/style/noNonNullAssertion: Thats fine here */

import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	Badge,
	Button,
	Card,
	Label,
} from "@bittery/ui";
import {
	IconCopyOutlineDuo18,
	IconTrash2OutlineDuo18,
	IconTriangleWarningOutlineDuo18,
} from "@bittery/ui/icons";
import { useMemo, useState } from "react";
import { formatDate, formatDateTime } from "../../../lib/i18n-format";
import { useI18n } from "../../../providers/i18n-provider";
import { Favicon } from "../favicon";
import { TagInput } from "../tag-input";
import {
	DetailCustomField,
	DetailField,
	DetailHeader,
	DetailPasswordField,
	DetailUrlField,
} from "./field-components";
import { InlineTotpDisplay } from "./inline-totp-display";
import {
	type CategoryDetailProps,
	handleCopy,
	type LoginDisplayData,
} from "./shared";

function formatPasskeyLastUsed(
	value: string | undefined,
	m: ReturnType<typeof useI18n>["m"],
): string {
	if (!value) {
		return m["vaults.detail.items.detail.login.passkeys.last_used.never"]();
	}

	const timestamp = Date.parse(value);
	if (Number.isNaN(timestamp)) {
		return m["vaults.detail.items.detail.login.passkeys.last_used.recently"]();
	}

	const deltaMs = Date.now() - timestamp;
	const deltaDays = Math.floor(deltaMs / (24 * 60 * 60 * 1000));

	if (deltaDays <= 0) {
		return m["vaults.detail.items.detail.login.passkeys.last_used.today"]();
	}
	if (deltaDays === 1) {
		return m["vaults.detail.items.detail.login.passkeys.last_used.yesterday"]();
	}
	if (deltaDays < 30) {
		return deltaDays === 1
			? m["vaults.detail.items.detail.login.passkeys.last_used.days_ago.single"]({
					count: deltaDays,
				})
			: m["vaults.detail.items.detail.login.passkeys.last_used.days_ago.plural"]({
					count: deltaDays,
				});
	}

	return formatDate(timestamp);
}

function formatStatusDate(
	value: string | undefined,
	m: ReturnType<typeof useI18n>["m"],
): string {
	if (!value) {
		return m["vaults.detail.items.detail.login.passkeys.last_used.recently"]();
	}

	const timestamp = Date.parse(value);
	if (Number.isNaN(timestamp)) {
		return m["vaults.detail.items.detail.login.passkeys.last_used.recently"]();
	}

	return formatDateTime(timestamp);
}

export function LoginDetail({
	data,
	onEdit,
	onDelete,
	onRemovePasskey,
	onTagsChange,
	onTagClick,
	availableTags = [],
	isUpdatingTags,
}: CategoryDetailProps<LoginDisplayData>) {
	const { m } = useI18n();
	const [removingCredentialId, setRemovingCredentialId] = useState<
		string | null
	>(null);
	const [pendingRemoval, setPendingRemoval] = useState<{
		credentialId: string;
		label: string;
	} | null>(null);

	const passkeys = useMemo(() => {
		return [...(data.passkeys ?? [])].sort((left, right) => {
			const leftTs = Date.parse(left.lastUsedAt ?? left.createdAt);
			const rightTs = Date.parse(right.lastUsedAt ?? right.createdAt);
			return rightTs - leftTs;
		});
	}, [data.passkeys]);

	const handleConfirmRemovePasskey = async () => {
		if (!onRemovePasskey) {
			return;
		}
		if (!pendingRemoval) {
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
				<DetailHeader
					icon={
						<Favicon
							url={data.url}
							title={data.title}
							category="login"
							size="lg"
						/>
					}
					title={data.title}
					subtitle={data.url}
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
					<DetailUrlField
						label={m["vaults.detail.items.detail.login.field.website"]()}
						value={data.url}
						copyLabel={m["vaults.detail.items.copy.label.url"]()}
					/>
					<DetailField
						label={m["vaults.detail.items.detail.login.field.username"]()}
						value={data.username}
						copyLabel={m["vaults.detail.items.copy.label.username"]()}
					/>
					<DetailPasswordField
						label={m["vaults.detail.items.detail.login.field.password"]()}
						value={data.password}
						copyLabel={m["vaults.detail.items.copy.label.password"]()}
					/>

					{data.totpSecret && (
						<div className="space-y-2">
							<Label>
								{m["vaults.detail.items.detail.login.field.one_time_password"]()}
							</Label>
							<InlineTotpDisplay
								totpSecret={data.totpSecret}
								totpAlgorithm={data.totpAlgorithm}
								totpDigits={data.totpDigits}
								totpPeriod={data.totpPeriod}
							/>
						</div>
					)}

					{passkeys.length > 0 && (
						<div className="space-y-2">
							<Label className="font-medium text-sm">
								{passkeys.length === 1
									? m[
											"vaults.detail.items.detail.login.passkeys.label.single"
										]({
											count: passkeys.length,
										})
									: m[
											"vaults.detail.items.detail.login.passkeys.label.plural"
										]({
											count: passkeys.length,
										})}
							</Label>
							<div className="space-y-2">
								{passkeys.map((passkey, index) => {
									const displayName =
										passkey.userDisplayName ||
										passkey.userName ||
										m[
											"vaults.detail.items.detail.login.passkeys.item.default_name"
										]();
									const isSuspect = passkey.status === "suspect";
									const isRemoving =
										onRemovePasskey &&
										removingCredentialId === passkey.credentialId;
									return (
										<div
											key={`${passkey.credentialId}-${index}`}
											className="flex items-start justify-between gap-3 rounded-md border px-3 py-2"
										>
											<div className="min-w-0">
												<div className="flex items-center gap-2">
													<p className="truncate font-medium text-sm">
														{displayName}
													</p>
													{isSuspect && (
														<Badge
															variant="outline"
															className="border-destructive/40 text-destructive"
														>
															{m[
																"vaults.detail.items.detail.login.passkeys.item.badge.suspect"
															]()}
														</Badge>
													)}
												</div>
												<p className="truncate text-[11px] text-muted-foreground">
													{passkey.rpId}
													{" \u2022 "}
													{m[
														"vaults.detail.items.detail.login.passkeys.meta.used"
													]({
														time: formatPasskeyLastUsed(
															passkey.lastUsedAt ?? passkey.createdAt,
															m,
														),
													})}
													{" \u2022 "}
													{m[
														"vaults.detail.items.detail.login.passkeys.meta.sign_count"
													]({
														count: passkey.signCount ?? 0,
													})}
												</p>
												{isSuspect && (
													<p className="mt-1 flex items-center gap-1 text-[11px] text-destructive">
														<IconTriangleWarningOutlineDuo18 className="size-3.5 shrink-0" />
														{m[
															"vaults.detail.items.detail.login.passkeys.item.suspect_reason"
														]({
															reason:
																passkey.statusReason ??
																m[
																	"vaults.detail.items.detail.login.passkeys.item.reason_unknown"
																](),
															date: formatStatusDate(
																passkey.statusUpdatedAt,
																m,
															),
														})}
													</p>
												)}
											</div>
											<div className="flex shrink-0 items-center gap-1">
												<Button
													type="button"
													variant="ghost"
													size="icon"
													className="size-7"
													title={
														m[
															"vaults.detail.items.detail.login.passkeys.action.copy_credential_id"
														]()
													}
													onClick={() =>
														handleCopy(
															passkey.credentialId,
															m["vaults.detail.items.copy.label.passkey_id"](),
															m,
														)
													}
												>
													<IconCopyOutlineDuo18 className="size-4" />
												</Button>
												{onRemovePasskey && (
													<Button
														type="button"
														variant="ghost"
														size="icon"
														className="size-7 text-destructive hover:bg-destructive/10 hover:text-destructive"
														title={
															m[
																"vaults.detail.items.detail.login.passkeys.action.remove"
															]()
														}
														disabled={Boolean(isRemoving)}
														onClick={() =>
															setPendingRemoval({
																credentialId: passkey.credentialId,
																label: displayName,
															})
														}
													>
														{isRemoving ? (
															<span className="text-[10px]">...</span>
														) : (
															<IconTrash2OutlineDuo18 className="size-4" />
														)}
													</Button>
												)}
											</div>
										</div>
									);
								})}
							</div>
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

					{data.urls && data.urls.length > 0 && (
						<div className="space-y-3">
							<Label className="font-medium text-sm">
								{m[
									"vaults.detail.items.detail.login.field.additional_websites"
								]()}
							</Label>
							{data.urls.map((url) => (
								<DetailUrlField
									key={url}
									label=""
									value={url}
									copyLabel={m["vaults.detail.items.copy.label.url"]()}
								/>
							))}
						</div>
					)}

					{data.customFields && data.customFields.length > 0 && (
						<div className="space-y-3">
							{data.customFields.map((field) => (
								<DetailCustomField key={field.id} field={field} />
							))}
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
							{m["vaults.detail.items.detail.login.passkeys.remove_dialog.title"]()}
						</AlertDialogTitle>
						<AlertDialogDescription>
							{m[
								"vaults.detail.items.detail.login.passkeys.remove_dialog.description"
							]({
								label: pendingRemoval?.label ?? "",
							})}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={Boolean(removingCredentialId)}>
							{m["vaults.detail.items.detail.action.cancel"]()}
						</AlertDialogCancel>
						<AlertDialogAction
							onClick={handleConfirmRemovePasskey}
							disabled={Boolean(removingCredentialId)}
							className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
						>
							{removingCredentialId
								? m[
										"vaults.detail.items.detail.login.passkeys.remove_dialog.action.removing"
									]()
								: m[
										"vaults.detail.items.detail.login.passkeys.remove_dialog.action.remove"
									]()}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}
