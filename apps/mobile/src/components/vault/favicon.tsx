/**
 * The leading visual of every item row and of the item-detail header: the site favicon when the
 * item has a URL, otherwise a deterministic gradient tile carrying the category glyph. Ported
 * from `apps/mobile/src/components/item-icon.tsx`.
 *
 * It keeps the prop surface of `@bittery/ui`'s `VaultFavicon`, which it used to wrap, so callers
 * can go on passing `url` / `serverUrl` / `category` / `cardBrand` — only the painting changed.
 * What the desktop component had and this does not: an initials fallback and a per-brand credit
 * card colour. Both are replaced by the hashed gradient, because a phone list wants exactly one
 * identity language (DESIGN-NATIVE.md § Brand moments 4) and two competing ones read as noise.
 */

import { getFaviconUrl, getItemFaviconUrl } from "@bittery/shared/favicon";
import type {
	DecryptedItemWithContext,
	ItemCategory,
} from "@bittery/shared/types";
import {
	IconClock,
	IconCreditCard,
	IconFileLock,
	IconKey,
	IconUser,
} from "@bittery/ui/icons";
import { cn } from "@bittery/ui/lib/utils";
import { type ComponentType, useState } from "react";
import { GradientTile } from "@/components/ui";
import { readCurrentAuthServerUrl } from "@/lib/auth-server";

const CATEGORY_GLYPHS: Record<
	ItemCategory,
	ComponentType<{ className?: string }>
> = {
	login: IconKey,
	"credit-card": IconCreditCard,
	identity: IconUser,
	"secure-note": IconFileLock,
	totp: IconClock,
};

const SIZES = {
	sm: { tile: 32, radius: 9, glyph: "size-4", favicon: 32, pad: "p-1" },
	md: { tile: 40, radius: 12, glyph: "size-5", favicon: 32, pad: "p-1.5" },
	lg: { tile: 56, radius: 16, glyph: "size-7", favicon: 64, pad: "p-2.5" },
} as const;

interface FaviconProps {
	item?: Pick<
		DecryptedItemWithContext,
		"url" | "category" | "serverUrl" | "account"
	> & { title?: string };
	url?: string;
	/** Hashed to pick the fallback gradient. Falls back to the item's own title, then its URL. */
	title?: string;
	serverUrl?: string;
	category?: ItemCategory;
	/** Accepted for source compatibility with the detail header; the gradient ignores it. */
	cardBrand?: string;
	size?: keyof typeof SIZES;
	/** The purple halo of brand moment #5. Item-detail header only. */
	glow?: boolean;
	className?: string;
}

export function Favicon({
	item,
	url,
	title,
	serverUrl,
	category = "login",
	size = "md",
	glow = false,
	className,
}: FaviconProps) {
	// Remembering the URL that failed, rather than a boolean, means a row whose item changes
	// under it re-tries the new favicon instead of staying stuck on the gradient.
	const [failedFaviconUrl, setFailedFaviconUrl] = useState<string | null>(null);

	const { tile, radius, glyph, favicon, pad } = SIZES[size];
	const resolvedCategory = item?.category ?? category;
	const Glyph = CATEGORY_GLYPHS[resolvedCategory];

	// The active auth server is the base for the favicon proxy, as on desktop.
	const fallbackServerUrl = serverUrl ?? readCurrentAuthServerUrl();
	const faviconUrl =
		resolvedCategory === "login"
			? item
				? getItemFaviconUrl(item, favicon, fallbackServerUrl)
				: url
					? getFaviconUrl(url, favicon, fallbackServerUrl)
					: null
			: null;

	if (faviconUrl && failedFaviconUrl !== faviconUrl) {
		return (
			<div
				className={cn(
					// Padded rather than bleed-to-edge: most favicons are already artwork with
					// their own margin, and a 56px one touching the corners reads as a crop.
					"flex shrink-0 items-center justify-center overflow-hidden border border-border bg-surface-secondary",
					pad,
					className,
				)}
				style={{
					width: tile,
					height: tile,
					borderRadius: radius,
					// The halo of brand moment #5, in neutral: the tile is the site's colour
					// here, so the glow stays a plain depth shadow rather than a purple one.
					boxShadow: glow ? "0 6px 16px -4px rgb(0 0 0 / 0.35)" : undefined,
				}}
			>
				<img
					src={faviconUrl}
					alt=""
					className="size-full object-contain"
					onError={() => setFailedFaviconUrl(faviconUrl)}
				/>
			</div>
		);
	}

	const gradientName =
		title ?? item?.title ?? item?.url ?? url ?? resolvedCategory;

	return (
		<GradientTile
			name={gradientName}
			size={tile}
			radius={radius}
			glow={glow}
			className={className}
		>
			<Glyph className={glyph} />
		</GradientTile>
	);
}
