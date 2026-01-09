import {
	Button,
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@bittery/ui";
import { Apple, Download, Monitor } from "lucide-react";

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
	},
	windows: {
		name: "Windows",
		icon: Monitor,
		file: "Bittery.exe",
	},
	linux: {
		name: "Linux",
		icon: Monitor,
		file: "Bittery.AppImage",
	},
	unknown: {
		name: "Desktop",
		icon: Download,
		file: "",
	},
};

// Replace with your actual GitHub org/repo
const GITHUB_REPO = "bittery-org/bittery";
const RELEASES_URL = `https://github.com/${GITHUB_REPO}/releases`;

export function DownloadCard() {
	const os = detectOS();
	const { name, icon: Icon, file } = osInfo[os];
	const downloadUrl = file
		? `${RELEASES_URL}/latest/download/${file}`
		: RELEASES_URL;

	return (
		<Card>
			<CardHeader>
				<CardTitle className="flex items-center gap-2">
					<Download className="h-5 w-5" />
					Download Desktop App
				</CardTitle>
				<CardDescription>
					Get the full Bittery experience with our desktop app
				</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				<p className="text-muted-foreground text-sm">
					The desktop app provides the best experience for managing your
					passwords with biometric unlock, auto-fill, and offline access.
				</p>
				<div className="flex flex-wrap gap-2">
					<Button asChild>
						<a href={downloadUrl} target="_blank" rel="noopener noreferrer">
							<Icon className="mr-2 h-4 w-4" />
							Download for {name}
						</a>
					</Button>
					<Button variant="outline" asChild>
						<a href={RELEASES_URL} target="_blank" rel="noopener noreferrer">
							All Downloads
						</a>
					</Button>
				</div>
			</CardContent>
		</Card>
	);
}
