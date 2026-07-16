"use client";

import { useTheme } from "next-themes";
import type * as React from "react";
import {
	Toaster as Sonner,
	type ToasterProps,
	toast as sonnerToast,
} from "sonner";
import {
	IconCircleCheck2OutlineDuo18,
	IconCircleWarningOutlineDuo18,
	IconCircleXmarkOutlineDuo18,
	IconLoader2OutlineDuo18,
	IconTriangleWarningOutlineDuo18,
	IconXmarkOutlineDuo18,
} from "../icons";
import { cn } from "../lib/utils";

/**
 * Bittery toast — the "aurora pill": a fully-rounded popover-surface pill
 * with a status hairline + radial wash, flat status icon, and the optional
 * description flowing inline after the title (single line, truncating).
 * Toasts appear at bottom-center (see Toaster below).
 *
 * Decided via the /prototype/toasts exploration (2026-07): flat capsule
 * variant with inline description, bottom-center placement.
 */

type ToastKind =
	| "default"
	| "success"
	| "error"
	| "warning"
	| "info"
	| "loading";

type KindConfig = {
	Icon?: typeof IconCircleCheck2OutlineDuo18;
	text: string;
	hairline: string;
	wash: string;
	iconClass?: string;
};

const KINDS: Record<ToastKind, KindConfig> = {
	default: {
		text: "text-muted-foreground",
		hairline: "via-foreground/30",
		wash: "bg-[radial-gradient(120%_100%_at_50%_0%,color-mix(in_oklab,var(--color-foreground)_6%,transparent),transparent_70%)]",
	},
	success: {
		Icon: IconCircleCheck2OutlineDuo18,
		text: "text-success",
		hairline: "via-success/60",
		wash: "bg-[radial-gradient(120%_100%_at_50%_0%,color-mix(in_oklab,var(--color-success)_10%,transparent),transparent_70%)]",
	},
	error: {
		Icon: IconCircleXmarkOutlineDuo18,
		text: "text-destructive",
		hairline: "via-destructive/60",
		wash: "bg-[radial-gradient(120%_100%_at_50%_0%,color-mix(in_oklab,var(--color-destructive)_10%,transparent),transparent_70%)]",
	},
	warning: {
		Icon: IconTriangleWarningOutlineDuo18,
		text: "text-warning",
		hairline: "via-warning/60",
		wash: "bg-[radial-gradient(120%_100%_at_50%_0%,color-mix(in_oklab,var(--color-warning)_10%,transparent),transparent_70%)]",
	},
	info: {
		Icon: IconCircleWarningOutlineDuo18,
		text: "text-info",
		hairline: "via-info/60",
		wash: "bg-[radial-gradient(120%_100%_at_50%_0%,color-mix(in_oklab,var(--color-info)_10%,transparent),transparent_70%)]",
		iconClass: "rotate-180",
	},
	loading: {
		Icon: IconLoader2OutlineDuo18,
		text: "text-muted-foreground",
		hairline: "via-foreground/30",
		wash: "bg-[radial-gradient(120%_100%_at_50%_0%,color-mix(in_oklab,var(--color-foreground)_6%,transparent),transparent_70%)]",
		iconClass: "animate-spin",
	},
};

export type ToastOptions = {
	id?: string | number;
	description?: React.ReactNode;
	action?: { label: string; onClick: () => void };
	duration?: number;
};

function BitteryToast({
	kind,
	title,
	description,
	action,
	onDismiss,
}: {
	kind: ToastKind;
	title: React.ReactNode;
	description?: React.ReactNode;
	action?: { label: string; onClick: () => void };
	onDismiss: () => void;
}) {
	const k = KINDS[kind];
	return (
		<div className="pointer-events-auto relative flex w-fit max-w-full items-center gap-2.5 overflow-hidden rounded-full border bg-popover py-2 pr-2 pl-3.5 shadow-pop">
			<span
				aria-hidden
				className={cn(
					"absolute inset-x-6 top-0 h-px bg-linear-to-r from-transparent to-transparent",
					k.hairline,
				)}
			/>
			<div aria-hidden className={cn("absolute inset-0", k.wash)} />
			{k.Icon && (
				<k.Icon
					className={cn("relative size-4 shrink-0", k.text, k.iconClass)}
				/>
			)}
			<p className="relative min-w-0 truncate text-sm">
				<span className="font-medium text-popover-foreground">{title}</span>
				{description != null && (
					<span className="text-muted-foreground"> · {description}</span>
				)}
			</p>
			{action && (
				<button
					type="button"
					onClick={() => {
						action.onClick();
						onDismiss();
					}}
					className={cn(
						"relative shrink-0 rounded-full border bg-foreground/3 px-2.5 py-0.5 font-medium text-xs transition-colors hover:bg-accent",
						k.text,
					)}
				>
					{action.label}
				</button>
			)}
			<button
				type="button"
				onClick={onDismiss}
				className="relative flex size-5.5 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
			>
				<IconXmarkOutlineDuo18 className="size-3" />
				<span className="sr-only">Close</span>
			</button>
		</div>
	);
}

function fire(
	kind: ToastKind,
	title: React.ReactNode,
	options?: ToastOptions,
): string | number {
	return sonnerToast.custom(
		(id) => (
			// Sonner gives every toast a fixed-width slot; center the pill in it.
			<div className="flex justify-center">
				<BitteryToast
					kind={kind}
					title={title}
					description={options?.description}
					action={options?.action}
					onDismiss={() => sonnerToast.dismiss(id)}
				/>
			</div>
		),
		{
			// Sonner spreads these options over its generated id — an explicit
			// `id: undefined` clobbers it, storing the toast under a different id
			// than the one our dismiss closure captured. Only pass id when set.
			...(options?.id != null && { id: options.id }),
			duration:
				options?.duration ??
				(kind === "loading" ? Number.POSITIVE_INFINITY : undefined),
		},
	);
}

const toast = Object.assign(
	(title: React.ReactNode, options?: ToastOptions) =>
		fire("default", title, options),
	{
		success: (title: React.ReactNode, options?: ToastOptions) =>
			fire("success", title, options),
		error: (title: React.ReactNode, options?: ToastOptions) =>
			fire("error", title, options),
		warning: (title: React.ReactNode, options?: ToastOptions) =>
			fire("warning", title, options),
		info: (title: React.ReactNode, options?: ToastOptions) =>
			fire("info", title, options),
		loading: (title: React.ReactNode, options?: ToastOptions) =>
			fire("loading", title, options),
		dismiss: (id?: string | number) => sonnerToast.dismiss(id),
	},
);

const Toaster = ({ ...props }: ToasterProps) => {
	const { theme = "system" } = useTheme();

	return (
		<Sonner
			theme={theme as ToasterProps["theme"]}
			position="bottom-center"
			className="toaster group"
			{...props}
		/>
	);
};

export { Toaster, toast };
