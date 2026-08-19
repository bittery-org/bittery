import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@bittery/ui";
import { useMemo } from "react";
import { SettingsField } from "@/components/settings/settings-field";
import { TravelModeSettings } from "@/components/travel-mode-settings";
import { useI18n } from "@/providers/i18n-provider";

const AUTO_LOCK_OPTION_VALUES = [
	"60000",
	"300000",
	"600000",
	"900000",
	"1800000",
	"3600000",
	"-1",
] as const;

const DAY_MS = 24 * 60 * 60 * 1000;
const MASTER_PASSWORD_REENTRY_VALUES = [
	String(14 * DAY_MS),
	String(30 * DAY_MS),
	String(60 * DAY_MS),
	String(90 * DAY_MS),
] as const;

interface SettingsSecurityPanelProps {
	autoLockTimeout: string;
	onAutoLockTimeoutChange: (value: string) => void;
	masterPasswordReentry: string;
	onMasterPasswordReentryChange: (value: string) => void;
}

export function SettingsSecurityPanel({
	autoLockTimeout,
	onAutoLockTimeoutChange,
	masterPasswordReentry,
	onMasterPasswordReentryChange,
}: SettingsSecurityPanelProps) {
	const { m } = useI18n();

	const autoLockOptions = useMemo(() => {
		return AUTO_LOCK_OPTION_VALUES.map((value) => {
			if (value === "-1") {
				return { value, label: m.settings_auto_lock_option_never() };
			}

			const ms = Number.parseInt(value, 10);
			const minutes = Math.round(ms / 60000);
			if (minutes >= 60) {
				const hours = Math.round(minutes / 60);
				return {
					value,
					label:
						hours === 1
							? m.settings_auto_lock_option_hours_single({ count: hours })
							: m.settings_auto_lock_option_hours_plural({ count: hours }),
				};
			}

			return {
				value,
				label:
					minutes === 1
						? m.settings_auto_lock_option_minutes_single({ count: minutes })
						: m.settings_auto_lock_option_minutes_plural({ count: minutes }),
			};
		});
	}, [m]);

	const masterPasswordReentryOptions = useMemo(() => {
		return MASTER_PASSWORD_REENTRY_VALUES.map((value) => {
			const days = Math.round(Number.parseInt(value, 10) / DAY_MS);
			return {
				value,
				label:
					days === 1
						? m.settings_dialog_master_password_reentry_option_days_single({
								count: days,
							})
						: m.settings_dialog_master_password_reentry_option_days_plural({
								count: days,
							}),
			};
		});
	}, [m]);

	return (
		<div className="space-y-8">
			<SettingsField
				id="autoLockTimeout"
				label={m.settings_security_auto_lock()}
				description={m.settings_security_auto_lock_description()}
			>
				<Select value={autoLockTimeout} onValueChange={onAutoLockTimeoutChange}>
					<SelectTrigger id="autoLockTimeout">
						<SelectValue placeholder={m.settings_security_auto_lock()} />
					</SelectTrigger>
					<SelectContent>
						{autoLockOptions.map((option) => (
							<SelectItem key={option.value} value={option.value}>
								{option.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</SettingsField>

			<SettingsField
				id="masterPasswordReentry"
				label={m.settings_dialog_master_password_reentry_label()}
				description={m.settings_dialog_master_password_reentry_description()}
			>
				<Select
					value={masterPasswordReentry}
					onValueChange={onMasterPasswordReentryChange}
				>
					<SelectTrigger id="masterPasswordReentry">
						<SelectValue
							placeholder={m.settings_dialog_master_password_reentry_placeholder()}
						/>
					</SelectTrigger>
					<SelectContent>
						{masterPasswordReentryOptions.map((option) => (
							<SelectItem key={option.value} value={option.value}>
								{option.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</SettingsField>

			<TravelModeSettings />
		</div>
	);
}
