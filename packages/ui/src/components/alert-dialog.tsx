"use client";

import type { VariantProps } from "class-variance-authority";
import { AlertDialog as AlertDialogPrimitive } from "radix-ui";
import type * as React from "react";
import { cn } from "../lib/utils";
import { buttonVariants } from "./button";
import { DialogBrandAccent } from "./dialog";

function AlertDialog({
	...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Root>) {
	return <AlertDialogPrimitive.Root data-slot="alert-dialog" {...props} />;
}

function AlertDialogTrigger({
	...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Trigger>) {
	return (
		<AlertDialogPrimitive.Trigger data-slot="alert-dialog-trigger" {...props} />
	);
}

function AlertDialogPortal({
	...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Portal>) {
	return (
		<AlertDialogPrimitive.Portal data-slot="alert-dialog-portal" {...props} />
	);
}

function AlertDialogOverlay({
	className,
	...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Overlay>) {
	return (
		<AlertDialogPrimitive.Overlay
			data-slot="alert-dialog-overlay"
			className={cn(
				"data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-black/60 data-[state=closed]:animate-out data-[state=open]:animate-in",
				className,
			)}
			{...props}
		/>
	);
}

function AlertDialogContent({
	className,
	children,
	...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Content>) {
	return (
		<AlertDialogPortal>
			<AlertDialogOverlay />
			<AlertDialogPrimitive.Content
				data-slot="alert-dialog-content"
				className={cn(
					"data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 fixed top-[50%] left-[50%] z-50 grid w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 overflow-hidden rounded-xl border bg-popover p-6 shadow-pop duration-[130ms] data-[state=closed]:animate-out data-[state=open]:animate-in sm:max-w-lg",
					className,
				)}
				{...props}
			>
				<DialogBrandAccent />
				{children}
			</AlertDialogPrimitive.Content>
		</AlertDialogPortal>
	);
}

function AlertDialogHeader({
	className,
	...props
}: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="alert-dialog-header"
			className={cn("flex flex-col gap-2 text-center sm:text-left", className)}
			{...props}
		/>
	);
}

function AlertDialogFooter({
	className,
	...props
}: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="alert-dialog-footer"
			className={cn(
				"flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
				className,
			)}
			{...props}
		/>
	);
}

function AlertDialogTitle({
	className,
	...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Title>) {
	return (
		<AlertDialogPrimitive.Title
			data-slot="alert-dialog-title"
			className={cn("font-semibold text-base tracking-tight", className)}
			{...props}
		/>
	);
}

function AlertDialogDescription({
	className,
	...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Description>) {
	return (
		<AlertDialogPrimitive.Description
			data-slot="alert-dialog-description"
			className={cn("text-muted-foreground text-sm", className)}
			{...props}
		/>
	);
}

/**
 * The variant has to be chosen here, not pasted over as a className: the default
 * button paints a `bg-linear-to-b from-primary` gradient, and a background
 * *image* and a background *colour* are different Tailwind groups, so a
 * `bg-destructive` appended afterwards loses under the gradient rather than
 * replacing it. Every destructive confirm button in the app was rendering
 * primary purple because of it.
 */
function AlertDialogAction({
	className,
	variant,
	size,
	...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Action> &
	VariantProps<typeof buttonVariants>) {
	return (
		<AlertDialogPrimitive.Action
			className={cn(buttonVariants({ variant, size }), className)}
			{...props}
		/>
	);
}

function AlertDialogCancel({
	className,
	variant = "outline",
	size,
	...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Cancel> &
	VariantProps<typeof buttonVariants>) {
	return (
		<AlertDialogPrimitive.Cancel
			className={cn(buttonVariants({ variant, size }), className)}
			{...props}
		/>
	);
}

export {
	AlertDialog,
	AlertDialogPortal,
	AlertDialogOverlay,
	AlertDialogTrigger,
	AlertDialogContent,
	AlertDialogHeader,
	AlertDialogFooter,
	AlertDialogTitle,
	AlertDialogDescription,
	AlertDialogAction,
	AlertDialogCancel,
};
