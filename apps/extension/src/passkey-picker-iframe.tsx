import "./index.css";
import { Button, Card, cn } from "@bittery/ui";
import {
	IconCircleCheck2OutlineDuo18,
	IconCircleKeyOutlineDuo18,
	IconClockTimeOutlineDuo18,
	IconEnvelopeOutlineDuo18,
	IconUserOutlineDuo18,
} from "@bittery/ui/icons";
import React, {
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import ReactDOM from "react-dom/client";
import { Favicon } from "@/components/favicon";
import type { PasskeyGetPromptOption } from "@/passkey/types";

type PickerData = {
	kind: "get-picker";
	rpId: string;
	options: PasskeyGetPromptOption[];
};

function formatRelativeTime(value?: string): string {
	if (!value) {
		return "Never used";
	}

	const timestamp = Date.parse(value);
	if (Number.isNaN(timestamp)) {
		return "Used recently";
	}
	const deltaMs = Date.now() - timestamp;
	const deltaDays = Math.floor(deltaMs / (24 * 60 * 60 * 1000));
	if (deltaDays <= 0) {
		return "Used today";
	}
	if (deltaDays === 1) {
		return "Used yesterday";
	}
	if (deltaDays < 30) {
		return `Used ${deltaDays}d ago`;
	}
	const deltaMonths = Math.floor(deltaDays / 30);
	if (deltaMonths < 12) {
		return `Used ${deltaMonths}mo ago`;
	}
	const deltaYears = Math.floor(deltaMonths / 12);
	return `Used ${deltaYears}y ago`;
}

function PasskeyPickerIframe() {
	const [data, setData] = useState<PickerData | null>(null);
	const [selectedCredentialId, setSelectedCredentialId] = useState<string>("");
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
			if (event.data?.type !== "PASSKEY_PICKER_DATA") {
				return;
			}
			const nextData = event.data.data as PickerData;
			setData(nextData);
			setSelectedCredentialId(nextData.options[0]?.credentialId ?? "");
		};

		window.addEventListener("message", handleMessage);
		window.parent.postMessage({ type: "PASSKEY_PICKER_IFRAME_READY" }, "*");
		return () => window.removeEventListener("message", handleMessage);
	}, []);

	const selectedOption = useMemo(
		() =>
			data?.options.find(
				(option) => option.credentialId === selectedCredentialId,
			),
		[data, selectedCredentialId],
	);

	const handleCancel = () => {
		window.parent.postMessage({ type: "PASSKEY_PICKER_CANCEL" }, "*");
	};

	const handleSelect = () => {
		if (!selectedCredentialId) {
			return;
		}
		window.parent.postMessage(
			{
				type: "PASSKEY_PICKER_SELECT",
				credentialId: selectedCredentialId,
			},
			"*",
		);
	};

	if (!data) {
		return <div ref={containerRef} className="min-h-[56px] p-1" />;
	}

	return (
		<div ref={containerRef} className="w-full text-foreground">
			<Card className="gap-2 space-y-3 border border-border/80 bg-card p-3 shadow-sm">
				<div className="flex items-start gap-2.5">
					<div className="mt-0.5 rounded-xl border border-primary/25 bg-primary/10 p-1.5 text-primary shadow-sm">
						<IconCircleKeyOutlineDuo18 size={16} />
					</div>
					<div className="min-w-0 flex-1">
						<div className="flex items-center justify-between gap-2">
							<p className="font-medium text-sm">Choose a passkey</p>
							<span className="shrink-0 rounded-full border border-border bg-background/80 px-2 py-0.5 text-[10px] text-muted-foreground">
								{data.options.length}{" "}
								{data.options.length === 1 ? "option" : "options"}
							</span>
						</div>
						<p className="truncate font-medium text-[11px] text-primary/80">
							{data.rpId}
						</p>
					</div>
				</div>

				<div className="max-h-[228px] space-y-1.5 overflow-y-auto pr-0.5">
					{data.options.length === 0 && (
						<p className="rounded-md border border-border border-dashed px-2.5 py-4 text-center text-muted-foreground text-xs">
							No passkeys available for this site.
						</p>
					)}

					{data.options.map((option) => {
						const isSelected = selectedCredentialId === option.credentialId;
						const displayName =
							option.passkeyUserDisplayName || option.passkeyUserName;
						const username = option.itemUsername || option.passkeyUserName;

						return (
							<button
								key={option.credentialId}
								type="button"
								aria-pressed={isSelected}
								onClick={() => setSelectedCredentialId(option.credentialId)}
								className={cn(
									"group",
									"relative",
									"w-full",
									"overflow-hidden",
									"rounded-lg",
									"border",
									"px-2.5",
									"py-2.5",
									"text-left",
									"transition-all",
									"focus-visible:outline-none",
									"focus-visible:ring-2",
									"focus-visible:ring-primary/35",
									isSelected
										? "border-primary/45 bg-primary/10 shadow-sm"
										: "border-border/80 bg-background/75 hover:border-primary/30 hover:bg-accent/70",
								)}
							>
								<div className="flex items-start gap-2">
									<Favicon
										url={option.itemUrl}
										title={
											option.itemTitle ||
											option.itemUrl ||
											option.passkeyUserName
										}
										category="login"
										size="sm"
									/>
									<div className="min-w-0 flex-1">
										<div className="flex items-start gap-2">
											<p className="truncate font-medium text-xs">
												{displayName}
											</p>
											<span
												className={cn(
													"ml-auto",
													"inline-flex",
													"h-4",
													"w-4",
													"shrink-0",
													"items-center",
													"justify-center",
													"rounded-full",
													"border",
													"transition-colors",
													isSelected
														? "border-primary/40 bg-primary/15 text-primary"
														: "border-border text-transparent",
												)}
											>
												<IconCircleCheck2OutlineDuo18 size={11} />
											</span>
										</div>
										<p className="mt-0.5 truncate text-muted-foreground text-xs">
											{username}
										</p>
										<div className="mt-1.5 flex flex-wrap gap-1 text-[10px]">
											<span
												className={cn(
													"inline-flex",
													"items-center",
													"gap-1",
													"rounded-full",
													"px-1.5",
													"py-0.5",
													isSelected
														? "bg-primary/10 text-primary"
														: "bg-muted/75 text-muted-foreground",
												)}
											>
												<IconUserOutlineDuo18 size={11} />
												{option.vaultName || "Vault"}
											</span>
											<span
												className={cn(
													"inline-flex",
													"items-center",
													"gap-1",
													"rounded-full",
													"px-1.5",
													"py-0.5",
													isSelected
														? "bg-primary/10 text-primary"
														: "bg-muted/75 text-muted-foreground",
												)}
											>
												<IconClockTimeOutlineDuo18 size={11} />
												{formatRelativeTime(
													option.lastUsedAt || option.createdAt,
												)}
											</span>
										</div>
									</div>
								</div>
							</button>
						);
					})}
				</div>

				{selectedOption?.accountEmail && (
					<div className="flex items-center gap-1.5 rounded-md border border-border/70 bg-background/70 px-2 py-1.5 text-muted-foreground text-xs">
						<IconEnvelopeOutlineDuo18 size={12} className="shrink-0" />
						<span className="truncate">{selectedOption.accountEmail}</span>
					</div>
				)}

				<div className="flex gap-2">
					<Button
						onClick={handleSelect}
						size="sm"
						className="flex-1 shadow-sm"
						disabled={!selectedCredentialId}
					>
						Use passkey
					</Button>
					<Button
						onClick={handleCancel}
						variant="ghost"
						size="sm"
						className="flex-1 border border-transparent hover:border-border/80"
					>
						Cancel
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
			<PasskeyPickerIframe />
		</React.StrictMode>,
	);
}
