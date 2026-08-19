/**
 * Account identity: the brand gradient with initials, or the team's own image when it has
 * one. Accounts never take a name-hashed gradient — purple is what "your account" looks
 * like, and a hashed one would make two accounts look like two different products.
 *
 * Ported from `apps/mobile/src/components/auth-kit.tsx`.
 */

import { cn } from "@bittery/ui/lib/utils";
import type { AccountMetadata } from "@/lib/storage";
import { GradientTile } from "./brand";
import { layout } from "./theme";

/**
 * teamName → name → email local part, first letters of up to two words. A raw email is
 * never sliced whole, because that produces "j." artifacts.
 */
export function getAccountInitials(account?: AccountMetadata | null): string {
	if (!account) return "?";

	const source =
		account.teamName || account.name || account.email.split("@")[0];
	const words = (source ?? "")
		.split(/[\s._-]+/)
		.filter(Boolean)
		.slice(0, 2);

	if (words.length === 0) return "?";

	return words
		.map((word) => word.charAt(0))
		.join("")
		.toUpperCase();
}

/** The label an account shows in lists and pickers. */
export function getAccountLabel(
	account: AccountMetadata,
	fallback: string,
): string {
	return account.teamName || account.name || account.email || fallback;
}

export function AccountAvatar({
	account,
	size = layout.iconTile,
	radius = 14,
	glow = false,
	className,
}: {
	account?: AccountMetadata | null;
	size?: number;
	radius?: number;
	glow?: boolean;
	className?: string;
}) {
	return (
		<GradientTile
			name="Bittery"
			brand
			glow={glow}
			size={size}
			radius={radius}
			className={className}
		>
			{account?.teamAvatarUrl ? (
				<img
					src={account.teamAvatarUrl}
					alt=""
					className="absolute size-full object-cover"
					style={{ borderRadius: radius }}
				/>
			) : (
				<span
					className={cn(
						"font-semibold text-white",
						size >= 48 ? "text-base" : "text-sm",
					)}
				>
					{getAccountInitials(account)}
				</span>
			)}
		</GradientTile>
	);
}
