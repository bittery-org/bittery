import "./index.css";
import { Button, Card } from "@bittery/ui";
import {
	IconCircleKeyOutlineDuo18,
	IconClockTimeOutlineDuo18,
	IconUserOutlineDuo18,
} from "@bittery/ui/icons";
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
		() => data?.options.find((option) => option.credentialId === selectedCredentialId),
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
			<Card className="space-y-3 p-3">
				<div className="flex items-start gap-2.5">
					<div className="mt-0.5 rounded-full bg-primary/10 p-1.5 text-primary">
						<IconCircleKeyOutlineDuo18 size={16} />
					</div>
					<div className="min-w-0 flex-1">
						<p className="font-medium text-sm">Choose a passkey</p>
						<p className="truncate text-muted-foreground text-xs">{data.rpId}</p>
					</div>
				</div>

				<div className="max-h-[228px] space-y-1 overflow-y-auto">
					{data.options.map((option) => (
						<button
							key={option.credentialId}
							type="button"
							onClick={() => setSelectedCredentialId(option.credentialId)}
							className={`w-full rounded-md border px-2.5 py-2 text-left transition-colors ${
								selectedCredentialId === option.credentialId
									? "border-primary bg-primary/5"
									: "border-border hover:bg-accent/70"
							}`}
						>
							<div className="flex items-start gap-2">
								<Favicon
									url={option.itemUrl}
									title={option.itemTitle || option.itemUrl || option.passkeyUserName}
									category="login"
									size="sm"
								/>
								<div className="min-w-0 flex-1">
									<p className="truncate font-medium text-xs">
										{option.passkeyUserDisplayName || option.passkeyUserName}
									</p>
									<p className="truncate text-muted-foreground text-xs">
										{option.itemUsername || option.passkeyUserName}
									</p>
									<div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground">
										<span className="flex items-center gap-1">
											<IconUserOutlineDuo18 size={12} />
											{option.vaultName || "Vault"}
										</span>
										<span className="flex items-center gap-1">
											<IconClockTimeOutlineDuo18 size={12} />
											{formatRelativeTime(option.lastUsedAt || option.createdAt)}
										</span>
									</div>
								</div>
							</div>
						</button>
					))}
				</div>

				{selectedOption?.accountEmail && (
					<p className="truncate text-muted-foreground text-xs">
						Account: {selectedOption.accountEmail}
					</p>
				)}

				<div className="flex gap-2">
					<Button onClick={handleSelect} size="sm" className="flex-1">
						Use passkey
					</Button>
					<Button onClick={handleCancel} variant="ghost" size="sm" className="flex-1">
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
