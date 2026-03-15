import { type AppLocale, supportedLocales } from "@bittery/i18n";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@bittery/ui";
import {
	IconExternalLinkOutlineDuo18 as ExternalLink,
	IconFlagGermany,
	IconFlagUnitedStates,
	IconLockOutlineDuo18,
} from "@bittery/ui/icons";
import { createFileRoute, Outlet } from "@tanstack/react-router";
import { useI18n } from "@/providers/i18n-provider";

export const Route = createFileRoute("/_auth")({
	component: AuthLayout,
});

function AuthLayout() {
	const { locale, setLocale, m } = useI18n();
	const activeLocaleLabel =
		locale === "en" ? m.i18n_language_en() : m.i18n_language_de();
	const ActiveLocaleFlag =
		locale === "en" ? IconFlagUnitedStates : IconFlagGermany;

	return (
		<div className="flex min-h-svh flex-col md:h-svh md:flex-row md:overflow-hidden">
			{/* Left panel — branding sidebar */}
			<div className="relative hidden w-1/3 flex-col bg-sidebar md:flex lg:w-1/3">
				<div className="absolute top-4 left-4 sm:top-5 sm:left-6">
					<a
						href="https://bittery.com"
						target="_blank"
						rel="noopener noreferrer"
					>
						<img src="/logo.png" alt="Bittery" className="h-7 w-auto sm:h-10" />
					</a>
				</div>

				{/* Lock icon — sits on the right edge */}
				<div className="absolute top-1/4 right-0 z-10 translate-x-1/2">
					<div className="flex items-center justify-center rounded-full border border-border bg-white p-4 shadow-sm dark:bg-gray-900">
						<IconLockOutlineDuo18 className="size-7 text-primary" />
					</div>
				</div>

				{/* Separator line on the right edge */}
				<div className="absolute inset-y-0 right-0 w-px bg-black/10 dark:bg-white/10" />
			</div>

			{/* Right panel — content area */}
			<div className="flex min-h-svh flex-1 flex-col bg-white md:h-svh md:min-h-0 dark:bg-gray-900">
				{/* Mobile logo */}
				<div className="flex shrink-0 items-center justify-center px-5 pt-4 sm:px-8 sm:pt-6 md:hidden">
					<a
						href="https://bittery.com"
						target="_blank"
						rel="noopener noreferrer"
					>
						<img src="/logo.png" alt="Bittery" className="h-10 w-auto" />
					</a>
				</div>

				{/* Main content */}
				<main
					id="auth-scroll-area"
					className="flex flex-1 flex-col px-4 py-8 sm:px-6 md:min-h-0 md:overflow-y-auto md:pt-12"
				>
					<div className="flex flex-1 items-center justify-center">
						<div className="w-full max-w-110">
							<Outlet />
						</div>
					</div>
				</main>

				{/* Footer */}
				<footer className="shrink-0 px-4">
					<div className="mx-auto flex max-w-110 flex-col items-center gap-3 py-1.5 sm:flex-row sm:justify-between">
						<div className="flex items-center gap-4">
							<a
								href="https://github.com/bittery-org/bittery"
								target="_blank"
								rel="noopener noreferrer"
								className="flex items-center gap-1 text-muted-foreground/60 text-xs transition-colors hover:text-muted-foreground"
							>
								{m.auth_footer_github()}
								<ExternalLink size={10} />
							</a>
							<span className="text-muted-foreground/20">|</span>
							<a
								href="https://bittery.com/docs"
								target="_blank"
								rel="noopener noreferrer"
								className="flex items-center gap-1 text-muted-foreground/60 text-xs transition-colors hover:text-muted-foreground"
							>
								{m.auth_footer_help()}
								<ExternalLink size={10} />
							</a>
						</div>
						<div className="flex items-center">
							<Select
								value={locale}
								onValueChange={(value) => setLocale(value as AppLocale)}
							>
								<SelectTrigger
									aria-label={m.auth_footer_language()}
									className="h-7 min-w-28 border-0 bg-transparent px-1.5 text-xs shadow-none ring-0 focus:ring-0"
								>
									<ActiveLocaleFlag size={14} className="shrink-0" />
									<span className="truncate">{activeLocaleLabel}</span>
								</SelectTrigger>
								<SelectContent className="min-w-40">
									{supportedLocales.map((value) => (
										<SelectItem key={value} value={value} className="gap-2">
											<span className="inline-flex items-center gap-2 whitespace-nowrap">
												{value === "en" ? (
													<IconFlagUnitedStates
														size={14}
														className="shrink-0"
													/>
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
						</div>
					</div>
				</footer>
			</div>
		</div>
	);
}
