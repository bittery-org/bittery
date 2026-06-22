import { type AppLocale, supportedLocales } from "@bittery/i18n";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@bittery/ui";
import { IconFlagGermany, IconFlagUnitedStates } from "@bittery/ui/icons";
import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { SettingsField } from "@/components/settings/settings-field";
import { useI18n } from "@/providers/i18n-provider";

export function SettingsGeneralPanel() {
	const { locale, setLocale, m } = useI18n();
	const { theme, setTheme } = useTheme();

	const activeLocaleLabel =
		locale === "en" ? m.i18n_language_en() : m.i18n_language_de();
	const ActiveLocaleFlag =
		locale === "en" ? IconFlagUnitedStates : IconFlagGermany;

	return (
		<div className="space-y-8">
			<SettingsField
				id="language"
				label={m.settings_general_language_title()}
				description={m.settings_general_language_description()}
			>
				<Select
					value={locale}
					onValueChange={(value) => setLocale(value as AppLocale)}
				>
					<SelectTrigger id="language">
						<div className="flex items-center gap-2">
							<ActiveLocaleFlag size={14} className="shrink-0" />
							<SelectValue placeholder={m.settings_general_language_title()}>
								{activeLocaleLabel}
							</SelectValue>
						</div>
					</SelectTrigger>
					<SelectContent>
						{supportedLocales.map((value) => (
							<SelectItem key={value} value={value}>
								<span className="inline-flex items-center gap-2 whitespace-nowrap">
									{value === "en" ? (
										<IconFlagUnitedStates size={14} className="shrink-0" />
									) : (
										<IconFlagGermany size={14} className="shrink-0" />
									)}
									<span>
										{value === "en"
											? m.i18n_language_en()
											: m.i18n_language_de()}
									</span>
								</span>
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</SettingsField>

			<SettingsField
				id="appearance"
				label={m.settings_general_appearance_title()}
				description={m.settings_general_appearance_description()}
			>
				<Select value={theme} onValueChange={setTheme}>
					<SelectTrigger id="appearance">
						<div className="flex items-center gap-2">
							{theme === "dark" ? (
								<Moon className="size-3.5 shrink-0" />
							) : theme === "light" ? (
								<Sun className="size-3.5 shrink-0" />
							) : (
								<Monitor className="size-3.5 shrink-0" />
							)}
							<SelectValue placeholder={m.settings_general_appearance_title()}>
								{theme === "dark"
									? m.settings_theme_dark()
									: theme === "light"
										? m.settings_theme_light()
										: m.settings_theme_system()}
							</SelectValue>
						</div>
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="light">
							<span className="inline-flex items-center gap-2 whitespace-nowrap">
								<Sun className="size-3.5 shrink-0" />
								<span>{m.settings_theme_light()}</span>
							</span>
						</SelectItem>
						<SelectItem value="dark">
							<span className="inline-flex items-center gap-2 whitespace-nowrap">
								<Moon className="size-3.5 shrink-0" />
								<span>{m.settings_theme_dark()}</span>
							</span>
						</SelectItem>
						<SelectItem value="system">
							<span className="inline-flex items-center gap-2 whitespace-nowrap">
								<Monitor className="size-3.5 shrink-0" />
								<span>{m.settings_theme_system()}</span>
							</span>
						</SelectItem>
					</SelectContent>
				</Select>
			</SettingsField>
		</div>
	);
}
