import "./index.css";
import { Button, Card, cn } from "@bittery/ui";
import {
	IconCircleKeyOutlineDuo18,
	IconFolderOutlineDuo18,
	IconPlusOutlineDuo18,
	IconUserOutlineDuo18,
} from "@bittery/ui/icons";
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import { Favicon } from "@/components/favicon";
import type {
	PasskeyCreateSaveDecision,
	PasskeyUserInteractionRequest,
} from "@/passkey/types";
import { I18nProvider, useI18n } from "@/providers/i18n-provider";

type SaveTargetData = Extract<
	PasskeyUserInteractionRequest,
	{ kind: "create-save-target" }
>;

type SaveMode = "attach-existing" | "create-new";

function PasskeySaveTargetIframe() {
	const { m } = useI18n();
	const [data, setData] = useState<SaveTargetData | null>(null);
	const [mode, setMode] = useState<SaveMode>("create-new");
	const [selectedItemId, setSelectedItemId] = useState<string>("");
	const [selectedVaultId, setSelectedVaultId] = useState<string>("");
	const containerRef = useRef<HTMLDivElement>(null);

	const updateHeight = React.useCallback(() => {
		const height = document.body.scrollHeight;
		window.parent.postMessage({ type: "RESIZE_IFRAME", height }, "*");
	}, []);

	useLayoutEffect(() => {
		updateHeight();
		const observer = new ResizeObserver(() => updateHeight());
		if (document.body) {
			observer.observe(document.body);
		}
		if (containerRef.current) {
			observer.observe(containerRef.current);
		}
		return () => observer.disconnect();
	}, [updateHeight]);

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
		return <div ref={containerRef} className="min-h-[56px] p-1" />;
	}

	const canAttachExisting = data.existingItems.length > 0;
	const canCreateNew = data.writableVaults.length > 0;
	const selectedVault = data.writableVaults.find(
		(vault) => vault.id === selectedVaultId,
	);

	return (
		<div ref={containerRef} className="w-full text-foreground">
			<Card className="space-y-3 p-3">
				<div className="flex items-start gap-2.5">
					<div className="mt-0.5 rounded-full bg-primary/10 p-1.5 text-primary">
						<IconCircleKeyOutlineDuo18 size={16} />
					</div>
					<div className="min-w-0 flex-1">
						<p className="font-medium text-sm">{m.ext_passkey_save_title()}</p>
						<p className="truncate text-muted-foreground text-xs">
							{data.userDisplayName || data.userName} on {data.rpId}
						</p>
					</div>
				</div>

				{canAttachExisting && (
					<div className="space-y-1">
						<button
							type="button"
							onClick={() => setMode("attach-existing")}
							className={cn(
								"flex",
								"w-full",
								"items-center",
								"justify-between",
								"rounded-md",
								"border",
								"px-2.5",
								"py-2",
								"text-left",
								"transition-colors",
								mode === "attach-existing"
									? "border-primary bg-primary/5"
									: "border-border hover:bg-accent/70",
							)}
						>
							<span className="flex items-center gap-2 text-xs">
								<IconUserOutlineDuo18 size={14} />
							{m.ext_passkey_save_attach()}
							</span>
							<span className="text-[10px] text-muted-foreground">
								{data.existingItems.length}
							</span>
						</button>
						<div className="max-h-[180px] space-y-1 overflow-y-auto">
							{data.existingItems.map((item) => (
								<button
									key={item.itemId}
									type="button"
									onClick={() => {
										setMode("attach-existing");
										setSelectedItemId(item.itemId);
									}}
									className={cn(
										"w-full",
										"rounded-md",
										"border",
										"px-2",
										"py-2",
										"text-left",
										"transition-colors",
										mode === "attach-existing" && selectedItemId === item.itemId
											? "border-primary bg-primary/5"
											: "border-border hover:bg-accent/70",
									)}
								>
									<div className="flex items-start gap-2">
										<Favicon
											url={item.itemUrl}
											title={item.itemTitle || item.itemUrl || data.rpName}
											serverUrl={item.serverUrl}
											category="login"
											size="sm"
										/>
										<div className="min-w-0 flex-1">
											<p className="truncate font-medium text-xs">
												{item.itemTitle || item.itemUrl || data.rpName}
											</p>
											<p className="truncate text-muted-foreground text-xs">
												{item.itemUsername || data.userName}
											</p>
											<p className="truncate text-[10px] text-muted-foreground">
												{item.vaultName || m.ext_passkey_save_vault_fallback()}
												{item.accountEmail ? ` • ${item.accountEmail}` : ""}
											</p>
										</div>
									</div>
								</button>
							))}
						</div>
					</div>
				)}

				{canCreateNew && (
					<div className="space-y-1">
						<button
							type="button"
							onClick={() => setMode("create-new")}
							className={cn(
								"flex",
								"w-full",
								"items-center",
								"justify-between",
								"rounded-md",
								"border",
								"px-2.5",
								"py-2",
								"text-left",
								"transition-colors",
								mode === "create-new"
									? "border-primary bg-primary/5"
									: "border-border hover:bg-accent/70",
							)}
						>
							<span className="flex items-center gap-2 text-xs">
								<IconPlusOutlineDuo18 size={14} />
							{m.ext_passkey_save_create_new()}
						</span>
						<span className="text-[10px] text-muted-foreground">
							{selectedVault?.name || m.ext_passkey_save_select_vault()}
							</span>
						</button>
						{mode === "create-new" && (
							<div className="space-y-1 rounded-md border p-2">
								<p className="text-muted-foreground text-xs">{m.ext_passkey_save_to_vault()}</p>
								<div className="space-y-1">
									{data.writableVaults.map((vault) => (
										<button
											key={vault.id}
											type="button"
											onClick={() => setSelectedVaultId(vault.id)}
											className={cn(
												"flex",
												"w-full",
												"items-center",
												"gap-2",
												"rounded-md",
												"px-2",
												"py-1.5",
												"text-left",
												"text-xs",
												"transition-colors",
												selectedVaultId === vault.id
													? "bg-accent text-accent-foreground"
													: "hover:bg-accent/70",
											)}
										>
											<IconFolderOutlineDuo18 size={14} />
											<span className="truncate">{vault.name}</span>
											<span className="ml-auto text-[10px] text-muted-foreground">
												{vault.type}
											</span>
										</button>
									))}
								</div>
							</div>
						)}
					</div>
				)}

				{!canAttachExisting && !canCreateNew && (
					<p className="text-muted-foreground text-xs">
						No writable target available for this passkey.
					</p>
				)}

				<div className="flex gap-2">
					<Button
						onClick={handleSubmit}
						size="sm"
						className="flex-1"
						disabled={
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
						className="flex-1"
					>
						{m.ext_passkey_save_cancel()}
					</Button>
				</div>
			</Card>
		</div>
	);
}

const root = document.getElementById("root");
if (root) {
	ReactDOM.createRoot(root).render(
		<React.StrictMode>
			<I18nProvider>
				<PasskeySaveTargetIframe />
			</I18nProvider>
		</React.StrictMode>,
	);
}
