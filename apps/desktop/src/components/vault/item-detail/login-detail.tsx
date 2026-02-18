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

function formatPasskeyLastUsed(value?: string): string {
	if (!value) {
		return "never";
	}

	const timestamp = Date.parse(value);
	if (Number.isNaN(timestamp)) {
		return "recently";
	}

	const deltaMs = Date.now() - timestamp;
	const deltaDays = Math.floor(deltaMs / (24 * 60 * 60 * 1000));

	if (deltaDays <= 0) return "today";
	if (deltaDays === 1) return "yesterday";
	if (deltaDays < 30) return `${deltaDays}d ago`;

	return new Date(timestamp).toLocaleDateString();
}

function formatStatusDate(value?: string): string {
	if (!value) {
		return "recently";
	}

	const timestamp = Date.parse(value);
	if (Number.isNaN(timestamp)) {
		return "recently";
	}

	return new Date(timestamp).toLocaleString();
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

				<div className="space-y-3">
					<DetailUrlField label="Website" value={data.url} />
					<DetailField label="Username" value={data.username} />
					<DetailPasswordField label="Password" value={data.password} />

					{data.totpSecret && (
						<div className="space-y-2">
							<Label>One-Time Password</Label>
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
								Passkeys ({passkeys.length})
							</Label>
							<div className="space-y-2">
								{passkeys.map((passkey, index) => {
									const displayName =
										passkey.userDisplayName || passkey.userName || "Passkey";
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
															Suspect
														</Badge>
													)}
												</div>
												<p className="truncate text-[11px] text-muted-foreground">
													{passkey.rpId}
													{" \u2022 "}
													used{" "}
													{formatPasskeyLastUsed(
														passkey.lastUsedAt ?? passkey.createdAt,
													)}
													{" \u2022 "}#{passkey.signCount ?? 0}
												</p>
												{isSuspect && (
													<p className="mt-1 flex items-center gap-1 text-[11px] text-destructive">
														<IconTriangleWarningOutlineDuo18 className="size-3.5 shrink-0" />
														Marked after extension sign-in failure (
														{passkey.statusReason ?? "unknown"}){" "}
														{formatStatusDate(passkey.statusUpdatedAt)}
													</p>
												)}
											</div>
											<div className="flex shrink-0 items-center gap-1">
												<Button
													type="button"
													variant="ghost"
													size="icon"
													className="size-7"
													title="Copy passkey credential ID"
													onClick={() =>
														handleCopy(passkey.credentialId, "Passkey ID")
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
														title="Remove passkey"
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
							<Label className="font-medium text-sm">Notes</Label>
							<Card>
								<div className="whitespace-pre-wrap px-4 py-1 text-sm">
									{data.notes}
								</div>
							</Card>
						</div>
					)}

					{data.urls && data.urls.length > 0 && (
						<div className="space-y-3">
							<Label className="font-medium text-sm">Additional Websites</Label>
							{data.urls.map((url) => (
								<DetailUrlField key={url} label="" value={url} />
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
						<AlertDialogTitle>Remove Passkey</AlertDialogTitle>
						<AlertDialogDescription>
							Remove "{pendingRemoval?.label}" from this login? This only
							removes it from Bittery.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={Boolean(removingCredentialId)}>
							Cancel
						</AlertDialogCancel>
						<AlertDialogAction
							onClick={handleConfirmRemovePasskey}
							disabled={Boolean(removingCredentialId)}
							className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
						>
							{removingCredentialId ? "Removing..." : "Remove"}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}
