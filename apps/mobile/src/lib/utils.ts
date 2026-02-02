import { twMerge } from "tailwind-merge";

/**
 * Merge Tailwind CSS classes with conflict resolution
 */
export function cn(...inputs: (string | undefined | null | false)[]): string {
	return twMerge(inputs.filter(Boolean).join(" "));
}
