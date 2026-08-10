import { useThemeColor } from "heroui-native";
import { View } from "react-native";
import Svg, {
	Defs,
	LinearGradient,
	RadialGradient,
	Rect,
	Stop,
} from "react-native-svg";
import { useUniwind } from "uniwind";
import { cn } from "@/lib/utils";
import { useBrandColor } from "./theme";

/**
 * Sanctioned brand moments. Everything purple that is not a primary action, a
 * focus ring or a selection lives here — see DESIGN-NATIVE.md.
 */

interface AuroraProps {
	/** How far down the wash reaches. */
	height?: number;
	className?: string;
}

/** Radial accent-deep wash pinned to the top of a screen. */
export function Aurora({ height = 220, className }: AuroraProps) {
	const { theme } = useUniwind();
	const [accentDeep] = useBrandColor(["accentDeep"]);
	const peak = theme === "dark" ? 0.14 : 0.08;

	return (
		<View
			pointerEvents="none"
			className={cn("absolute top-0 right-0 left-0", className)}
			style={{ height }}
		>
			<Svg width="100%" height="100%">
				<Defs>
					<RadialGradient id="aurora" cx="50%" cy="0%" rx="85%" ry="100%">
						<Stop offset="0" stopColor={accentDeep} stopOpacity={peak} />
						<Stop offset="0.55" stopColor={accentDeep} stopOpacity={peak / 3} />
						<Stop offset="1" stopColor={accentDeep} stopOpacity={0} />
					</RadialGradient>
				</Defs>
				<Rect x="0" y="0" width="100%" height="100%" fill="url(#aurora)" />
			</Svg>
		</View>
	);
}

/** The accent-deep wash + accent hairline that tops every sheet and dialog. */
export function SheetBrandAccent({ height = 96 }: { height?: number }) {
	const [accentDeep] = useBrandColor(["accentDeep"]);

	return (
		<View
			pointerEvents="none"
			className="absolute top-0 right-0 left-0"
			style={{ height }}
		>
			<Svg width="100%" height="100%">
				<Defs>
					<LinearGradient id="sheetWash" x1="0" y1="0" x2="0" y2="1">
						<Stop offset="0" stopColor={accentDeep} stopOpacity={0.2} />
						<Stop offset="1" stopColor={accentDeep} stopOpacity={0} />
					</LinearGradient>
					<LinearGradient id="sheetLine" x1="0" y1="0" x2="1" y2="0">
						<Stop offset="0" stopColor={accentDeep} stopOpacity={0} />
						<Stop offset="0.5" stopColor={accentDeep} stopOpacity={0.55} />
						<Stop offset="1" stopColor={accentDeep} stopOpacity={0} />
					</LinearGradient>
				</Defs>
				<Rect x="0" y="0" width="100%" height="100%" fill="url(#sheetWash)" />
				<Rect x="0" y="0" width="100%" height="1" fill="url(#sheetLine)" />
			</Svg>
		</View>
	);
}

/** The glowing 2px indicator that marks a selected nav or list row. */
export function GlowBar({ className }: { className?: string }) {
	const { theme } = useUniwind();
	const accent = useThemeColor("accent");

	return (
		<View
			pointerEvents="none"
			className={cn(
				"absolute top-1.5 bottom-1.5 left-0 w-0.5 rounded-full bg-accent",
				className,
			)}
			style={
				theme === "dark"
					? {
							shadowColor: accent,
							shadowOpacity: 0.8,
							shadowRadius: 6,
							shadowOffset: { width: 0, height: 0 },
							elevation: 4,
						}
					: undefined
			}
		/>
	);
}

/**
 * Deterministic 135° gradient stops (mid → deep) shared with desktop —
 * `packages/ui/src/components/vault-avatar.tsx` holds the same table.
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
	/** Hashed to pick the gradient. Ignored when `accent` is set. */
	name: string;
	size?: number;
	radius?: number;
	/** Accounts and primary brand tiles always use the purple gradient. */
	accent?: boolean;
	/** Adds the purple halo used on item-detail headers. */
	glow?: boolean;
	children?: React.ReactNode;
	className?: string;
}

/** Gradient tile with a 12% inset ring instead of a border, white glyph inside. */
export function GradientTile({
	name,
	size = 40,
	radius = 12,
	accent = false,
	glow = false,
	children,
	className,
}: GradientTileProps) {
	const [accentDeep] = useBrandColor(["accentDeep"]);
	const accentColor = useThemeColor("accent");
	const [mid, deep] = accent
		? ([accentColor, accentDeep] as const)
		: getGradientForName(name || "Bittery");
	const gradientId = `tile-${accent ? "accent" : mid.replace("#", "")}`;

	return (
		<View
			className={cn("items-center justify-center overflow-hidden", className)}
			style={[
				{ width: size, height: size, borderRadius: radius },
				glow
					? {
							shadowColor: deep,
							shadowOpacity: 0.5,
							shadowRadius: 12,
							shadowOffset: { width: 0, height: 4 },
							elevation: 6,
						}
					: null,
			]}
		>
			<Svg width={size} height={size} style={{ position: "absolute" }}>
				<Defs>
					<LinearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
						<Stop offset="0" stopColor={mid} />
						<Stop offset="1" stopColor={deep} />
					</LinearGradient>
				</Defs>
				<Rect
					x="0"
					y="0"
					width={size}
					height={size}
					rx={radius}
					fill={`url(#${gradientId})`}
				/>
			</Svg>
			<View
				pointerEvents="none"
				className="absolute inset-0"
				style={{
					borderRadius: radius,
					borderWidth: 1,
					borderColor: "rgba(255,255,255,0.12)",
				}}
			/>
			{children}
		</View>
	);
}
