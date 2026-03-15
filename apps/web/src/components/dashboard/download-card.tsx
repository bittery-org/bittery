import {
	Badge,
	Button,
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@bittery/ui";
import {
	IconLaptop2OutlineDuo18 as Apple,
	IconClipboardArrowInOutlineDuo18 as Download,
	IconExternalLinkOutlineDuo18 as ExternalLink,
	IconSquareTerminalOutlineDuo18 as Monitor,
	IconStarSparkle2OutlineDuo18 as Zap,
} from "@bittery/ui/icons";
import { useI18n } from "@/providers/i18n-provider";

function detectOS(): "macos" | "windows" | "linux" | "unknown" {
	if (typeof navigator === "undefined") return "unknown";
	const ua = navigator.userAgent.toLowerCase();
	if (ua.includes("mac")) return "macos";
	if (ua.includes("win")) return "windows";
	if (ua.includes("linux")) return "linux";
	return "unknown";
}

// Replace with your actual GitHub org/repo
const GITHUB_REPO = "bittery-org/bittery";
const RELEASES_URL = `https://github.com/${GITHUB_REPO}/releases`;

export function DownloadCard() {
	const { m } = useI18n();
	const os = detectOS();
	const osInfo = {
		macos: {
			name: m.dashboard_download_platform_macos(),
			icon: Apple,
			file: "Bittery.dmg",
			hint: m.dashboard_download_platform_hint_macos(),
		},
		windows: {
			name: m.dashboard_download_platform_windows(),
			icon: Monitor,
			file: "Bittery.exe",
			hint: m.dashboard_download_platform_hint_windows(),
		},
		linux: {
			name: m.dashboard_download_platform_linux(),
			icon: Monitor,
			file: "Bittery.AppImage",
			hint: m.dashboard_download_platform_hint_linux(),
		},
		unknown: {
			name: m.dashboard_download_platform_desktop(),
			icon: Download,
			file: "",
			hint: m.dashboard_download_platform_hint_desktop(),
		},
	};
	const { name, icon: Icon, file, hint } = osInfo[os];
	const downloadUrl = file
		? `${RELEASES_URL}/latest/download/${file}`
		: RELEASES_URL;
	const primaryLabel =
		os === "unknown"
			? m.dashboard_download_button_browse_releases()
			: m.dashboard_download_button_download_for({ platform: name });

	return (
		<Card className="gap-0 overflow-hidden border-border/70 py-0">
			<CardHeader className="border-b bg-muted/35 py-4">
				<div className="flex items-center justify-between gap-3">
					<CardTitle className="flex items-center gap-2 text-base">
						<Download className="h-4 w-4" />
						{m.dashboard_download_title()}
					</CardTitle>
					<Badge variant="secondary">{m.dashboard_download_badge()}</Badge>
				</div>
				<CardDescription className="text-xs">
					{m.dashboard_download_description()}
				</CardDescription>
			</CardHeader>

			<CardContent className="space-y-4 p-5">
				<div className="rounded-lg border bg-background/70 p-4">
					<div className="mb-3 flex items-start justify-between gap-3">
						<div className="flex items-center gap-2">
							<div className="inline-flex size-9 items-center justify-center rounded-md border bg-muted/70 text-muted-foreground">
								<Icon className="h-4 w-4" />
							</div>
							<div className="space-y-0.5">
								<p className="font-medium text-sm">
									{m.dashboard_download_detected_platform()}
								</p>
								<p className="text-muted-foreground text-xs">{hint}</p>
							</div>
						</div>
						<Badge variant="outline">{name}</Badge>
					</div>

					<Button className="w-full" asChild>
						<a href={downloadUrl} target="_blank" rel="noopener noreferrer">
							<Icon className="mr-2 h-4 w-4" />
							{primaryLabel}
						</a>
					</Button>
				</div>

				<div className="space-y-2 text-muted-foreground text-xs">
					<div className="flex items-center gap-2">
						<Zap className="h-4 w-4" />
						{m.dashboard_download_feature_biometric_unlock()}
					</div>
				</div>

				<Button variant="outline" className="w-full" asChild>
					<a href={RELEASES_URL} target="_blank" rel="noopener noreferrer">
						{m.dashboard_download_button_all_downloads()}
						<ExternalLink className="ml-2 h-3.5 w-3.5" />
					</a>
				</Button>
			</CardContent>
		</Card>
	);
}
