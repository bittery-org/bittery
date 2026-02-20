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
	IconMobileOutlineDuo18 as Apple,
	IconClipboardArrowInOutlineDuo18 as Download,
	IconExternalLinkOutlineDuo18 as ExternalLink,
	IconSquareTerminalOutlineDuo18 as Monitor,
	IconStarSparkle2OutlineDuo18 as Zap,
} from "@bittery/ui/icons";

function detectOS(): "macos" | "windows" | "linux" | "unknown" {
	if (typeof navigator === "undefined") return "unknown";
	const ua = navigator.userAgent.toLowerCase();
	if (ua.includes("mac")) return "macos";
	if (ua.includes("win")) return "windows";
	if (ua.includes("linux")) return "linux";
	return "unknown";
}

const osInfo = {
	macos: {
		name: "macOS",
		icon: Apple,
		file: "Bittery.dmg",
		hint: "Native app for Apple devices",
	},
	windows: {
		name: "Windows",
		icon: Monitor,
		file: "Bittery.exe",
		hint: "Installer for Windows desktop",
	},
	linux: {
		name: "Linux",
		icon: Monitor,
		file: "Bittery.AppImage",
		hint: "Portable AppImage package",
	},
	unknown: {
		name: "Desktop",
		icon: Download,
		file: "",
		hint: "Choose a build manually",
	},
};

// Replace with your actual GitHub org/repo
const GITHUB_REPO = "bittery-org/bittery";
const RELEASES_URL = `https://github.com/${GITHUB_REPO}/releases`;

export function DownloadCard() {
	const os = detectOS();
	const { name, icon: Icon, file, hint } = osInfo[os];
	const downloadUrl = file
		? `${RELEASES_URL}/latest/download/${file}`
		: RELEASES_URL;
	const primaryLabel =
		os === "unknown" ? "Browse Desktop Releases" : `Download for ${name}`;

	return (
		<Card className="gap-0 overflow-hidden border-border/70 py-0">
			<CardHeader className="border-b bg-muted/35 py-4">
				<div className="flex items-center justify-between gap-3">
					<CardTitle className="flex items-center gap-2 text-base">
						<Download className="h-4 w-4" />
						Desktop App
					</CardTitle>
					<Badge variant="secondary">Recommended</Badge>
				</div>
				<CardDescription className="text-sm">
					Install Bittery locally for faster unlock, autofill, and offline
					access.
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
								<p className="font-medium text-sm">Detected platform</p>
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

				<div className="space-y-2 text-muted-foreground text-sm">
					<div className="flex items-center gap-2">
						<Zap className="h-4 w-4" />
						Biometric unlock and stronger local workflow.
					</div>
				</div>

				<Button variant="outline" className="w-full" asChild>
					<a href={RELEASES_URL} target="_blank" rel="noopener noreferrer">
						All Downloads
						<ExternalLink className="ml-2 h-3.5 w-3.5" />
					</a>
				</Button>
			</CardContent>
		</Card>
	);
}
