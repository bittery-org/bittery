import { getDomainFromUrl, getFaviconUrl } from "@bittery/shared/favicon";
import { cn } from "@bittery/ui";
import { FileText, Globe } from "lucide-react";
import { useState } from "react";

interface FaviconProps {
  url?: string;
  title: string;
  category?: "login" | "secure-note";
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
    "bg-red-500",
    "bg-orange-500",
    "bg-amber-500",
    "bg-yellow-500",
    "bg-lime-500",
    "bg-green-500",
    "bg-emerald-500",
    "bg-teal-500",
    "bg-cyan-500",
    "bg-sky-500",
    "bg-blue-500",
    "bg-indigo-500",
    "bg-violet-500",
    "bg-purple-500",
    "bg-fuchsia-500",
    "bg-pink-500",
    "bg-rose-500",
  ];

  if(!title) return "bg-gray-500";

  let hash = 0;
  for (let i = 0; i < title.length; i++) {
    hash = title.charCodeAt(i) + ((hash << 5) - hash);
  }

  return colors[Math.abs(hash) % colors.length];
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

  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden rounded-lg border",
        sizeClasses[size],
        imageError || !faviconUrl ? avatarColor : "bg-muted/50",
        className
      )}
    >
      {category === "login" && faviconUrl && !imageError ? (
        <img
          src={faviconUrl}
          alt=""
          className={imageSizes[size]}
          onError={() => setImageError(true)}
        />
      ) : category === "login" && url ? (
        <span className="select-none font-semibold text-white">{initials}</span>
      ) : category === "login" ? (
        <Globe className="text-muted-foreground" size={iconSizes[size]} />
      ) : (
        <FileText className="text-muted-foreground" size={iconSizes[size]} />
      )}
    </div>
  );
}
