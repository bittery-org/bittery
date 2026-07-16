import { motion } from "motion/react";
import { ArrowLink } from "./cta-button";

const RECEIPTS = [
	{
		mono: "AES-256-GCM",
		title: "Encrypted on-device",
		body: "Every item is sealed before it leaves your machine, with ciphertext bound to its vault so it can't be swapped or replayed.",
	},
	{
		mono: "PBKDF2 · 310,000 → HKDF",
		title: "Two keys, not one",
		body: "Your master password plus a device-held Secret Key derive your keys. Guessing one gets an attacker nothing.",
	},
	{
		mono: "SRP-6a",
		title: "Password never transmitted",
		body: "Login uses a zero-knowledge proof. Your password never crosses the wire — not even hashed.",
	},
	{
		mono: "Rust → WASM & native",
		title: "One audited crypto core",
		body: "All cryptography lives in a single memory-safe Rust core, compiled for every platform. No JavaScript crypto.",
	},
];

export function ReceiptsSection() {
	return (
		<section id="security" className="py-24">
			<div className="mx-auto max-w-5xl px-4">
				<div className="max-w-xl">
					<p className="mb-3 font-semibold text-[12px] text-primary uppercase tracking-[0.08em]">
						How it's built
					</p>
					<h2 className="font-semibold text-[30px] leading-[1.1] tracking-[-0.035em] sm:text-[40px]">
						We can't read your vault.
						<br />
						Not won't — can't.
					</h2>
					<p className="mt-3.5 text-[16px] text-muted-foreground">
						Everything is encrypted on your device before it touches the
						network. Here are the receipts.
					</p>
				</div>
			</div>

			<div className="mt-10 border-y bg-linear-to-b from-foreground/2 to-transparent">
				<div className="mx-auto max-w-5xl">
					<div className="grid sm:grid-cols-2 lg:grid-cols-4">
						{RECEIPTS.map((receipt, i) => (
							<motion.div
								key={receipt.mono}
								initial={{ opacity: 0, y: 12 }}
								whileInView={{ opacity: 1, y: 0 }}
								viewport={{ once: true, margin: "-80px" }}
								transition={{ duration: 0.5, delay: i * 0.07 }}
								className="border-b p-7 lg:not-last:border-r lg:border-b-0 sm:[&:nth-child(odd)]:border-r"
							>
								<span className="mb-2.5 block font-mono text-[12px] text-primary">
									{receipt.mono}
								</span>
								<h3 className="font-semibold text-[14px] tracking-[-0.01em]">
									{receipt.title}
								</h3>
								<p className="mt-1.5 text-[12.5px] text-muted-foreground leading-relaxed">
									{receipt.body}
								</p>
							</motion.div>
						))}
					</div>
					<div className="flex flex-col gap-2 border-t px-7 py-5 text-[13px] text-muted-foreground sm:flex-row sm:items-center">
						The full source is available to read, and so is the threat model.
						<ArrowLink href="/docs/security" className="sm:ml-auto">
							Read the security model
						</ArrowLink>
					</div>
				</div>
			</div>
		</section>
	);
}
