/**
 * The self-hosting picker: known servers, add a URL, drop one you no longer
 * need. Login, add-account and Settings all open this same sheet so an
 * account's server is chosen in one place.
 */

import { toast } from "@bittery/ui";
import { IconCheck, IconPlus, IconTrash } from "@bittery/ui/icons";
import { cn } from "@bittery/ui/lib/utils";
import { useState } from "react";
import { iconClass, MobileSheet, Pressable, TextField } from "@/components/ui";
import {
	forgetServerUrl,
	getServerLabel,
	readKnownServerUrls,
	setActiveAuthServerUrl,
} from "@/lib/auth-server";
import { useI18n } from "@/providers/i18n-provider";

export function ServerPickerSheet({
	open,
	onOpenChange,
	selectedUrl,
	persistToAccount,
	onSelected,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	selectedUrl: string;
	/**
	 * False on "Add account": another account is still active, and writing
	 * through would re-point it at a host it never signed in to.
	 */
	persistToAccount: boolean;
	onSelected: (serverUrl: string) => void;
}) {
	const { m } = useI18n();
	const [knownServerUrls, setKnownServerUrls] = useState(readKnownServerUrls);
	const [newServerUrl, setNewServerUrl] = useState("");
	const [isSaving, setIsSaving] = useState(false);
	const [wasOpen, setWasOpen] = useState(open);

	if (open !== wasOpen) {
		setWasOpen(open);
		if (open) {
			setKnownServerUrls(readKnownServerUrls());
		} else {
			setNewServerUrl("");
		}
	}

	const refreshKnown = () => {
		setKnownServerUrls(readKnownServerUrls());
	};

	const close = () => {
		setNewServerUrl("");
		onOpenChange(false);
	};

	const apply = async (candidateUrl: string) => {
		const nextServerUrl = await setActiveAuthServerUrl(candidateUrl, {
			persistToAccount,
		});
		if (!nextServerUrl) {
			toast.error(m.toast_auth_server_invalid_url());
			return;
		}

		refreshKnown();
		onSelected(nextServerUrl);
		close();
	};

	const handleAdd = async () => {
		if (isSaving) return;
		setIsSaving(true);
		try {
			await apply(newServerUrl);
		} finally {
			setIsSaving(false);
		}
	};

	const handleOpenChange = (nextOpen: boolean) => {
		if (nextOpen) {
			refreshKnown();
		} else {
			setNewServerUrl("");
		}
		onOpenChange(nextOpen);
	};

	return (
		<MobileSheet
			open={open}
			onOpenChange={handleOpenChange}
			title={m.mob_server_picker_title()}
			description={m.mob_server_picker_description()}
		>
			<div className="flex flex-col gap-4 px-4 pt-1 pb-6">
				{knownServerUrls.length > 0 ? (
					<div className="flex flex-col">
						{knownServerUrls.map((serverUrl) => {
							const isSelected = serverUrl === selectedUrl;
							return (
								<div key={serverUrl} className="flex items-center gap-1">
									<Pressable
										surface="sheet"
										onClick={() => void apply(serverUrl)}
										className={cn(
											"flex h-12 min-w-0 flex-1 items-center gap-3 rounded-xl px-3",
											isSelected && "bg-selected",
										)}
									>
										<span className="min-w-0 flex-1 truncate text-left font-medium text-base text-foreground">
											{getServerLabel(serverUrl)}
										</span>
										{isSelected ? (
											<IconCheck
												className={cn(iconClass.row, "shrink-0 text-primary")}
											/>
										) : null}
									</Pressable>
									{isSelected ? null : (
										<Pressable
											surface="sheet"
											onClick={() => {
												setKnownServerUrls(forgetServerUrl(serverUrl));
											}}
											aria-label={m.mob_server_picker_remove()}
											className="flex size-11 shrink-0 items-center justify-center rounded-xl text-muted-foreground"
										>
											<IconTrash className={iconClass.row} />
										</Pressable>
									)}
								</div>
							);
						})}
					</div>
				) : null}

				<form
					onSubmit={(event) => {
						event.preventDefault();
						void handleAdd();
					}}
					className="flex flex-col gap-3"
				>
					<TextField
						id="new-server-url"
						label={m.login_server_url_label()}
						description={m.login_server_url_description()}
						type="url"
						value={newServerUrl}
						onChange={(event) => setNewServerUrl(event.target.value)}
						placeholder={m.login_server_url_placeholder()}
						inputMode="url"
						autoCapitalize="none"
						autoCorrect="off"
						autoComplete="off"
						inputClassName="font-mono text-sm"
					/>
					<Pressable
						onClick={() => void handleAdd()}
						disabled={isSaving || newServerUrl.trim().length === 0}
						scale
						haptic={false}
						className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-primary font-semibold text-base text-primary-foreground"
					>
						<IconPlus className={iconClass.row} />
						{m.mob_server_picker_add()}
					</Pressable>
				</form>
			</div>
		</MobileSheet>
	);
}
