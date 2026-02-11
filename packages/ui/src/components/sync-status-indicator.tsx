import type * as React from "react";
import { cn } from "../lib/utils";
import type { SyncConnectionStatus } from "./sync-status";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "./tooltip";

const STATUS_LABELS: Record<SyncConnectionStatus, string> = {
	disconnected: "Sync disconnected",
	connecting: "Sync connecting",
	connected: "Sync connected",
	reconnecting: "Sync reconnecting",
	error: "Sync error",
};

export interface SyncStatusIndicatorProps extends React.ComponentProps<"div"> {
	status: SyncConnectionStatus;
}

export function SyncStatusIndicator({
	status,
	className,
	...props
}: SyncStatusIndicatorProps) {
	const dotClassName = cn(
		"h-2.5 w-2.5 rounded-full",
		status === "connected" && "bg-green-500",
		(status === "connecting" || status === "reconnecting") &&
			"animate-pulse bg-yellow-500",
		status === "disconnected" && "bg-muted-foreground",
		status === "error" && "bg-red-500",
	);

	return (
		<TooltipProvider delayDuration={100}>
			<Tooltip>
				<TooltipTrigger asChild>
					<div
						className={cn(
							"inline-flex items-center",
							className,
						)}
						role="status"
						aria-label={STATUS_LABELS[status]}
						{...props}
					>
						<span className={dotClassName} />
					</div>
				</TooltipTrigger>
				<TooltipContent side="bottom" sideOffset={6}>
					{STATUS_LABELS[status]}
				</TooltipContent>
			</Tooltip>
		</TooltipProvider>
	);
}
