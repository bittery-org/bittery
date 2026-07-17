import { useRPC } from "@bittery/shared/rpc";
import { Button } from "@bittery/ui";
import {
	IconNetwork as Extension,
	IconEarth as Globe,
	IconSquareTerminal as Monitor,
	IconSmartphone as Smartphone,
} from "@bittery/ui/icons";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { formatDistanceToNow } from "date-fns";
import { de as dateFnsDe, enUS as dateFnsEnUS } from "date-fns/locale";
import { useI18n } from "@/providers/i18n-provider";

function getPlatformIcon(platform?: string | null) {
	switch (platform) {
		case "ios":
		case "android":
			return <Smartphone className="size-4" />;
		case "desktop":
			return <Monitor className="size-4" />;
		case "extension":
			return <Extension className="size-4" />;
		default:
			return <Globe className="size-4" />;
	}
}

export function DevicesCard() {
	const rpc = useRPC();
	const devicesQuery = useQuery(rpc.auth.listDevices.queryOptions());
	const { m, locale } = useI18n();
	const dateLocale = locale === "de" ? dateFnsDe : dateFnsEnUS;
	const devices = devicesQuery.data ?? [];

	if (devices.length === 0) {
		return null;
	}

	return (
		<section className="rounded-lg border bg-card">
			<div className="flex items-center gap-3 border-b p-4">
				<div className="min-w-0 flex-1">
					<h2 className="font-medium text-sm">
						{m.dashboard_home_devices_title()}
					</h2>
					<p className="mt-0.5 text-muted-foreground text-xs">
						{m.dashboard_home_devices_description()}
					</p>
				</div>
				<Button variant="ghost" size="sm" asChild>
					<Link to="/settings">{m.dashboard_home_view_all()}</Link>
				</Button>
			</div>
			<div className="divide-y">
				{devices.slice(0, 4).map((device) => (
					<div key={device.id} className="flex items-center gap-3 px-4 py-2.5">
						<div className="inline-flex size-8 shrink-0 items-center justify-center rounded-md border bg-foreground/3 text-muted-foreground">
							{getPlatformIcon(device.platform)}
						</div>
						<div className="min-w-0 flex-1">
							<p className="truncate font-medium text-sm">
								{device.deviceName ??
									device.browserName ??
									m.settings_devices_common_unknown_device()}
							</p>
							<p className="mt-0.5 truncate text-muted-foreground text-xs">
								{device.isCurrentSession
									? m.dashboard_home_device_current()
									: m.dashboard_home_device_active_time({
											time: formatDistanceToNow(new Date(device.lastActiveAt), {
												addSuffix: true,
												locale: dateLocale,
											}),
										})}
							</p>
						</div>
						{device.isCurrentSession ? (
							<span
								aria-hidden
								className="size-[7px] shrink-0 rounded-full bg-success"
							/>
						) : null}
					</div>
				))}
			</div>
		</section>
	);
}
