import {
	detectOS,
	getPrimaryDownloadForOS,
	RELEASES_PAGE_URL,
} from "@bittery/shared/releases";
import { Button } from "@bittery/ui";
import { IconClipboardPaste as Download } from "@bittery/ui/icons";
import { useI18n } from "@/providers/i18n-provider";

export function DownloadCtaCard() {
	const { m } = useI18n();
	const os = detectOS();
	const downloadUrl = getPrimaryDownloadForOS(os)?.url ?? RELEASES_PAGE_URL;

	return (
		<section className="rounded-lg border bg-card p-4">
			<div className="flex items-start gap-3">
				<div className="rounded-md border bg-foreground/3 p-2">
					<Download className="size-4 text-muted-foreground" />
				</div>
				<div className="min-w-0 flex-1">
					<h2 className="font-medium text-sm">
						{m.dashboard_home_get_desktop_title()}
					</h2>
					<p className="mt-0.5 text-muted-foreground text-xs leading-relaxed">
						{m.dashboard_home_get_desktop_description()}
					</p>
				</div>
			</div>
			<Button className="mt-3 w-full" size="sm" asChild>
				<a href={downloadUrl} target="_blank" rel="noopener noreferrer">
					{m.dashboard_home_download_action()}
				</a>
			</Button>
		</section>
	);
}
