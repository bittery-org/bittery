import type { CompiledMessages } from "@bittery/i18n";
import { useI18n } from "@bittery/i18n/react";
import { generateTotp, type TotpResult } from "@bittery/shared/totp";
import type { TotpAlgorithm, TotpDigits } from "@bittery/shared/types";
import { useCallback, useEffect, useState } from "react";
import { IconCopy } from "../icons";
import { copyWithToast } from "./clipboard";
import {
	DetailFieldActionButton,
	DetailRow,
} from "./vault/item-detail/field-components";

interface InlineTotpDisplayProps {
	totpSecret: string;
	totpAlgorithm?: TotpAlgorithm;
	totpDigits?: TotpDigits;
	totpPeriod?: number;
}

async function handleCopy(
	value: string | undefined,
	label: string,
	m: CompiledMessages,
) {
	await copyWithToast(value, label, {
		successMessage: m.vaults_detail_items_copy_toast_success({ label }),
		emptyErrorMessage: m.vaults_detail_items_copy_toast_empty({ label }),
		copyErrorMessage: m.vaults_detail_items_copy_toast_failed(),
	});
}

function formatCode(code: string) {
	const half = Math.ceil(code.length / 2);
	return `${code.slice(0, half)} ${code.slice(half)}`;
}

const RING_RADIUS = 6;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

export function InlineTotpDisplay({
	totpSecret,
	totpAlgorithm = "SHA1",
	totpDigits = 6,
	totpPeriod = 30,
}: InlineTotpDisplayProps) {
	const { m } = useI18n();
	const [totpResult, setTotpResult] = useState<TotpResult | null>(null);

	const generateCode = useCallback(async () => {
		try {
			const result = await generateTotp({
				secret: totpSecret,
				algorithm: totpAlgorithm,
				digits: totpDigits,
				period: totpPeriod,
			});
			setTotpResult(result);
		} catch (error) {
			console.error("Failed to generate TOTP code:", error);
		}
	}, [totpSecret, totpAlgorithm, totpDigits, totpPeriod]);

	useEffect(() => {
		generateCode();

		const interval = setInterval(() => {
			generateCode();
		}, 1000);

		return () => clearInterval(interval);
	}, [generateCode]);

	const handleCopyCode = () => {
		handleCopy(totpResult?.code, m.vaults_detail_items_copy_label_code(), m);
	};

	// progress is elapsed percent — the ring drains from full to empty over the period
	const strokeDashoffset =
		((totpResult?.progress ?? 0) / 100) * RING_CIRCUMFERENCE;

	return (
		<DetailRow
			onClick={handleCopyCode}
			actions={
				<DetailFieldActionButton
					onClick={handleCopyCode}
					disabled={!totpResult?.code}
				>
					<IconCopy className="size-4" />
				</DetailFieldActionButton>
			}
		>
			<div className="min-w-0">
				<p className="truncate text-[10.5px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
					{m.vaults_detail_items_detail_login_field_one_time_password()}
				</p>
				<div className="flex items-center gap-2.5">
					<span className="font-medium font-mono text-base text-foreground tracking-[0.12em]">
						{totpResult?.code ? formatCode(totpResult.code) : "--- ---"}
					</span>
					<svg
						className="-rotate-90 size-4 shrink-0"
						viewBox="0 0 16 16"
						aria-hidden="true"
					>
						<circle
							cx="8"
							cy="8"
							r={RING_RADIUS}
							fill="none"
							strokeWidth="2.5"
							className="stroke-foreground/12"
						/>
						<circle
							cx="8"
							cy="8"
							r={RING_RADIUS}
							fill="none"
							strokeWidth="2.5"
							strokeLinecap="round"
							className="stroke-primary transition-[stroke-dashoffset] duration-500 ease-linear [filter:drop-shadow(0_0_3px_color-mix(in_oklab,var(--color-primary)_70%,transparent))]"
							style={{
								strokeDasharray: RING_CIRCUMFERENCE,
								strokeDashoffset,
							}}
						/>
					</svg>
				</div>
			</div>
		</DetailRow>
	);
}
