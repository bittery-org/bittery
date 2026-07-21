import "./index.css";
import { Button } from "@bittery/ui";
import {
	IconCircleCheck,
	IconCircleX,
	IconLoaderCircle,
	IconLock,
	IconTriangleAlert,
	IconVault,
} from "@bittery/ui/icons";
import { useCallback, useEffect, useState } from "react";
import { Favicon } from "@/components/favicon";
import { mountOverlayApp } from "@/components/overlay/mount";
import {
	OverlayActions,
	OverlayChip,
	OverlayList,
	OverlayNotice,
	OverlayPromptHeader,
	OverlayRow,
	OverlaySurface,
	OverlayViewport,
} from "@/components/overlay/overlay-surface";
import { useOverlayHeight } from "@/components/overlay/use-overlay-height";
import { getIframeNonceFromLocation } from "@/lib/iframe-nonce";
import { useI18n } from "@/providers/i18n-provider";

interface VaultOption {
	id: string;
	name: string;
	type: "personal" | "team";
	role: "owner" | "admin" | "member" | "read-only";
}

interface ExistingCredential {
	id: string;
	vaultId: string;
	username: string;
	url: string;
}

type PromptState = "selecting" | "saving" | "success" | "error";

interface SavePromptData {
	username: string;
	password: string;
	url: string;
	serverUrl?: string;
	vaults: VaultOption[];
	hasDuplicates?: boolean;
	existingCredentials?: ExistingCredential[];
}

// Helper to safely extract hostname from URL
function getHostname(url: string): string {
	try {
		const urlObj = new URL(url.startsWith("http") ? url : `https://${url}`);
		return urlObj.hostname;
	} catch {
		return url;
	}
}

/**
 * Map a stable background `errorType` code to a localized message. Falls
 * back to a generic message when the code is missing or unrecognized.
 */
function getSaveErrorMessage(
	m: ReturnType<typeof useI18n>["m"],
	errorType: string | undefined,
): string {
	switch (errorType) {
		case "network":
			return m.ext_save_error_network();
		case "encryption":
			return m.ext_save_error_encryption();
		case "auth":
			return m.ext_save_error_auth();
		case "permission":
			return m.ext_save_error_permission();
		case "not_found":
			return m.ext_save_error_not_found();
		case "locked":
			return m.ext_save_error_locked();
		case "validation":
			return m.ext_save_error_validation();
		case "vault_key":
			return m.ext_save_error_vault_key();
		case "unknown":
			return m.ext_save_error_unknown();
		default:
			return m.ext_save_error_fallback();
	}
}

function SavePromptIframe() {
	const { m } = useI18n();
	const nonce = getIframeNonceFromLocation() ?? "";
	const [data, setData] = useState<SavePromptData | null>(null);
	const [selectedVaultId, setSelectedVaultId] = useState<string>("");
	const [state, setState] = useState<PromptState>("selecting");
	const [errorMessage, setErrorMessage] = useState<string>("");
	const [isUpdating, setIsUpdating] = useState(false);

	useOverlayHeight(nonce);

	const handleCancel = useCallback(() => {
		window.parent.postMessage({ type: "CANCEL_SAVE", nonce }, "*");
	}, [nonce]);

	useEffect(() => {
		const handleMessage = (event: MessageEvent) => {
			if (event.data?.nonce !== nonce) {
				return;
			}

			if (event.data.type === "SAVE_PROMPT_DATA") {
				const promptData = event.data.data as SavePromptData;
				setData(promptData);
				// Pre-select first writable vault
				const writableVault = promptData.vaults.find(
					(v) => v.role === "owner" || v.role === "admin",
				);
				if (writableVault) {
					setSelectedVaultId(writableVault.id);
				}
				setState("selecting");
			} else if (event.data.type === "SAVE_RESULT") {
				if (event.data.success) {
					setState("success");
					// Auto-close after 2 seconds
					setTimeout(() => {
						handleCancel();
					}, 2000);
				} else {
					setState("error");
					setErrorMessage(getSaveErrorMessage(m, event.data.errorType));
				}
			}
		};

		window.addEventListener("message", handleMessage);

		// Notify parent that iframe is ready
		window.parent.postMessage({ type: "SAVE_IFRAME_READY", nonce }, "*");

		return () => window.removeEventListener("message", handleMessage);
	}, [handleCancel, nonce, m]);

	const submit = (updateExisting: boolean) => {
		if (!data || !selectedVaultId || state === "saving") return;

		setIsUpdating(updateExisting);
		setState("saving");
		setErrorMessage("");

		const existingCred = data.existingCredentials?.[0];
		if (updateExisting && existingCred) {
			window.parent.postMessage(
				{
					type: "UPDATE_EXISTING_CREDENTIAL",
					itemId: existingCred.id,
					vaultId: selectedVaultId,
					username: data.username,
					password: data.password,
					url: data.url,
					nonce,
				},
				"*",
			);
			return;
		}

		window.parent.postMessage(
			{
				type: "SAVE_CREDENTIAL",
				vaultId: selectedVaultId,
				username: data.username,
				password: data.password,
				url: data.url,
				nonce,
			},
			"*",
		);
	};

	if (!data) {
		return <OverlayViewport className="min-h-[56px]" />;
	}

	const selectedVault = data.vaults.find((v) => v.id === selectedVaultId);
	const writableVaults = data.vaults.filter(
		(v) => v.role === "owner" || v.role === "admin",
	);
	const hasWritableVaults = writableVaults.length > 0;

	if (state === "saving") {
		return (
			<OverlayViewport>
				<OverlaySurface>
					<OverlayNotice
						tone="primary"
						icon={<IconLoaderCircle className="size-3.5 animate-spin" />}
						title={isUpdating ? m.ext_save_updating() : m.ext_save_saving()}
						description={selectedVault?.name}
					/>
				</OverlaySurface>
			</OverlayViewport>
		);
	}

	if (state === "success") {
		return (
			<OverlayViewport>
				<OverlaySurface>
					<OverlayNotice
						tone="success"
						icon={<IconCircleCheck className="size-3.5" />}
						title={isUpdating ? m.ext_save_updated() : m.ext_save_saved()}
						description={
							isUpdating
								? m.ext_save_updated_in({ vault: selectedVault?.name ?? "" })
								: m.ext_save_saved_to({ vault: selectedVault?.name ?? "" })
						}
					/>
				</OverlaySurface>
			</OverlayViewport>
		);
	}

	if (state === "error") {
		return (
			<OverlayViewport>
				<OverlaySurface>
					<OverlayNotice
						tone="destructive"
						icon={<IconCircleX className="size-3.5" />}
						title={
							isUpdating ? m.ext_save_failed_update() : m.ext_save_failed_save()
						}
						description={
							<>
								{errorMessage}
								<span className="mt-1 block truncate">
									<span className="font-medium">{data.username}</span> ·{" "}
									{getHostname(data.url)}
								</span>
							</>
						}
					/>
					<OverlayActions>
						<Button
							onClick={() => setState("selecting")}
							variant="outline"
							size="sm"
							className="h-7 flex-1"
						>
							{m.ext_save_try_again()}
						</Button>
						<Button
							onClick={handleCancel}
							variant="ghost"
							size="sm"
							className="h-7 flex-1"
						>
							{m.ext_save_cancel()}
						</Button>
					</OverlayActions>
				</OverlaySurface>
			</OverlayViewport>
		);
	}

	if (!hasWritableVaults) {
		return (
			<OverlayViewport>
				<OverlaySurface>
					<OverlayNotice
						tone="warning"
						icon={<IconLock className="size-3.5" />}
						title={m.ext_save_cannot_save()}
						description={
							<>
								{m.ext_save_no_write_access()}
								<span className="mt-1 block">
									{m.ext_save_permissions_hint()}
								</span>
							</>
						}
					/>
					<OverlayActions>
						<Button
							onClick={handleCancel}
							variant="outline"
							size="sm"
							className="h-7 w-full"
						>
							{m.ext_save_close()}
						</Button>
					</OverlayActions>
				</OverlaySurface>
			</OverlayViewport>
		);
	}

	return (
		<OverlayViewport>
			<OverlaySurface>
				<OverlayPromptHeader
					leading={
						<Favicon
							url={data.url}
							title={data.url}
							serverUrl={data.serverUrl}
							category="login"
							size="sm"
							className="relative size-7 rounded-md"
						/>
					}
					title={
						data.hasDuplicates
							? m.ext_save_update_or_save()
							: m.ext_save_password_question()
					}
					subtitle={`${data.username} · ${getHostname(data.url)}`}
				/>

				{data.hasDuplicates && (
					<div className="mx-3 mb-2 flex items-center gap-1.5 rounded-md border border-warning/30 bg-warning/10 px-2 py-1.5 text-[11px] text-warning">
						<IconTriangleAlert className="size-3 shrink-0" />
						<span className="truncate">{m.ext_save_duplicates_warning()}</span>
					</div>
				)}

				<p className="px-3 pb-1 font-semibold text-[10.5px] text-muted-foreground uppercase tracking-[0.06em]">
					{m.ext_save_to_vault()}
				</p>
				<OverlayList className="max-h-[168px] pt-0">
					{writableVaults.map((vault) => (
						<OverlayRow
							key={vault.id}
							selected={selectedVaultId === vault.id}
							ariaPressed={selectedVaultId === vault.id}
							onSelect={() => setSelectedVaultId(vault.id)}
							leading={
								<span className="flex size-[26px] shrink-0 items-center justify-center rounded-[7px] border bg-foreground/3 text-muted-foreground">
									<IconVault className="size-3.5" />
								</span>
							}
							title={vault.name}
							trailing={<OverlayChip>{vault.type}</OverlayChip>}
						/>
					))}
				</OverlayList>

				<OverlayActions>
					{data.hasDuplicates ? (
						<>
							<Button
								onClick={() => submit(true)}
								disabled={!selectedVaultId}
								size="sm"
								className="h-7 flex-1"
							>
								{m.ext_save_update_existing()}
							</Button>
							<Button
								onClick={() => submit(false)}
								disabled={!selectedVaultId}
								variant="outline"
								size="sm"
								className="h-7 flex-1"
							>
								{m.ext_save_new()}
							</Button>
						</>
					) : (
						<Button
							onClick={() => submit(false)}
							disabled={!selectedVaultId}
							size="sm"
							className="h-7 flex-1"
						>
							{m.ext_save_button()}
						</Button>
					)}
					<Button
						onClick={handleCancel}
						variant="ghost"
						size="sm"
						className="h-7 shrink-0 px-3"
					>
						{m.ext_save_cancel()}
					</Button>
				</OverlayActions>
			</OverlaySurface>
		</OverlayViewport>
	);
}

mountOverlayApp(<SavePromptIframe />);
