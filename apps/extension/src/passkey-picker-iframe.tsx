import "./index.css";
import { Button } from "@bittery/ui";
import {
	IconCheck,
	IconClock,
	IconMail,
	IconPasskey,
	IconVault,
} from "@bittery/ui/icons";
import { useCallback, useEffect, useMemo, useState } from "react";
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
import type { PasskeyGetPromptOption } from "@/passkey/types";
import { useI18n } from "@/providers/i18n-provider";

type PickerData = {
	kind: "get-picker";
	rpId: string;
	options: PasskeyGetPromptOption[];
};

function PasskeyPickerIframe() {
	const { m } = useI18n();
	const [data, setData] = useState<PickerData | null>(null);
	const [selectedCredentialId, setSelectedCredentialId] = useState<string>("");

	// The passkey prompt protocol predates the nonce handshake used by the
	// autofill overlays; the parent matches on `event.source` instead.
	useOverlayHeight("");

	const formatRelativeTime = useCallback(
		(value?: string): string => {
			if (!value) {
				return m.ext_passkey_never_used();
			}

			const timestamp = Date.parse(value);
			if (Number.isNaN(timestamp)) {
				return m.ext_passkey_used_recently();
			}
			const deltaMs = Date.now() - timestamp;
			const deltaDays = Math.floor(deltaMs / (24 * 60 * 60 * 1000));
			if (deltaDays <= 0) {
				return m.ext_passkey_used_today();
			}
			if (deltaDays === 1) {
				return m.ext_passkey_used_yesterday();
			}
			if (deltaDays < 30) {
				return m.ext_passkey_used_days_ago({ days: String(deltaDays) });
			}
			const deltaMonths = Math.floor(deltaDays / 30);
			if (deltaMonths < 12) {
				return m.ext_passkey_used_months_ago({ months: String(deltaMonths) });
			}
			const deltaYears = Math.floor(deltaMonths / 12);
			return m.ext_passkey_used_years_ago({ years: String(deltaYears) });
		},
		[m],
	);

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
		return <OverlayViewport className="min-h-[64px]" />;
	}

	return (
		<OverlayViewport>
			<OverlaySurface>
				<OverlayPromptHeader
					icon={<IconPasskey className="size-3.5" />}
					title={m.ext_passkey_choose()}
					subtitle={data.rpId}
					meta={
						<OverlayChip>
							{data.options.length}{" "}
							{data.options.length === 1
								? m.ext_passkey_option()
								: m.ext_passkey_options()}
						</OverlayChip>
					}
				/>

				<OverlayList className="max-h-[236px] border-t pt-1">
					{data.options.length === 0 && (
						<p className="rounded-sm border border-dashed px-2.5 py-5 text-center text-[11.5px] text-muted-foreground">
							{m.ext_passkey_no_passkeys()}
						</p>
					)}

					{data.options.map((option) => {
						const isSelected = selectedCredentialId === option.credentialId;
						return (
							<OverlayRow
								key={option.credentialId}
								selected={isSelected}
								ariaPressed={isSelected}
								onSelect={() => setSelectedCredentialId(option.credentialId)}
								leading={
									<Favicon
										url={option.itemUrl}
										title={
											option.itemTitle ||
											option.itemUrl ||
											option.passkeyUserName
										}
										serverUrl={option.serverUrl}
										category="login"
										size="sm"
										className="size-[26px] rounded-[7px]"
									/>
								}
								title={option.passkeyUserDisplayName || option.passkeyUserName}
								subtitle={option.itemUsername || option.passkeyUserName}
								details={
									<>
										<OverlayChip>
											<IconVault className="size-2.5" />
											{option.vaultName || m.ext_passkey_vault_fallback()}
										</OverlayChip>
										<OverlayChip>
											<IconClock className="size-2.5" />
											{formatRelativeTime(
												option.lastUsedAt || option.createdAt,
											)}
										</OverlayChip>
									</>
								}
								trailing={
									<span
										aria-hidden
										className={
											isSelected
												? "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground"
												: "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border text-transparent"
										}
									>
										<IconCheck className="size-2.5" />
									</span>
								}
							/>
						);
					})}
				</OverlayList>

				{selectedOption?.accountEmail && (
					<div className="flex items-center gap-1.5 border-t px-3 py-2 text-[11px] text-muted-foreground">
						<IconMail className="size-3 shrink-0" />
						<span className="truncate">{selectedOption.accountEmail}</span>
					</div>
				)}

				<OverlayActions>
					<Button
						onClick={handleSelect}
						size="sm"
						className="h-7 flex-1"
						disabled={!selectedCredentialId}
					>
						{m.ext_passkey_use()}
					</Button>
					<Button
						onClick={handleCancel}
						variant="ghost"
						size="sm"
						className="h-7 flex-1"
					>
						{m.ext_passkey_cancel()}
					</Button>
				</OverlayActions>
			</OverlaySurface>
		</OverlayViewport>
	);
}

mountOverlayApp(<PasskeyPickerIframe />);
