import "./index.css";
import { Button, cn } from "@bittery/ui";
import { IconFolder, IconPasskey, IconPlus, IconUser } from "@bittery/ui/icons";
import { useEffect, useState } from "react";
import { Favicon } from "@/components/favicon";
import { mountOverlayApp } from "@/components/overlay/mount";
import {
	OverlayActions,
	OverlayChip,
	OverlayList,
	OverlayPromptHeader,
	OverlayRow,
	OverlaySurface,
	OverlayViewport,
} from "@/components/overlay/overlay-surface";
import { useOverlayHeight } from "@/components/overlay/use-overlay-height";
import type {
	PasskeyCreateSaveDecision,
	PasskeyUserInteractionRequest,
} from "@/passkey/types";
import { useI18n } from "@/providers/i18n-provider";

type SaveTargetData = Extract<
	PasskeyUserInteractionRequest,
	{ kind: "create-save-target" }
>;

type SaveMode = "attach-existing" | "create-new";

/** Two-way segmented control following the selection recipe. */
function ModeSwitch({
	mode,
	onChange,
	options,
}: {
	mode: SaveMode;
	onChange: (next: SaveMode) => void;
	options: Array<{ value: SaveMode; label: string; icon: React.ReactNode }>;
}) {
	return (
		<div className="mx-3 flex gap-0.5 rounded-md border bg-foreground/3 p-0.5">
			{options.map((option) => {
				const isActive = mode === option.value;
				return (
					<button
						key={option.value}
						type="button"
						onClick={() => onChange(option.value)}
						className={cn(
							"flex flex-1 items-center justify-center gap-1.5 rounded-[5px] px-2 py-1 text-[11.5px] transition-colors",
							isActive
								? "bg-selected text-foreground shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-primary)_14%,transparent)]"
								: "text-muted-foreground hover:bg-overlay hover:text-foreground",
						)}
					>
						{option.icon}
						<span className="truncate">{option.label}</span>
					</button>
				);
			})}
		</div>
	);
}

function PasskeySaveTargetIframe() {
	const { m } = useI18n();
	const [data, setData] = useState<SaveTargetData | null>(null);
	const [mode, setMode] = useState<SaveMode>("create-new");
	const [selectedItemId, setSelectedItemId] = useState<string>("");
	const [selectedVaultId, setSelectedVaultId] = useState<string>("");

	useOverlayHeight("");

	useEffect(() => {
		const handleMessage = (event: MessageEvent) => {
			if (event.data?.type !== "PASSKEY_SAVE_TARGET_DATA") {
				return;
			}
			const nextData = event.data.data as SaveTargetData;
			setData(nextData);
			const firstExisting = nextData.existingItems[0];
			const firstVault = nextData.writableVaults[0];
			if (firstExisting) {
				setMode("attach-existing");
				setSelectedItemId(firstExisting.itemId);
			} else {
				setMode("create-new");
				setSelectedItemId("");
			}
			setSelectedVaultId(firstVault?.id ?? "");
		};

		window.addEventListener("message", handleMessage);
		window.parent.postMessage(
			{ type: "PASSKEY_SAVE_TARGET_IFRAME_READY" },
			"*",
		);
		return () => window.removeEventListener("message", handleMessage);
	}, []);

	const handleCancel = () => {
		window.parent.postMessage({ type: "PASSKEY_SAVE_TARGET_CANCEL" }, "*");
	};

	const handleSubmit = () => {
		if (!data) {
			return;
		}

		let decision: PasskeyCreateSaveDecision | null = null;
		if (mode === "attach-existing") {
			if (!selectedItemId) {
				return;
			}
			decision = {
				action: "attach-existing",
				itemId: selectedItemId,
			};
		} else {
			if (data.writableVaults.length === 0) {
				return;
			}
			decision = {
				action: "create-new",
				vaultId: selectedVaultId || data.writableVaults[0]?.id,
			};
		}

		window.parent.postMessage(
			{
				type: "PASSKEY_SAVE_TARGET_SUBMIT",
				decision,
			},
			"*",
		);
	};

	if (!data) {
		return <OverlayViewport className="min-h-[64px]" />;
	}

	const canAttachExisting = data.existingItems.length > 0;
	const canCreateNew = data.writableVaults.length > 0;
	const hasTarget = canAttachExisting || canCreateNew;

	return (
		<OverlayViewport>
			<OverlaySurface>
				<OverlayPromptHeader
					icon={<IconPasskey className="size-3.5" />}
					title={m.ext_passkey_save_title()}
					subtitle={`${data.userDisplayName || data.userName} · ${data.rpId}`}
				/>

				{canAttachExisting && canCreateNew && (
					<ModeSwitch
						mode={mode}
						onChange={setMode}
						options={[
							{
								value: "attach-existing",
								label: m.ext_passkey_save_attach(),
								icon: <IconUser className="size-3" />,
							},
							{
								value: "create-new",
								label: m.ext_passkey_save_create_new(),
								icon: <IconPlus className="size-3" />,
							},
						]}
					/>
				)}

				{!hasTarget && (
					<p className="px-3 pb-3 text-[11.5px] text-muted-foreground">
						{m.ext_passkey_save_no_target()}
					</p>
				)}

				{hasTarget && mode === "attach-existing" && canAttachExisting && (
					<OverlayList className="max-h-[212px]">
						{data.existingItems.map((item) => (
							<OverlayRow
								key={item.itemId}
								selected={selectedItemId === item.itemId}
								ariaPressed={selectedItemId === item.itemId}
								onSelect={() => setSelectedItemId(item.itemId)}
								leading={
									<Favicon
										url={item.itemUrl}
										title={item.itemTitle || item.itemUrl || data.rpName}
										serverUrl={item.serverUrl}
										category="login"
										size="sm"
										className="size-[26px] rounded-[7px]"
									/>
								}
								title={item.itemTitle || item.itemUrl || data.rpName}
								subtitle={item.itemUsername || data.userName}
								details={
									<>
										<OverlayChip>
											<IconFolder className="size-2.5" />
											{item.vaultName || m.ext_passkey_save_vault_fallback()}
										</OverlayChip>
										{item.accountEmail && (
											<OverlayChip>{item.accountEmail}</OverlayChip>
										)}
									</>
								}
							/>
						))}
					</OverlayList>
				)}

				{hasTarget && mode === "create-new" && canCreateNew && (
					<>
						<p className="px-3 pt-2.5 pb-1 font-semibold text-[10.5px] text-muted-foreground uppercase tracking-[0.06em]">
							{m.ext_passkey_save_to_vault()}
						</p>
						<OverlayList className="max-h-[196px] pt-0">
							{data.writableVaults.map((vault) => (
								<OverlayRow
									key={vault.id}
									selected={selectedVaultId === vault.id}
									ariaPressed={selectedVaultId === vault.id}
									onSelect={() => setSelectedVaultId(vault.id)}
									leading={
										<span className="flex size-[26px] shrink-0 items-center justify-center rounded-[7px] border bg-foreground/3 text-muted-foreground">
											<IconFolder className="size-3.5" />
										</span>
									}
									title={vault.name}
									trailing={<OverlayChip>{vault.type}</OverlayChip>}
								/>
							))}
						</OverlayList>
					</>
				)}

				<OverlayActions>
					<Button
						onClick={handleSubmit}
						size="sm"
						className="h-7 flex-1"
						disabled={
							!hasTarget ||
							(mode === "attach-existing" && !selectedItemId) ||
							(mode === "create-new" && !canCreateNew)
						}
					>
						{m.ext_passkey_save_continue()}
					</Button>
					<Button
						onClick={handleCancel}
						variant="ghost"
						size="sm"
						className="h-7 flex-1"
					>
						{m.ext_passkey_save_cancel()}
					</Button>
				</OverlayActions>
			</OverlaySurface>
		</OverlayViewport>
	);
}

mountOverlayApp(<PasskeySaveTargetIframe />);
