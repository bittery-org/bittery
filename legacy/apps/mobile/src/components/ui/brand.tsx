/**
 * The sanctioned brand moments — everything purple that is not a primary action, a focus
 * ring or a selection lives here. Ported from `apps/mobile/src/components/ui/brand.tsx`;
 * the native version paints these with `react-native-svg`, the WebView uses CSS gradients,
 * which is both cheaper and sharper at any density.
 *
 * See `apps/mobile/DESIGN-NATIVE.md` § Brand moments. Anything else purple needs sign-off.
 */

import { cn } from "@bittery/ui/lib/utils";
import type { CSSProperties, ReactNode } from "react";
import { layout } from "./theme";

/**
 * Radial `primary-deep` wash pinned to the top of a screen. Items, Browse, auth and unlock
 * only — it is the app's signature, so spending it on every screen spends it on none.
 */
export function Aurora({
	height = 220,
	className,
}: {
	height?: number;
	className?: string;
}) {
	return (
		<div
			aria-hidden
			className={cn(
				"pointer-events-none absolute inset-x-0 top-0 z-0",
				className,
			)}
			style={{
				height,
				background:
					"radial-gradient(115% 100% at 50% 0%, color-mix(in oklab, var(--primary-deep) 14%, transparent) 0%, color-mix(in oklab, var(--primary-deep) 5%, transparent) 55%, transparent 100%)",
			}}
		/>
	);
}

/** The `primary-deep` wash + hairline for a sheet or dialog. Parked on `MobileSheet`. */
export function SheetBrandAccent({ height = 96 }: { height?: number }) {
	return (
		<div
			aria-hidden
			className="pointer-events-none absolute inset-x-0 top-0 z-0"
			style={{ height }}
		>
			<div
				className="absolute inset-0"
				style={{
					background:
						"linear-gradient(to bottom, color-mix(in oklab, var(--primary-deep) 20%, transparent), transparent)",
				}}
			/>
			<div
				className="absolute inset-x-0 top-0 h-px"
				style={{
					background:
						"linear-gradient(to right, transparent, color-mix(in oklab, var(--primary-deep) 55%, transparent), transparent)",
				}}
			/>
		</div>
	);
}

/** The glowing 2px indicator that marks a selected nav or list row. */
export function GlowBar({ className }: { className?: string }) {
	return (
		<span
			aria-hidden
			className={cn(
				"pointer-events-none absolute top-1.5 bottom-1.5 left-0 w-0.5 rounded-full bg-primary",
				"dark:shadow-[0_0_6px_0_var(--primary)]",
				className,
			)}
		/>
	);
}

/**
 * Deterministic 135° gradient stops (mid → deep), the same 17-colour table desktop hashes
 * against in `packages/ui/src/components/vault-avatar.tsx`. Keep them in sync: a vault must
 * not change colour when the user moves between devices.
 */
const GRADIENT_STOPS: ReadonlyArray<readonly [string, string]> = [
	["#ef4444", "#b91c1c"],
	["#f97316", "#c2410c"],
	["#f59e0b", "#b45309"],
	["#eab308", "#a16207"],
	["#84cc16", "#4d7c0f"],
	["#22c55e", "#15803d"],
	["#10b981", "#047857"],
	["#14b8a6", "#0f766e"],
	["#06b6d4", "#0e7490"],
	["#0ea5e9", "#0369a1"],
	["#3b82f6", "#1d4ed8"],
	["#6366f1", "#4338ca"],
	["#8b5cf6", "#6d28d9"],
	["#a855f7", "#7e22ce"],
	["#d946ef", "#a21caf"],
	["#ec4899", "#be185d"],
	["#f43f5e", "#be123c"],
];

export function getGradientForName(name: string): readonly [string, string] {
	let hash = 0;
	for (let i = 0; i < name.length; i++) {
		hash = name.charCodeAt(i) + ((hash << 5) - hash);
	}
	return (
		GRADIENT_STOPS[Math.abs(hash) % GRADIENT_STOPS.length] ?? [
			"#6b7280",
			"#374151",
		]
	);
}

interface GradientTileProps {
	/** Hashed to pick the gradient. Ignored when `brand` is set. */
	name: string;
	size?: number;
	radius?: number;
	/** Accounts and primary brand tiles always take the purple gradient, never a hash. */
	brand?: boolean;
	/** Adds the purple halo used on item-detail and unlock headers. */
	glow?: boolean;
	children?: ReactNode;
	className?: string;
}

/**
 * Gradient tile with a 12% inset ring instead of a border, white glyph inside. The ring is
 * `inset` box-shadow rather than a border so it never eats into the tile's own size.
 */
export function GradientTile({
	name,
	size = layout.iconTile,
	radius = 12,
	brand = false,
	glow = false,
	children,
	className,
}: GradientTileProps) {
	const [mid, deep] = brand
		? (["var(--primary)", "var(--primary-deep)"] as const)
		: getGradientForName(name || "Bittery");

	const style: CSSProperties = {
		width: size,
		height: size,
		borderRadius: radius,
		backgroundImage: `linear-gradient(135deg, ${mid}, ${deep})`,
		boxShadow: glow
			? `inset 0 0 0 1px rgb(255 255 255 / 0.12), 0 6px 16px -4px ${deep === "var(--primary-deep)" ? "color-mix(in oklab, var(--primary-deep) 45%, transparent)" : `${deep}73`}`
			: "inset 0 0 0 1px rgb(255 255 255 / 0.12)",
	};

	return (
		<div
			className={cn(
				"flex shrink-0 items-center justify-center overflow-hidden text-white",
				className,
			)}
			style={style}
		>
			{children}
		</div>
	);
}
