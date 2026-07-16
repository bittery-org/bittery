import {
	Check,
	FileText,
	Globe,
	Laptop,
	Lock,
	Puzzle,
	Trash2,
} from "lucide-react";
import { motion } from "motion/react";
import { Fragment } from "react";
import { billingMarketingEnabled, signupUrl } from "@/lib/urls";
import { ArrowLink, PrimaryCta } from "./cta-button";

const EASE = [0.16, 1, 0.3, 1] as const;

const STEPS = [
	{
		title: "Import in one click",
		time: "≈ 2 min",
		body: "Bring everything over from 1Password, Bitwarden, LastPass, Chrome, and most other managers. Export a file, upload it, done — items are encrypted on your device before they're stored.",
	},
	{
		title: "Sync everywhere, encrypted",
		time: "automatic",
		body: "Your vault syncs end-to-end encrypted to every device. Desktop, web, and browser extension all read the same vault — the server only ever sees ciphertext.",
	},
	{
		title: "Autofill and forget",
		time: "same day",
		body: "The extension fills logins, cards, and TOTP codes right where you need them. Your old manager can come off your devices the same day.",
	},
];

/* ---- Import demo: export file lands, progress fills, sealed on-device ---- */
const IMPORT_TIMES = [0, 0.08, 0.5, 0.58, 0.92, 1] as const;

function ImportDemo() {
	return (
		<div className="space-y-2.5">
			<div className="rounded-lg border bg-background p-3.5">
				<div className="flex items-center gap-2.5">
					<span className="flex size-7 shrink-0 items-center justify-center rounded-md border bg-foreground/3">
						<FileText className="size-3.5 text-muted-foreground" />
					</span>
					<span className="min-w-0 flex-1">
						<span className="block truncate font-mono text-[11.5px]">
							1password-export.1pux
						</span>
						<span className="block text-[10.5px] text-muted-foreground">
							142 items · logins, cards, notes
						</span>
					</span>
				</div>
				<div className="mt-3 h-1 overflow-hidden rounded-full bg-foreground/6">
					<motion.span
						aria-hidden
						className="block h-full rounded-full bg-linear-to-r from-primary to-primary-deep"
						style={{ originX: 0 }}
						animate={{ scaleX: [0, 0, 1, 1, 1, 0] }}
						transition={{
							duration: 6,
							times: [...IMPORT_TIMES],
							repeat: Number.POSITIVE_INFINITY,
						}}
					/>
				</div>
				<div className="relative mt-2 h-4 text-[10.5px]">
					<motion.span
						className="absolute inset-x-0 top-0 block truncate text-muted-foreground"
						animate={{ opacity: [1, 1, 1, 0, 0, 1] }}
						transition={{
							duration: 6,
							times: [...IMPORT_TIMES],
							repeat: Number.POSITIVE_INFINITY,
						}}
					>
						Encrypting on your device…
					</motion.span>
					<motion.span
						aria-hidden
						className="absolute inset-x-0 top-0 flex items-center gap-1 truncate font-medium text-success"
						animate={{ opacity: [0, 0, 0, 1, 1, 0] }}
						transition={{
							duration: 6,
							times: [...IMPORT_TIMES],
							repeat: Number.POSITIVE_INFINITY,
						}}
					>
						<Check className="size-2.5 shrink-0" />
						Imported — sealed before upload
					</motion.span>
				</div>
			</div>
			<div className="flex flex-wrap gap-1.5">
				{["1Password", "Bitwarden", "LastPass", "Chrome"].map((source) => (
					<span
						key={source}
						className="rounded-[4px] border bg-foreground/3 px-1.5 py-0.5 text-[10px] text-muted-foreground"
					>
						{source}
					</span>
				))}
			</div>
		</div>
	);
}

/* ---- Sync demo: pulses travel between devices, server sees ciphertext ---- */
const SYNC_DEVICES = [
	{ label: "Desktop", icon: Laptop },
	{ label: "Web", icon: Globe },
	{ label: "Extension", icon: Puzzle },
];

function SyncDemo() {
	return (
		<div className="rounded-lg border bg-background p-3.5">
			<div className="flex items-center">
				{SYNC_DEVICES.map((device, i) => (
					<Fragment key={device.label}>
						{i > 0 && (
							<span
								aria-hidden
								className="relative h-px flex-1 overflow-hidden bg-border"
							>
								<motion.span
									className="absolute top-0 h-px w-8 bg-linear-to-r from-transparent via-primary to-transparent"
									animate={{ left: ["-30%", "115%"] }}
									transition={{
										duration: 2.2,
										repeat: Number.POSITIVE_INFINITY,
										ease: "linear",
										delay: i * 0.5,
									}}
								/>
							</span>
						)}
						<span className="flex flex-col items-center gap-1.5 px-2">
							<span className="flex size-8 items-center justify-center rounded-md border bg-foreground/3 text-muted-foreground">
								<device.icon className="size-3.5" />
							</span>
							<span className="text-[10px] text-muted-foreground">
								{device.label}
							</span>
						</span>
					</Fragment>
				))}
			</div>
			<div className="mt-3 flex items-center gap-2 border-t pt-2.5 text-[10.5px] text-muted-foreground">
				<Lock className="size-3 shrink-0 text-success" />
				<span className="truncate">
					Server stores <span className="font-mono">9f3a…c14b</span> —
					ciphertext only
				</span>
			</div>
		</div>
	);
}

/* ---- Fill demo: TOTP digits type in, old manager heads to the trash ---- */
const CODE_DIGITS = ["8", "2", "4", "3", "9", "1"];

function FillDemo() {
	return (
		<div className="rounded-lg border bg-background p-3.5">
			<p className="mb-1 text-[10px] text-muted-foreground tracking-[0.03em]">
				Verification code
			</p>
			<div className="flex h-8.5 items-center gap-2 rounded-md border border-primary/50 bg-foreground/3 px-2.5 shadow-[0_0_0_3px_color-mix(in_oklab,var(--color-primary)_13%,transparent)]">
				<span
					className="flex items-center gap-1 font-mono text-[13px] tracking-[0.08em]"
					aria-hidden
				>
					{CODE_DIGITS.map((digit, i) => (
						<motion.i
							key={`${digit}-${i}`}
							className="not-italic"
							animate={{ opacity: [0, 0, 1, 1, 0] }}
							transition={{
								duration: 5,
								times: [0, 0.1 + i * 0.04, 0.14 + i * 0.04, 0.9, 1],
								repeat: Number.POSITIVE_INFINITY,
							}}
						>
							{digit}
						</motion.i>
					))}
				</span>
				<motion.span
					className="ml-auto inline-flex items-center gap-1 font-semibold text-[10px] text-primary"
					animate={{
						opacity: [0, 0, 1, 1, 0],
						scale: [0.85, 0.85, 1, 1, 0.85],
					}}
					transition={{
						duration: 5,
						times: [0, 0.42, 0.48, 0.9, 1],
						repeat: Number.POSITIVE_INFINITY,
					}}
				>
					<Check className="size-2.5" />
					Filled by Bittery
				</motion.span>
			</div>
			<div className="mt-2.5 flex items-center gap-2 text-[10.5px] text-muted-foreground">
				<Trash2 className="size-3 shrink-0" />
				<span className="line-through decoration-foreground/40">
					OldManager.app
				</span>
				<span className="ml-auto font-medium text-success">removed</span>
			</div>
		</div>
	);
}

const DEMOS = [ImportDemo, SyncDemo, FillDemo];

export function HowItWorks() {
	return (
		<section className="px-4 py-20 sm:py-28">
			<div className="mx-auto max-w-5xl">
				<motion.div
					initial={{ opacity: 0, y: 12 }}
					whileInView={{ opacity: 1, y: 0 }}
					viewport={{ once: true, margin: "-80px" }}
					transition={{ duration: 0.5 }}
					className="max-w-xl"
				>
					<p className="mb-3 font-semibold text-[12px] text-primary uppercase tracking-[0.08em]">
						Switch in minutes
					</p>
					<h2 className="font-semibold text-[30px] leading-[1.1] tracking-[-0.035em] sm:text-[40px]">
						Leave your old manager behind.
					</h2>
					<p className="mt-3.5 text-[16px] text-muted-foreground">
						Switching password managers sounds painful. It takes about three
						steps and a few minutes.
					</p>
				</motion.div>

				<div className="mt-12 grid gap-4 sm:grid-cols-3">
					{STEPS.map((step, i) => {
						const Demo = DEMOS[i];
						return (
							<motion.div
								key={step.title}
								initial={{ opacity: 0, y: 16 }}
								whileInView={{ opacity: 1, y: 0 }}
								viewport={{ once: true, margin: "-80px" }}
								transition={{ duration: 0.55, delay: i * 0.06, ease: EASE }}
								className="group relative flex flex-col overflow-hidden rounded-xl border bg-card p-6 transition-colors duration-150 hover:border-border-strong"
							>
								<span
									aria-hidden
									className="pointer-events-none absolute inset-x-[12%] top-0 h-px bg-linear-to-r from-transparent via-foreground/14 to-transparent opacity-0 transition-opacity duration-200 group-hover:opacity-100"
								/>
								<div className="flex items-baseline justify-between">
									<span className="font-mono text-[12px] text-primary">
										0{i + 1}
									</span>
									<span className="rounded-[4px] border bg-foreground/3 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
										{step.time}
									</span>
								</div>
								<h3 className="mt-3 font-semibold text-[15px] tracking-[-0.01em]">
									{step.title}
								</h3>
								<p className="mt-1.5 text-[13px] text-muted-foreground leading-relaxed">
									{step.body}
								</p>
								<div className="mt-auto pt-6">
									<Demo />
								</div>
							</motion.div>
						);
					})}
				</div>

				<motion.div
					initial={{ opacity: 0, y: 12 }}
					whileInView={{ opacity: 1, y: 0 }}
					viewport={{ once: true, margin: "-80px" }}
					transition={{ duration: 0.5, delay: 0.2 }}
					className="mt-12 flex flex-wrap items-center gap-5"
				>
					<PrimaryCta
						href={billingMarketingEnabled() ? signupUrl() : "/#waitlist"}
						size="lg"
					>
						{billingMarketingEnabled()
							? "Get Bittery free"
							: "Join the waitlist"}
					</PrimaryCta>
					<ArrowLink href="/docs/getting-started/import-passwords">
						Read the import guide
					</ArrowLink>
				</motion.div>
			</div>
		</section>
	);
}
