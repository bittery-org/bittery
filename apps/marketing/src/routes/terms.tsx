import { createFileRoute } from "@tanstack/react-router";
import { FileText } from "lucide-react";
import { motion } from "motion/react";

export const Route = createFileRoute("/terms")({
	component: TermsPage,
	head: () => ({
		meta: [
			{ title: "Terms of Service — Bittery" },
			{
				name: "description",
				content:
					"Bittery's terms of service. Read the terms governing your use of the Bittery password manager.",
			},
		],
	}),
});

const lastUpdated = "March 1, 2026";

const sections = [
	{
		title: "1. Agreement to terms",
		content: `These Terms of Service ("Terms") govern your access to and use of the Bittery password manager, including the web application, desktop application, mobile application, browser extension, and related services (collectively, the "Service") operated by Bittery Software ("Bittery", "we", "us", "our"), a company registered in Germany.

By creating an account or using the Service, you agree to be bound by these Terms. If you do not agree, do not use the Service.`,
	},
	{
		title: "2. Description of service",
		content: `Bittery is a zero-knowledge password manager that allows you to securely store, manage, and share passwords, secure notes, credit card information, identity documents, and TOTP secrets. All sensitive data is encrypted on your device before being transmitted to our servers using AES-256-GCM encryption.

The Service is available as a cloud-hosted beta and as self-hosted source-available software. These Terms apply to the cloud-hosted version. Self-hosted deployments are governed by the software license.`,
	},
	{
		title: "3. Account registration",
		content: `To use the Service, you must create an account by providing a valid email address, choosing a Master Password, and receiving a Secret Key. You are responsible for:

• Maintaining the confidentiality of your Master Password and Secret Key
• All activity that occurs under your account
• Ensuring your account information is accurate and up to date

You must be at least 16 years old to create an account. By registering, you represent that you meet this age requirement.

Important: Due to our zero-knowledge architecture, we cannot reset your Master Password or recover your Secret Key. If you lose both, your encrypted data will be permanently inaccessible. We strongly recommend storing your Secret Key in a safe location.`,
	},
	{
		title: "4. Acceptable use",
		content: `You agree to use the Service only for lawful purposes and in accordance with these Terms. You must not:

• Use the Service to store, transmit, or facilitate any illegal content or activity
• Attempt to gain unauthorized access to other users' accounts or data
• Interfere with or disrupt the Service's infrastructure or security measures
• Use the public source code or Service in a way that violates the applicable software license
• Use automated systems to access the Service in a manner that exceeds reasonable usage
• Resell, sublicense, or commercialize access to the Service without our written consent
• Use the Service to conduct phishing, distribute malware, or carry out any form of cyber attack`,
	},
	{
		title: "5. Hosted beta access",
		content: `Bittery Cloud is currently offered as an invite-only hosted beta. Public signup may be limited, and access may be granted from the waitlist in batches.

We are not currently selling paid subscriptions for the hosted beta. If paid plans become available later, pricing, billing terms, payment processors, renewal rules, cancellation terms, and tax handling will be presented before any charge is made.`,
	},
	{
		title: "6. Beta plan",
		content:
			"The hosted beta provides access to core password management functionality while we prepare the public cloud launch. We may change beta limits, availability, or invite policies with reasonable notice. We will not delete your existing encrypted data merely because beta limits change.",
	},
	{
		title: "7. Data ownership and encryption",
		content: `You retain full ownership of all data you store in the Service. We do not claim any intellectual property rights over your vault contents.

Due to our zero-knowledge encryption model:

• Your data is encrypted on your device before reaching our servers
• We cannot access, read, or modify your encrypted vault data
• We cannot comply with requests to produce the decrypted contents of your vault, as we are technically incapable of doing so
• You are solely responsible for maintaining access to your encryption keys (Master Password and Secret Key)

We will store and transmit your encrypted data in accordance with our Privacy Policy and applicable data protection laws.`,
	},
	{
		title: "8. Shared vaults and teams",
		content: `The Service allows you to share vaults with other users and create teams. When you share a vault:

• Vault encryption keys are securely exchanged using RSA-4096 key pairs
• You are responsible for managing access permissions and roles (owner, admin, member, read-only)
• Vault owners and admins can remove members and revoke access at any time
• Removing a member triggers a key rotation to ensure revoked users cannot access future data

Team administrators are responsible for managing team membership and ensuring compliance with these Terms within their organization.`,
	},
	{
		title: "9. Sharing links",
		content: `The Service allows you to create encrypted share links to share individual items with people who may not have a Bittery account. When you create a share link:

• The shared data is encrypted and can be configured with an expiration date, email restrictions, or one-time access
• You are responsible for who you share links with and the sensitivity of the shared data
• We log access to share links for your audit purposes
• You can revoke share links at any time`,
	},
	{
		title: "10. Source-available license",
		content: `Bittery's source code is publicly available on GitHub under the Functional Source License 1.1 (FSL-1.1-ALv2). This is a source-available license, not an OSI-approved open-source license. It lets you view, modify, and self-host the software, but you may not use it to offer a competing commercial password management service. After two years from each version's release, that version converts to the Apache License 2.0.

If you choose to self-host Bittery for your own use or your organization's internal use, you are welcome to do so. You are responsible for your own deployment, security, and data management when self-hosting.`,
	},
	{
		title: "11. Service availability",
		content: `We strive to maintain high availability of the Service, but we do not guarantee uninterrupted access. The Service may be temporarily unavailable due to:

• Scheduled maintenance (we will provide advance notice when feasible)
• Emergency security patches or updates
• Circumstances beyond our reasonable control (force majeure)

We will make reasonable efforts to minimize downtime and communicate disruptions through our status page.`,
	},
	{
		title: "12. Account termination",
		content: `You may delete your account at any time through the Service's settings. Upon deletion:

• Your account and encrypted vault data will be removed from our active systems within 30 days
• Data may persist in encrypted backups for up to 90 days before permanent deletion
• This action is irreversible — we cannot recover deleted accounts or data

We reserve the right to suspend or terminate accounts that violate these Terms, after providing notice and a reasonable opportunity to cure the violation where feasible. In cases of severe or illegal misuse, we may terminate access immediately.`,
	},
	{
		title: "13. Limitation of liability",
		content: `To the maximum extent permitted by applicable law:

• The Service is provided "as is" and "as available" without warranties of any kind, whether express or implied
• We do not warrant that the Service will be error-free, secure, or uninterrupted
• We are not liable for any loss of data resulting from your failure to maintain your Master Password and Secret Key
• Our total aggregate liability for any claims arising from or related to the Service shall not exceed the total amount you paid us in the 12 months preceding the claim
• We are not liable for any indirect, incidental, special, consequential, or punitive damages

Nothing in these Terms excludes or limits our liability for death or personal injury caused by our negligence, fraud, or any other liability that cannot be excluded by applicable law.`,
	},
	{
		title: "14. Indemnification",
		content: `You agree to indemnify and hold harmless Bittery Software, its officers, directors, and employees from any claims, damages, or expenses (including reasonable legal fees) arising from:

• Your use of the Service
• Your violation of these Terms
• Your violation of any third-party rights
• Content you store or share through the Service`,
	},
	{
		title: "15. Privacy",
		content:
			"Your use of the Service is subject to our Privacy Policy, which describes how we collect, use, and protect your information. By using the Service, you acknowledge that you have read and understood our Privacy Policy.",
	},
	{
		title: "16. Changes to these terms",
		content: `We may update these Terms from time to time. We will notify you of material changes by posting a notice on our website or sending an email to the address associated with your account at least 30 days before the changes take effect.

Continued use of the Service after changes take effect constitutes acceptance of the revised Terms. If you do not agree with the changes, you should stop using the Service and delete your account.`,
	},
	{
		title: "17. Governing law and disputes",
		content: `These Terms are governed by and construed in accordance with the laws of the Federal Republic of Germany, without regard to its conflict of law provisions.

Any disputes arising from or relating to these Terms or the Service shall be subject to the exclusive jurisdiction of the courts in Germany. If you are a consumer resident in the EU, you also have the right to bring proceedings in the courts of your country of residence.

For EU consumers: You may also use the European Commission's Online Dispute Resolution platform at https://ec.europa.eu/consumers/odr.`,
	},
	{
		title: "18. Severability",
		content:
			"If any provision of these Terms is found to be unenforceable or invalid, that provision will be limited or eliminated to the minimum extent necessary, and the remaining provisions will continue in full force and effect.",
	},
	{
		title: "19. Contact",
		content: `If you have questions about these Terms of Service, please contact us:

Bittery Software
Email: legal@bittery.com
Website: https://bittery.com`,
	},
];

function TermsPage() {
	return (
		<>
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
							<FileText className="size-3.5" />
							Terms of Service
						</div>
						<h1 className="font-bold font-display text-3xl tracking-tight sm:text-4xl lg:text-5xl">
							Terms of <span className="text-primary">Service.</span>
						</h1>
						<p className="mx-auto mt-4 max-w-lg text-base text-muted-foreground leading-relaxed sm:text-lg">
							The rules and guidelines that govern your use of Bittery. Plain
							language, no surprises.
						</p>
						<p className="mt-4 text-muted-foreground text-sm">
							Last updated: {lastUpdated}
						</p>
					</motion.div>
				</div>
			</section>

			{/* ─── Terms content ───────────────────────────────────── */}
			<section className="px-4 pt-8 pb-16 sm:pt-12 sm:pb-20">
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
														<li key={line.slice(2, 42)}>
															{line.replace(/^• ?/, "")}
														</li>
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
		</>
	);
}
