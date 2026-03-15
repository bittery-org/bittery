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
import { cn } from "@bittery/ui";
import {
	IconCreditCardLockOutlineDuo18 as CreditCard,
	IconFileLockOutlineDuo18 as FileText,
	IconEarthOutlineDuo18 as Globe,
	IconCircleKeyOutlineDuo18 as KeyRound,
	IconUserOutlineDuo18 as User,
} from "@bittery/ui/icons";
import { useState } from "react";
import { getServerUrl } from "@/lib/auth-server";

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
		return (words[0][0] + words[1][0]).toUpperCase();
	}

	return cleaned.slice(0, 2).toUpperCase();
}

/**
 * Generates a consistent color based on the title
 */
function getAvatarColor(title: string): string {
	const colors = [
		"bg-red-100",
		"bg-orange-100",
		"bg-amber-100",
		"bg-yellow-100",
		"bg-lime-100",
		"bg-green-100",
		"bg-emerald-100",
		"bg-teal-100",
		"bg-cyan-100",
		"bg-sky-100",
		"bg-blue-100",
		"bg-indigo-100",
		"bg-violet-100",
		"bg-purple-100",
		"bg-fuchsia-100",
		"bg-pink-100",
		"bg-rose-100",
	];

	if (!title) return "bg-gray-100";

	let hash = 0;
	for (let i = 0; i < title.length; i++) {
		hash = title.charCodeAt(i) + ((hash << 5) - hash);
	}

	return colors[Math.abs(hash) % colors.length];
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

	const faviconSizeMap = {
		sm: 32,
		md: 32,
		lg: 64,
	} as const;
	const resolvedServerUrl = item
		? getItemServerUrl(item, serverUrl ?? getServerUrl())
		: (serverUrl ?? getServerUrl());
	const resolvedUrl = item?.url ?? url;
	const resolvedCategory = item?.category ?? category;
	const resolvedTitle = item?.title ?? title ?? "";

	const faviconUrl =
		resolvedUrl && resolvedCategory === "login"
			? item
				? getItemFaviconUrl(
						item,
						faviconSizeMap[size],
						serverUrl ?? getServerUrl(),
					)
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
		sm: 16,
		md: 20,
		lg: 24,
	};

	const imageSizes = {
		sm: "w-4 h-4",
		md: "w-5 h-5",
		lg: "w-8 h-8",
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
				"flex shrink-0 items-center justify-center overflow-hidden rounded-lg border",
				sizeClasses[size],
				resolvedCategory === "credit-card"
					? cardColor
					: imageError || !faviconUrl
						? avatarColor
						: "bg-muted/50",
				className,
			)}
		>
			{resolvedCategory === "login" && faviconUrl && !imageError ? (
				<img
					src={faviconUrl}
					alt=""
					className={imageSizes[size]}
					onError={() => setImageError(true)}
				/>
			) : resolvedCategory === "login" && resolvedUrl ? (
				<span className="select-none font-semibold text-zinc-700">
					{initials}
				</span>
			) : resolvedCategory === "login" ? (
				<Globe className="text-muted-foreground" size={iconSizes[size]} />
			) : resolvedCategory === "credit-card" ? (
				<CreditCard className="text-white" size={iconSizes[size]} />
			) : resolvedCategory === "identity" ? (
				<User className="text-muted-foreground" size={iconSizes[size]} />
			) : resolvedCategory === "totp" ? (
				<KeyRound className="text-muted-foreground" size={iconSizes[size]} />
			) : (
				<FileText className="text-muted-foreground" size={iconSizes[size]} />
			)}
		</div>
	);
}
