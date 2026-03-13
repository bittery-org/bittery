import {
	getDomainFromUrl,
	getFaviconUrl,
	getItemFaviconUrl,
	getItemServerUrl,
} from "@bittery/shared/favicon";
import type { DecryptedItemWithContext, ItemCategory } from "@bittery/shared/types";
import { cn } from "@bittery/ui";
import {
	IconCreditCardLockOutlineDuo18,
	IconEarthOutlineDuo18,
	IconFileLockOutlineDuo18,
	IconMobileOutlineDuo18,
	IconUserOutlineDuo18,
} from "@bittery/ui/icons";
import { useState } from "react";

interface FaviconProps {
	item?: Pick<
		DecryptedItemWithContext,
		"url" | "category" | "serverUrl" | "account"
	> & {
		title?: string;
	};
	url?: string;
	title?: string;
	serverUrl?: string;
	category?: ItemCategory;
	cardBrand?: string;
	size?: "sm" | "md" | "lg";
	className?: string;
}

/**
 * Generates a 2-letter avatar from a title
 */
function getInitials(title: string): string {
	if (!title) return "??";

	const cleaned = title.trim();
	if (!cleaned) return "??";

	const words = cleaned.split(/\s+/);

	if (words.length >= 2) {
		const first = words[0]?.[0] ?? "";
		const second = words[1]?.[0] ?? "";
		return (first + second).toUpperCase();
	}

	return cleaned.slice(0, 2).toUpperCase();
}

/**
 * Generates a consistent color based on the title
 */
function getAvatarColor(title: string): string {
	const colors = [
		"bg-red-50",
		"bg-orange-50",
		"bg-amber-50",
		"bg-yellow-50",
		"bg-lime-50",
		"bg-green-50",
		"bg-emerald-50",
		"bg-teal-50",
		"bg-cyan-50",
		"bg-sky-50",
		"bg-blue-50",
		"bg-indigo-50",
		"bg-violet-50",
		"bg-purple-50",
		"bg-fuchsia-50",
		"bg-pink-50",
		"bg-rose-50",
	];

	if (!title) return "bg-gray-50";

	let hash = 0;
	for (let i = 0; i < title.length; i++) {
		hash = title.charCodeAt(i) + ((hash << 5) - hash);
	}

	const color = colors[Math.abs(hash) % colors.length] ?? "bg-gray-50";

	return color;
}

export function Favicon({
	item,
	url,
	title,
	serverUrl,
	category = "login",
	cardBrand,
	size = "md",
	className,
}: FaviconProps) {
	const [imageError, setImageError] = useState(false);
	const fallbackServerUrl = "http://localhost:3000";
	const resolvedServerUrl = item
		? getItemServerUrl(item, serverUrl ?? fallbackServerUrl)
		: serverUrl ?? fallbackServerUrl;
	const resolvedUrl = item?.url ?? url;
	const resolvedCategory = item?.category ?? category;
	const resolvedTitle = item?.title ?? title ?? "";

	const faviconSizeMap = {
		sm: 64,
		md: 64,
		lg: 128,
	} as const;

	const faviconUrl =
		resolvedUrl && resolvedCategory === "login"
			? item
				? getItemFaviconUrl(item, faviconSizeMap[size], serverUrl ?? fallbackServerUrl)
				: getFaviconUrl(resolvedUrl, faviconSizeMap[size], resolvedServerUrl)
			: null;
	const domain = resolvedUrl ? getDomainFromUrl(resolvedUrl) : null;
	const initials = getInitials(domain || resolvedTitle);
	const avatarColor = getAvatarColor(domain || resolvedTitle);

	const sizeClasses = {
		sm: "w-8 h-8 text-xs",
		md: "w-10 h-10 text-sm",
		lg: "w-12 h-12 text-base",
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

	// Card brand colors
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
				"flex shrink-0 items-center justify-center overflow-hidden rounded-xl border",
				sizeClasses[size],
				resolvedCategory === "credit-card"
					? cardColor
					: imageError || !faviconUrl
						? avatarColor
						: "bg-accent",
				className,
			)}
		>
			{resolvedCategory === "login" && faviconUrl && !imageError ? (
				<img
					src={faviconUrl}
					alt=""
					className={cn(imageSizes[size], "rounded-lg", "object-contain")}
					onError={() => setImageError(true)}
				/>
			) : resolvedCategory === "login" && resolvedUrl ? (
				<span className="select-none font-semibold text-zinc-700">
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
