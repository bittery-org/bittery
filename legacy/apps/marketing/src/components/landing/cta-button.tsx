import { ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";

/** The brand primary button — gradient, inset highlight, purple glow in dark. */
export function PrimaryCta({
	href,
	children,
	size = "md",
	className,
}: {
	href: string;
	children: React.ReactNode;
	size?: "md" | "lg";
	className?: string;
}) {
	return (
		<a
			href={href}
			className={cn(
				"inline-flex items-center justify-center gap-2 rounded-md bg-linear-to-b from-primary to-primary-deep font-medium text-primary-foreground shadow-[inset_0_1px_0_oklch(1_0_0/0.22),0_1px_2px_oklch(0_0_0/0.3)] transition-[filter,box-shadow] duration-150 hover:brightness-108 dark:shadow-[inset_0_1px_0_oklch(1_0_0/0.22),0_1px_2px_oklch(0_0_0/0.3),0_0_16px_color-mix(in_oklab,var(--color-primary-deep)_35%,transparent)] dark:hover:shadow-[inset_0_1px_0_oklch(1_0_0/0.22),0_1px_2px_oklch(0_0_0/0.3),0_0_24px_color-mix(in_oklab,var(--color-primary-deep)_50%,transparent)]",
				size === "lg" ? "h-10 px-5 text-[14.5px]" : "h-8 px-3.5 text-[13.5px]",
				className,
			)}
		>
			{children}
		</a>
	);
}

/** Quiet text link with a brand arrow. */
export function ArrowLink({
	href,
	children,
	className,
}: {
	href: string;
	children: React.ReactNode;
	className?: string;
}) {
	return (
		<a
			href={href}
			className={cn(
				"group inline-flex items-center gap-1.5 font-medium text-[14px] text-muted-foreground transition-colors duration-150 hover:text-foreground",
				className,
			)}
		>
			{children}
			<ArrowRight className="size-3.5 text-primary transition-transform duration-150 group-hover:translate-x-0.5" />
		</a>
	);
}
