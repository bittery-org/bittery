import { cva, type VariantProps } from "class-variance-authority";
import { Slot as SlotPrimitive } from "radix-ui";
import type * as React from "react";
import { cn } from "../lib/utils.js";

const buttonVariants = cva(
	"inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium text-sm outline-none transition-all duration-120 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/30 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
	{
		variants: {
			variant: {
				default:
					"bg-linear-to-b from-primary to-primary-deep text-primary-foreground shadow-[inset_0_1px_0_oklch(1_0_0/0.22),0_1px_2px_oklch(0_0_0/0.3)] hover:brightness-108 dark:shadow-[inset_0_1px_0_oklch(1_0_0/0.22),0_1px_2px_oklch(0_0_0/0.3),0_0_14px_oklch(0.58_0.185_292/0.35)] dark:hover:shadow-[inset_0_1px_0_oklch(1_0_0/0.22),0_1px_2px_oklch(0_0_0/0.3),0_0_20px_oklch(0.58_0.185_292/0.5)]",
				destructive:
					"bg-destructive text-white shadow-[inset_0_1px_0_oklch(1_0_0/0.22),0_1px_2px_oklch(0_0_0/0.3)] hover:brightness-108 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40",
				outline: "border bg-transparent hover:bg-accent hover:text-accent-foreground",
				secondary:
					"bg-secondary text-secondary-foreground hover:bg-secondary/80",
				ghost:
					"text-muted-foreground hover:bg-accent hover:text-foreground dark:hover:bg-accent/50",
				link: "text-primary underline-offset-4 hover:underline",
			},
			size: {
				default: "h-8 gap-1.5 px-3 has-[>svg]:px-2.5",
				sm: "h-7 gap-1.5 rounded-md px-2.5 has-[>svg]:px-2",
				lg: "h-9 rounded-md px-4 has-[>svg]:px-3.5",
				icon: "size-8 rounded-md",
			},
		},
		defaultVariants: {
			variant: "default",
			size: "default",
		},
	},
);

function Button({
	className,
	variant,
	size,
	asChild = false,
	...props
}: React.ComponentProps<"button"> &
	VariantProps<typeof buttonVariants> & {
		asChild?: boolean;
	}) {
	const Comp = asChild ? SlotPrimitive.Slot : "button";

	return (
		<Comp
			data-slot="button"
			className={cn(buttonVariants({ variant, size, className }))}
			{...props}
		/>
	);
}

export { Button, buttonVariants };
