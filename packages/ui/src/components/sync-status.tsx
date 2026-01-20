import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "../lib/utils.js";

/**
 * Sync connection status types
 */
export type SyncConnectionStatus =
	| "disconnected"
	| "connecting"
	| "connected"
	| "reconnecting"
	| "error";

const syncStatusVariants = cva(
	"inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium transition-colors",
	{
		variants: {
			status: {
				disconnected: "bg-muted text-muted-foreground",
				connecting: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400",
				connected: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
				reconnecting: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400",
				error: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400",
			},
		},
		defaultVariants: {
			status: "disconnected",
		},
	},
);

/**
 * Status indicator dot
 */
function StatusDot({ status }: { status: SyncConnectionStatus }) {
	const dotClass = cn(
		"h-1.5 w-1.5 rounded-full",
		{
			"bg-muted-foreground": status === "disconnected",
			"bg-yellow-500 animate-pulse": status === "connecting" || status === "reconnecting",
			"bg-green-500": status === "connected",
			"bg-red-500": status === "error",
		},
	);

	return <span className={dotClass} />;
}

/**
 * Get human-readable status text
 */
function getStatusText(status: SyncConnectionStatus): string {
	switch (status) {
		case "disconnected":
			return "Offline";
		case "connecting":
			return "Connecting...";
		case "connected":
			return "Synced";
		case "reconnecting":
			return "Reconnecting...";
		case "error":
			return "Sync Error";
		default:
			return "Unknown";
	}
}

interface SyncStatusBadgeProps
	extends React.ComponentProps<"div">,
		VariantProps<typeof syncStatusVariants> {
	status: SyncConnectionStatus;
	pendingChanges?: number;
	showText?: boolean;
}

/**
 * Sync status badge component
 * Shows current connection status with optional pending changes count
 */
function SyncStatusBadge({
	className,
	status,
	pendingChanges = 0,
	showText = true,
	...props
}: SyncStatusBadgeProps) {
	return (
		<div
			className={cn(syncStatusVariants({ status }), className)}
			{...props}
		>
			<StatusDot status={status} />
			{showText && <span>{getStatusText(status)}</span>}
			{pendingChanges > 0 && (
				<span className="ml-0.5 rounded-full bg-current/20 px-1.5 py-0.5 text-[10px]">
					{pendingChanges}
				</span>
			)}
		</div>
	);
}

interface SyncStatusIconProps extends React.ComponentProps<"div"> {
	status: SyncConnectionStatus;
	size?: "sm" | "md" | "lg";
}

const iconSizes = {
	sm: "h-4 w-4",
	md: "h-5 w-5",
	lg: "h-6 w-6",
};

/**
 * Sync status icon component
 * Shows a cloud icon with status indication
 */
function SyncStatusIcon({
	className,
	status,
	size = "md",
	...props
}: SyncStatusIconProps) {
	const iconClass = cn(iconSizes[size], className);
	const colorClass = cn({
		"text-muted-foreground": status === "disconnected",
		"text-yellow-500": status === "connecting" || status === "reconnecting",
		"text-green-500": status === "connected",
		"text-red-500": status === "error",
	});

	// Cloud icon with sync indicator
	if (status === "connecting" || status === "reconnecting") {
		return (
			<div className={cn("relative", colorClass)} {...props}>
				<svg
					className={cn(iconClass, "animate-pulse")}
					fill="none"
					stroke="currentColor"
					viewBox="0 0 24 24"
					xmlns="http://www.w3.org/2000/svg"
				>
					<path
						strokeLinecap="round"
						strokeLinejoin="round"
						strokeWidth={2}
						d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
					/>
				</svg>
			</div>
		);
	}

	if (status === "connected") {
		return (
			<div className={colorClass} {...props}>
				<svg
					className={iconClass}
					fill="none"
					stroke="currentColor"
					viewBox="0 0 24 24"
					xmlns="http://www.w3.org/2000/svg"
				>
					<path
						strokeLinecap="round"
						strokeLinejoin="round"
						strokeWidth={2}
						d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z"
					/>
				</svg>
			</div>
		);
	}

	if (status === "error") {
		return (
			<div className={colorClass} {...props}>
				<svg
					className={iconClass}
					fill="none"
					stroke="currentColor"
					viewBox="0 0 24 24"
					xmlns="http://www.w3.org/2000/svg"
				>
					<path
						strokeLinecap="round"
						strokeLinejoin="round"
						strokeWidth={2}
						d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
					/>
				</svg>
			</div>
		);
	}

	// Disconnected - cloud with slash
	return (
		<div className={colorClass} {...props}>
			<svg
				className={iconClass}
				fill="none"
				stroke="currentColor"
				viewBox="0 0 24 24"
				xmlns="http://www.w3.org/2000/svg"
			>
				<path
					strokeLinecap="round"
					strokeLinejoin="round"
					strokeWidth={2}
					d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z"
				/>
				<path
					strokeLinecap="round"
					strokeLinejoin="round"
					strokeWidth={2}
					d="M4 4l16 16"
				/>
			</svg>
		</div>
	);
}

export { SyncStatusBadge, SyncStatusIcon, syncStatusVariants, getStatusText };
