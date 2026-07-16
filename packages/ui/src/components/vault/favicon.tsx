import {
	getDomainFromUrl,
	getFaviconUrl,
	getItemFaviconUrl,
	getItemServerUrl,
} from "@bittery/shared/favicon";
import type {
	DecryptedItemWithContext,
	ItemCategory,
} from "@bittery/shared/types";
import {
	IconCreditCardLockOutlineDuo18,
	IconEarthOutlineDuo18,
	IconFileLockOutlineDuo18,
	IconMobileOutlineDuo18,
	IconUserOutlineDuo18,
} from "../../icons";
import {
	analyzeFaviconLuminance,
	getFaviconGradient,
	readCachedLuminance,
} from "../../lib/favicon-luminance";
import { cn } from "../../lib/utils";
import { useState } from "react";

interface VaultFaviconProps {
	item?: Pick<
		DecryptedItemWithContext,
		"url" | "category" | "serverUrl" | "account"
	> & {
		title?: string;
	};
	url?: string;
	title?: string;
	serverUrl?: string;
	defaultServerUrl?: string;
	category?: ItemCategory;
	cardBrand?: string;
	size?: "sm" | "md" | "lg";
	className?: string;
}

function getInitials(title: string): string {
	if (!title) return "??";

	const cleaned = title.trim();
	if (!cleaned) return "??";

	const words = cleaned.split(/\s+/);

	if (words.length >= 2) {
		const first = words[0]?.[0] ?? cleaned[0] ?? "?";
		const second = words[1]?.[0] ?? cleaned[1] ?? first;
		return `${first}${second}`.toUpperCase();
	}

	return cleaned.slice(0, 2).toUpperCase();
}

export function VaultFavicon({
	item,
	url,
	title,
	serverUrl,
	defaultServerUrl,
	category = "login",
	cardBrand,
	size = "md",
	className,
}: VaultFaviconProps) {
	const [failedFaviconUrl, setFailedFaviconUrl] = useState<string | null>(null);
	const [luminanceState, setLuminanceState] = useState<{
		url: string;
		result: "dark" | "light" | "unknown";
	} | null>(null);

	const faviconSizeMap = {
		sm: 64,
		md: 64,
		lg: 128,
	} as const;

	const fallbackServerUrl = serverUrl ?? defaultServerUrl;
	const resolvedServerUrl = item
		? getItemServerUrl(item, fallbackServerUrl)
		: fallbackServerUrl;
	const resolvedUrl = item?.url ?? url;
	const resolvedCategory = item?.category ?? category;
	const resolvedTitle = item?.title ?? title ?? "";

	const faviconUrl =
		resolvedUrl && resolvedCategory === "login"
			? item
				? getItemFaviconUrl(item, faviconSizeMap[size], fallbackServerUrl)
				: getFaviconUrl(resolvedUrl, faviconSizeMap[size], resolvedServerUrl)
			: null;

	const hasFaviconError = Boolean(
		faviconUrl && failedFaviconUrl === faviconUrl,
	);
	const domain = resolvedUrl ? getDomainFromUrl(resolvedUrl) : null;
	const initials = getInitials(domain || resolvedTitle);

	// Derive luminance for the currently displayed favicon URL from state.
	// Keying the cached async result by URL (rather than trusting stale
	// state) ensures that if `faviconUrl` changes before a prior analysis
	// resolves, the outdated result is simply ignored.
	const luminance =
		faviconUrl && luminanceState?.url === faviconUrl
			? luminanceState.result
			: readCachedLuminance(faviconUrl);

	const showFaviconImage =
		resolvedCategory === "login" && Boolean(faviconUrl) && !hasFaviconError;
	const showColoredFallback =
		resolvedCategory === "login" && Boolean(resolvedUrl) && !showFaviconImage;
	const [gradientMid, gradientDeep] = getFaviconGradient(
		domain || resolvedTitle,
	);

	const sizeClasses = {
		sm: "w-8 h-8 text-xs",
		md: "w-10 h-10 text-sm",
		lg: "w-12 h-12 text-base",
	};

	const radiusClasses = {
		sm: "rounded-[7px]",
		md: "rounded-lg",
		lg: "rounded-lg",
	};

	const iconSizes = {
		sm: 26,
		md: 30,
		lg: 38,
	};

	const imageSizes = {
		sm: "w-7.75 h-7.75",
		md: "w-9.75 h-9.75",
		lg: "w-10.75 h-10.75",
	};

	const cardBrandColors: Record<string, string> = {
		visa: "bg-blue-600",
		mastercard: "bg-red-600",
		amex: "bg-blue-500",
		discover: "bg-orange-600",
		diners: "bg-sky-600",
		jcb: "bg-green-600",
		unionpay: "bg-red-700",
		unknown: "bg-gray-600",
	};

	const cardColor = cardBrand
		? cardBrandColors[cardBrand] || cardBrandColors.unknown
		: cardBrandColors.unknown;

	return (
		<div
			className={cn(
				"flex shrink-0 items-center justify-center overflow-hidden",
				sizeClasses[size],
				radiusClasses[size],
				resolvedCategory === "credit-card"
					? cn(cardColor, "border")
					: showColoredFallback
						? "shadow-[inset_0_0_0_1px_oklch(1_0_0/0.12)]"
						: cn(
								"border",
								"bg-accent",
								showFaviconImage &&
									luminance === "dark" &&
									"dark:bg-white/90",
							),
				className,
			)}
			style={
				showColoredFallback
					? {
							background: `linear-gradient(135deg, ${gradientMid}, ${gradientDeep})`,
						}
					: undefined
			}
		>
			{showFaviconImage && faviconUrl ? (
				<img
					src={faviconUrl}
					alt=""
					className={cn(imageSizes[size], "rounded-lg", "object-contain")}
					onError={() => setFailedFaviconUrl(faviconUrl)}
					onLoad={() => {
						analyzeFaviconLuminance(faviconUrl).then((result) => {
							setLuminanceState({ url: faviconUrl, result });
						});
					}}
				/>
			) : resolvedCategory === "login" && resolvedUrl ? (
				<span className="select-none font-semibold text-white">
					{initials}
				</span>
			) : resolvedCategory === "login" ? (
				<IconEarthOutlineDuo18
					className="text-muted-foreground"
					size={iconSizes[size]}
				/>
			) : resolvedCategory === "credit-card" ? (
				<IconCreditCardLockOutlineDuo18
					className="text-white"
					size={iconSizes[size]}
				/>
			) : resolvedCategory === "identity" ? (
				<IconUserOutlineDuo18
					className="text-muted-foreground"
					size={iconSizes[size]}
				/>
			) : resolvedCategory === "totp" ? (
				<IconMobileOutlineDuo18
					className="text-muted-foreground"
					size={iconSizes[size]}
				/>
			) : (
				<IconFileLockOutlineDuo18
					className="text-muted-foreground"
					size={iconSizes[size]}
				/>
			)}
		</div>
	);
}

export type { VaultFaviconProps };