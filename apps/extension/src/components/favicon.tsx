/** biome-ignore-all lint/style/noNonNullAssertion: its okay */
import type { ItemCategory } from "@bittery/shared/types";
import { getDomainFromUrl, getFaviconUrl } from "@bittery/shared/favicon";
import { cn } from "@bittery/ui";
import { CreditCard, FileText, Globe, User } from "lucide-react";
import { useState } from "react";

interface FaviconProps {
	url?: string;
	title: string;
	category?: ItemCategory;
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
		return (words[0]![0]! + words[1]![0]!).toUpperCase();
	}

	return cleaned.slice(0, 2).toUpperCase();
}

/**
 * Generates a consistent color based on the title
 */
function getAvatarColor(title: string): string {
	if (!title) return "bg-gray-100";

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

	if (!title) return "bg-gray-500";

	let hash = 0;
	for (let i = 0; i < title.length; i++) {
		hash = title.charCodeAt(i) + ((hash << 5) - hash);
	}

	return colors[Math.abs(hash) % colors.length]!;
}

export function Favicon({
	url,
	title,
	category = "login",
	size = "md",
	className,
}: FaviconProps) {
	const [imageError, setImageError] = useState(false);

	const faviconSizeMap = {
		sm: 32,
		md: 32,
		lg: 64,
	} as const;

	const faviconUrl =
		url && category === "login"
			? getFaviconUrl(url, faviconSizeMap[size])
			: null;
	const domain = url ? getDomainFromUrl(url) : null;
	const initials = getInitials(domain || title);
	const avatarColor = getAvatarColor(domain || title);

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

	// Render icon based on category
	const renderIcon = () => {
		if (category === "login") {
			if (faviconUrl && !imageError) {
				return (
					<img
						src={faviconUrl}
						alt=""
						className={imageSizes[size]}
						onError={() => setImageError(true)}
					/>
				);
			}
			if (url) {
				return <span className="select-none font-semibold text-white">{initials}</span>;
			}
			return <Globe className="text-muted-foreground" size={iconSizes[size]} />;
		}

		if (category === "credit-card") {
			return <CreditCard className="text-muted-foreground" size={iconSizes[size]} />;
		}

		if (category === "identity") {
			return <User className="text-muted-foreground" size={iconSizes[size]} />;
		}

		// secure-note or default
		return <FileText className="text-muted-foreground" size={iconSizes[size]} />;
	};

	return (
		<div
			className={cn(
				"flex shrink-0 items-center justify-center overflow-hidden rounded-lg border",
				sizeClasses[size],
				imageError || !faviconUrl ? avatarColor : "bg-muted/50",
				className,
			)}
		>
			{renderIcon()}
		</div>
	);
}
