import { motion } from "motion/react";
import {
	Accordion,
	AccordionContent,
	AccordionItem,
	AccordionTrigger,
} from "@/components/ui/accordion";

export const faqs = [
	{
		question: "How much does Bittery cost?",
		answer:
			"Hosted cloud access is invite-only during beta, and paid subscriptions are not being sold yet. Self-hosting is free and always will be — Bittery is open source under the AGPLv3 — if you prefer full control over your data.",
	},
	{
		question: "What happens if I forget my master password?",
		answer:
			"You can reset your password using the Recovery Kit you created when you signed up (or generated later in Settings). The Recovery Kit lets you regain access to your account and re-encrypt your data with a new password. That's why it's important to store it somewhere safe — without it, no one, including us, can recover your account.",
	},
	{
		question: "Can I switch from another password manager?",
		answer:
			"Absolutely. Bittery supports importing from 1Password, Bitwarden, LastPass, Dashlane, KeePass, and most other password managers. The import process takes about a minute and brings over all your logins, notes, and cards.",
	},
	{
		question: "How is Bittery different from 1Password or Bitwarden?",
		answer:
			"Bittery combines a polished product experience with public source code that can be audited. Our dual-key encryption (master password + Secret Key) provides an extra layer of security, and our apps are built from the ground up with modern design principles.",
	},
	{
		question: "Is my data safe in the cloud?",
		answer:
			"Your data is encrypted on your device before it ever reaches our servers. We use end-to-end encryption, which means even our team can't read your passwords. The cloud just stores encrypted blobs — useless without your master password and Secret Key.",
	},
	{
		question: "Do I need an internet connection to use Bittery?",
		answer:
			"Yes — Bittery needs a connection to unlock and sync your vault. Decryption always happens on your device, never on our servers, and any change you make shows up on your other devices within seconds.",
	},
];

export function FAQSection() {
	return (
		<section id="faq" className="px-4 py-20 sm:py-28">
			<div className="mx-auto max-w-3xl">
				<motion.div
					className="mb-10 text-center sm:mb-12"
					initial={{ opacity: 0 }}
					whileInView={{ opacity: 1 }}
					viewport={{ once: true, margin: "-100px" }}
					transition={{ duration: 0.5 }}
				>
					<h2 className="font-display text-3xl tracking-tight sm:text-4xl md:text-5xl">
						Frequently asked questions
					</h2>
					<p className="mt-4 text-base text-muted-foreground sm:text-lg">
						Everything you need to know about Bittery.
					</p>
				</motion.div>

				<motion.div
					initial={{ opacity: 0 }}
					whileInView={{ opacity: 1 }}
					viewport={{ once: true, margin: "-80px" }}
					transition={{ duration: 0.4 }}
				>
					<Accordion type="single" collapsible className="w-full">
						{faqs.map((faq, i) => (
							<AccordionItem key={faq.question} value={`item-${i}`}>
								<AccordionTrigger className="py-4 text-left font-medium text-[15px] hover:no-underline">
									{faq.question}
								</AccordionTrigger>
								<AccordionContent className="pb-4 text-muted-foreground text-sm leading-relaxed">
									{faq.answer}
								</AccordionContent>
							</AccordionItem>
						))}
					</Accordion>
				</motion.div>
			</div>
		</section>
	);
}
