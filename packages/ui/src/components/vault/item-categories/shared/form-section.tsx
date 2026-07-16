import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../../../lib/utils";

interface FormSectionProps {
	label?: string;
	action?: ReactNode;
	children: ReactNode;
	className?: string;
}

/**
 * A form section rendered inside the FormWrapper scroll area. Sections are
 * separated by full-bleed hairline dividers (divide-y on the scroll
 * container), so each section owns the horizontal padding.
 */
export function FormSection({
	label,
	action,
	children,
	className,
}: FormSectionProps) {
	return (
		<section className={cn("px-6 py-5", className)}>
			{(label || action) && (
				<div className="mb-3.5 flex min-h-5 items-center justify-between gap-3">
					{label && (
						<h3 className="font-semibold text-[10.5px] text-muted-foreground uppercase tracking-[0.06em]">
							{label}
						</h3>
					)}
					{action}
				</div>
			)}
			<div className="space-y-4">{children}</div>
		</section>
	);
}

/**
 * Dashed "add another X" row used at the end of repeatable groups
 * (websites, phone numbers, addresses, custom fields, 2FA).
 */
export function FormAddRow({
	className,
	children,
	...props
}: ComponentProps<"button">) {
	return (
		<button
			type="button"
			className={cn(
				"flex h-9 w-full items-center justify-center gap-2 rounded-lg border border-dashed text-muted-foreground text-sm transition-colors hover:border-border-strong hover:bg-foreground/3 hover:text-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/30 focus-visible:outline-none",
				className,
			)}
			{...props}
		>
			{children}
		</button>
	);
}
