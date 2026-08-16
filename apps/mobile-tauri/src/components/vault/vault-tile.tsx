/**
 * Vault identity tile: the uploaded image, the chosen glyph, or hashed-gradient initials — the
 * same three-step fallback as `apps/mobile/src/components/vault-avatar.tsx`.
 *
 * Shared by Browse, search results and the trash list, so it lives here rather than beside any
 * one of them.
 */

import {
	IconBriefcase,
	IconFolder,
	IconHeart,
	IconKey,
	IconLock,
	IconShieldCheck,
	IconStar,
	IconUsers,
} from "@bittery/ui/icons";
import { cn } from "@bittery/ui/lib/utils";
import type { ComponentType } from "react";
import { GradientTile, iconClass } from "@/components/ui";

const VAULT_GLYPHS: Record<string, ComponentType<{ className?: string }>> = {
	lock: IconLock,
	shield: IconShieldCheck,
	users: IconUsers,
	briefcase: IconBriefcase,
	key: IconKey,
	folder: IconFolder,
	star: IconStar,
	heart: IconHeart,
};

function getInitials(name: string): string {
	const parts = name.trim().split(/\s+/).filter(Boolean);
	if (parts.length === 0) return "?";
	if (parts.length >= 2) {
		return `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}`.toUpperCase();
	}
	return name.slice(0, 2).toUpperCase();
}

export function VaultTile({
	name,
	icon,
	imageUrl,
	type,
	size = 40,
	radius = 12,
	className,
}: {
	name: string;
	icon?: string | null;
	imageUrl?: string | null;
	type?: "personal" | "team";
	size?: number;
	radius?: number;
	className?: string;
}) {
	const Glyph = icon ? VAULT_GLYPHS[icon] : undefined;
	// The tile doubles as a 16pt inline marker in the trash list, where a row-sized glyph would
	// overflow it.
	const isCompact = size < 32;
	const glyphClass = isCompact ? "size-2.5" : iconClass.bar;

	if (imageUrl) {
		return (
			<div
				className={cn(
					"flex shrink-0 items-center justify-center overflow-hidden border border-border bg-surface-secondary",
					className,
				)}
				style={{ width: size, height: size, borderRadius: radius }}
			>
				<img src={imageUrl} alt="" className="size-full object-cover" />
			</div>
		);
	}

	return (
		<GradientTile
			name={name || "Vault"}
			size={size}
			radius={radius}
			className={className}
		>
			{Glyph ? (
				<Glyph className={glyphClass} />
			) : type === "team" ? (
				<IconUsers className={glyphClass} />
			) : (
				<span
					className={cn(
						"font-semibold text-white",
						isCompact ? "text-2xs" : "text-sm",
					)}
				>
					{getInitials(name)}
				</span>
			)}
		</GradientTile>
	);
}
