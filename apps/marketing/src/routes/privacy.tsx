import { Shield } from "lucide-react";
import { motion } from "motion/react";
import { createFileRoute } from "@tanstack/react-router";
import { Layout } from "@/components/layout";

export const Route = createFileRoute("/privacy")({
	component: PrivacyPage,
	head: () => ({
		meta: [
			{ title: "Privacy Policy — Bittery" },
			{
				name: "description",
				content:
					"Bittery's privacy policy. Learn how we handle your data with our zero-knowledge architecture.",
			},
		],
	}),
});

const lastUpdated = "March 1, 2026";

const sections = [
	{
		title: "1. Introduction",
		content: `Bittery is a zero-knowledge password manager operated by qrawall GmbH ("we", "us", "our"), a company registered in Germany. This Privacy Policy explains how we collect, use, and protect information when you use our services, including the Bittery web app, desktop app, mobile app, browser extension, and this website (collectively, the "Service").

We are committed to your privacy. Bittery is designed so that we cannot access your passwords, vault data, or encryption keys — ever.`,
	},
	{
		title: "2. Zero-knowledge architecture",
		content: `Bittery uses a zero-knowledge encryption model. This means:

• All vault data (passwords, secure notes, credit cards, identities, TOTP secrets) is encrypted on your device using AES-256-GCM before it is transmitted to our servers.
• Your Master Password and Secret Key never leave your device in plaintext. Authentication uses the SRP-6a protocol, which allows us to verify your identity without ever seeing your password.
• Your Master Unlock Key is derived locally via PBKDF2 (310,000 iterations) and HKDF. We do not store, transmit, or have access to this key.
• Encryption keys for shared vaults are exchanged using RSA-4096 key pairs generated on your device. Your private key is encrypted with your Master Unlock Key before storage.

In practical terms: we cannot read your stored data, we cannot reset your Master Password, and we cannot recover your vault if you lose both your password and Secret Key.`,
	},
	{
		title: "3. Information we collect",
		content: `We collect only the minimum information necessary to operate the Service:

Account information: When you create an account, we collect your email address. This is used for authentication, account recovery communication, and service-related notifications.

Encrypted vault data: Your vault items are stored on our servers in encrypted form. We cannot decrypt this data.

Authentication data: We store SRP-6a verifiers and salts necessary for the authentication protocol. These cannot be used to derive your password.

Device information: When you sign in, we record basic device metadata (platform, browser, operating system) to help you manage active sessions and detect unauthorized access.

Usage metadata: We collect minimal technical data necessary to operate the Service, such as timestamps of authentication events, API request logs (without vault contents), and error reports.

Payment information: If you subscribe to a paid plan, payment processing is handled by our third-party payment processor. We do not store your full credit card number or payment credentials on our servers.`,
	},
	{
		title: "4. Information we do not collect",
		content: `We do not collect, store, or have access to:

• Your Master Password
• Your Secret Key
• Your Master Unlock Key or any derived encryption keys
• Decrypted vault contents (passwords, notes, credit card details, identities, TOTP secrets)
• Your private RSA key in unencrypted form
• Browsing history, keystrokes, or clipboard data`,
	},
	{
		title: "5. How we use your information",
		content: `We use the information we collect to:

• Provide, maintain, and improve the Service
• Authenticate your identity using the SRP-6a protocol
• Sync your encrypted vault data across your devices
• Send you essential service communications (e.g., security alerts, account verification)
• Detect and prevent abuse, fraud, or security threats
• Comply with legal obligations

We do not sell, rent, or share your personal information with third parties for their marketing purposes.`,
	},
	{
		title: "6. Data storage and security",
		content: `Your encrypted vault data is stored on servers located within the European Union. We implement appropriate technical and organizational measures to protect the data we store, including:

• TLS encryption for all data in transit
• AES-256-GCM encryption for all vault data at rest (client-side encrypted)
• Regular security assessments and code reviews
• Open-source codebase allowing independent security audits
• Rate limiting and abuse detection on authentication endpoints

Because your vault data is encrypted with keys we never possess, even a hypothetical server breach would not expose your passwords or sensitive data in readable form.`,
	},
	{
		title: "7. Data retention",
		content: `We retain your account information and encrypted vault data for as long as your account is active. If you delete your account, we will delete your data from our active systems within 30 days. Some data may persist in encrypted backups for up to 90 days before being permanently removed.

Audit logs and security event records may be retained for up to 12 months for security and compliance purposes.`,
	},
	{
		title: "8. Self-hosting",
		content:
			"Bittery is open-source software that you can self-host on your own infrastructure. When you self-host Bittery, your data never touches our servers. This Privacy Policy applies only to the cloud-hosted version of the Service operated by qrawall GmbH.",
	},
	{
		title: "9. Third-party services",
		content: `We use a limited number of third-party services to operate Bittery:

• Payment processing: For handling subscriptions and payments. These providers receive only the information necessary to process your payment.
• Infrastructure providers: For hosting and delivering the Service. These providers process encrypted data on our behalf and are bound by data processing agreements.
• Email delivery: For sending transactional emails (account verification, security alerts). These providers receive only your email address and message content.

We carefully vet all third-party providers and require them to comply with applicable data protection regulations.`,
	},
	{
		title: "10. Your rights",
		content: `Under the EU General Data Protection Regulation (GDPR) and applicable laws, you have the right to:

• Access: Request a copy of the personal data we hold about you.
• Rectification: Request correction of inaccurate personal data.
• Erasure: Request deletion of your personal data and account.
• Data portability: Export your vault data in a standard format (available within the app).
• Restriction: Request that we restrict processing of your personal data.
• Objection: Object to processing of your personal data.
• Withdraw consent: Where processing is based on consent, you may withdraw it at any time.

To exercise any of these rights, contact us at privacy@bittery.com. We will respond within 30 days as required by GDPR.`,
	},
	{
		title: "11. Cookies and tracking",
		content: `The Bittery application uses only essential cookies and local storage necessary for authentication and session management. We do not use tracking cookies, analytics trackers, or advertising pixels.

This marketing website may use minimal analytics to understand aggregate traffic patterns. We do not use this data to identify or profile individual users.`,
	},
	{
		title: "12. Children's privacy",
		content:
			"The Service is not directed to children under 16 years of age. We do not knowingly collect personal information from children under 16. If you believe a child under 16 has provided us with personal data, please contact us and we will delete it promptly.",
	},
	{
		title: "13. International data transfers",
		content:
			"Your data is stored within the European Union. If we need to transfer data outside the EU/EEA, we will ensure appropriate safeguards are in place, such as Standard Contractual Clauses or adequacy decisions by the European Commission.",
	},
	{
		title: "14. Changes to this policy",
		content:
			"We may update this Privacy Policy from time to time. We will notify you of material changes by posting a notice on our website or sending you an email. Continued use of the Service after changes take effect constitutes acceptance of the revised policy.",
	},
	{
		title: "15. Contact us",
		content: `If you have questions or concerns about this Privacy Policy or our data practices, please contact us:

qrawall GmbH
Email: privacy@bittery.com
Website: https://qrawall.com

You also have the right to lodge a complaint with your local data protection authority.`,
	},
];

function PrivacyPage() {
	return (
		<Layout>
			{/* ─── Hero ─────────────────────────────────────────────── */}
			<section className="relative overflow-hidden pt-28 pb-16 sm:pt-36 sm:pb-20">
				<div className="pointer-events-none absolute inset-0 overflow-hidden">
					<div className="absolute top-0 right-0 h-150 w-150 translate-x-1/3 -translate-y-1/3 rounded-full bg-primary/4 blur-3xl" />
					<div className="absolute bottom-0 left-0 h-100 w-100 -translate-x-1/3 translate-y-1/3 rounded-full bg-primary/3 blur-3xl" />
				</div>

				<div className="relative mx-auto max-w-3xl px-4">
					<motion.div
						className="text-center"
						initial={{ opacity: 0, y: 20 }}
						animate={{ opacity: 1, y: 0 }}
						transition={{ duration: 0.6, ease: "easeOut" }}
					>
						<div className="mb-4 inline-flex items-center gap-2 rounded-full border border-primary/15 bg-primary/8 px-3 py-1 font-medium text-primary text-xs">
							<Shield className="size-3.5" />
							Privacy Policy
						</div>
						<h1 className="font-bold font-display text-3xl tracking-tight sm:text-4xl lg:text-5xl">
							Your privacy,{" "}
							<span className="text-primary">our priority.</span>
						</h1>
						<p className="mx-auto mt-4 max-w-lg text-base text-muted-foreground leading-relaxed sm:text-lg">
							Bittery is built on the principle that we should never be able
							to see your data. Here's exactly how we handle your information.
						</p>
						<p className="mt-4 text-muted-foreground text-sm">
							Last updated: {lastUpdated}
						</p>
					</motion.div>
				</div>
			</section>

			{/* ─── Policy content ──────────────────────────────────── */}
			<section className="px-4 pb-16 sm:pb-20">
				<div className="mx-auto max-w-3xl">
					<div className="space-y-8">
						{sections.map((section, i) => (
							<motion.div
								key={section.title}
								className="rounded-2xl border border-border/60 bg-card p-6 sm:p-8"
								initial={{ opacity: 0, y: 12 }}
								whileInView={{ opacity: 1, y: 0 }}
								viewport={{ once: true, margin: "-60px" }}
								transition={{ duration: 0.4, delay: Math.min(i * 0.03, 0.2) }}
							>
								<h2 className="mb-4 font-display font-semibold text-foreground text-lg sm:text-xl">
									{section.title}
								</h2>
								<div className="space-y-3 text-muted-foreground text-sm leading-relaxed sm:text-base">
									{section.content.split("\n\n").map((paragraph) => {
										const lines = paragraph.split("\n");
										const bulletLines = lines.filter((l) => l.startsWith("•"));
										const textLines = lines.filter((l) => !l.startsWith("•"));

										if (bulletLines.length === 0) {
											return <p key={paragraph.slice(0, 40)}>{paragraph}</p>;
										}

										return (
											<div key={paragraph.slice(0, 40)}>
												{textLines.length > 0 && (
													<p className="mb-2">{textLines.join(" ")}</p>
												)}
												<ul className="list-disc space-y-1.5 pl-5">
													{bulletLines.map((line) => (
														<li key={line.slice(2, 42)}>{line.replace(/^• ?/, "")}</li>
													))}
												</ul>
											</div>
										);
									})}
								</div>
							</motion.div>
						))}
					</div>
				</div>
			</section>
		</Layout>
	);
}
