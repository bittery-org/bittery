type RecoveryKitEntry = {
	label: string;
	value: string;
	description: string;
};

type RecoveryKitOptions = {
	fileName: string;
	title: string;
	subtitle: string;
	entries: RecoveryKitEntry[];
	cautions: string[];
	footerNote: string;
	includeHandwrittenPasswordSection?: boolean;
};

export type RecoveryKitDownloadResult = "print-opened" | "html-downloaded";

const escapeHtml = (value: string): string =>
	value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");

const buildRecoveryKitHtml = (options: RecoveryKitOptions): string => {
	const generatedAt = new Date().toLocaleString();
	const logoUrl = `${window.location.origin}/logo.png`;
	const entriesMarkup = options.entries
		.map(
			(entry) => `
				<section class="entry-card">
					<p class="entry-label">${escapeHtml(entry.label)}</p>
					<p class="entry-value">${escapeHtml(entry.value)}</p>
					<p class="entry-description">${escapeHtml(entry.description)}</p>
				</section>
			`,
		)
		.join("");
	const cautionsMarkup = options.cautions
		.map((caution) => `<li>${escapeHtml(caution)}</li>`)
		.join("");
	const handwrittenSection = options.includeHandwrittenPasswordSection
		? `
			<section class="handwritten">
				<h2>Optional: Write Password By Hand</h2>
				<p>For paper storage only. Leave this blank in digital copies.</p>
				<div class="handwritten-line">
					<span>Master Password</span>
					<div class="line"></div>
				</div>
			</section>
		`
		: "";

	return `<!doctype html>
<html lang="en">
	<head>
		<meta charset="UTF-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1.0" />
		<title>${escapeHtml(options.title)}</title>
		<style>
			:root {
				--paper: #f7f9ff;
				--ink: #111827;
				--muted: #64748b;
				--card: #ffffff;
				--line: #dbe4f3;
				--accent: #1f4fd6;
				--accent-soft: #e4ecff;
				--warning-soft: #fff4db;
				--warning-ink: #8a5a00;
				--shadow: 0 18px 48px rgba(20, 33, 61, 0.14);
			}

			* {
				box-sizing: border-box;
			}

			html,
			body {
				margin: 0;
				padding: 0;
				background: linear-gradient(165deg, #ecf2ff 0%, #f7f9ff 45%, #edf7f8 100%);
				color: var(--ink);
				font-family:
					"Avenir Next",
					"Segoe UI",
					"Helvetica Neue",
					sans-serif;
				-webkit-print-color-adjust: exact;
				print-color-adjust: exact;
			}

			.sheet {
				max-width: 840px;
				margin: 40px auto;
				padding: 32px;
				border-radius: 24px;
				background: var(--card);
				border: 1px solid var(--line);
				box-shadow: var(--shadow);
			}

			.header {
				display: flex;
				justify-content: space-between;
				align-items: flex-start;
				gap: 24px;
				padding-bottom: 20px;
				margin-bottom: 22px;
				border-bottom: 1px solid var(--line);
			}

			.logo-wrap {
				display: inline-flex;
				align-items: center;
				gap: 12px;
			}

			.logo {
				height: 34px;
				width: auto;
				object-fit: contain;
			}

			.badge {
				display: inline-block;
				padding: 4px 10px;
				border-radius: 999px;
				background: var(--accent-soft);
				color: var(--accent);
				font-size: 12px;
				font-weight: 700;
				letter-spacing: 0.08em;
				text-transform: uppercase;
			}

			h1 {
				margin: 12px 0 8px;
				font-size: 30px;
				line-height: 1.15;
				letter-spacing: -0.02em;
			}

			.subtitle {
				margin: 0;
				color: var(--muted);
				font-size: 14px;
				line-height: 1.6;
				max-width: 560px;
			}

			.generated {
				margin: 0;
				padding: 8px 12px;
				border: 1px solid var(--line);
				border-radius: 12px;
				font-size: 12px;
				color: var(--muted);
				white-space: nowrap;
			}

			.grid {
				display: grid;
				gap: 14px;
				margin-bottom: 20px;
			}

			.entry-card {
				border: 1px solid var(--line);
				background: linear-gradient(170deg, #ffffff 0%, #f8fbff 100%);
				border-radius: 16px;
				padding: 14px 16px;
			}

			.entry-label {
				margin: 0 0 8px;
				font-size: 11px;
				font-weight: 700;
				letter-spacing: 0.09em;
				color: var(--muted);
				text-transform: uppercase;
			}

			.entry-value {
				margin: 0 0 10px;
				padding: 10px 12px;
				border-radius: 10px;
				background: #0f172a;
				color: #f8fafc;
				font-family:
					"SF Mono",
					"Menlo",
					"Consolas",
					monospace;
				font-size: 13px;
				line-height: 1.45;
				overflow-wrap: anywhere;
			}

			.entry-description {
				margin: 0;
				font-size: 13px;
				line-height: 1.5;
				color: #334155;
			}

			.warning {
				border: 1px solid #f4daa3;
				background: var(--warning-soft);
				border-radius: 16px;
				padding: 14px 16px;
				margin-bottom: 18px;
			}

			.warning h2 {
				margin: 0 0 8px;
				color: var(--warning-ink);
				font-size: 14px;
			}

			.warning ul {
				margin: 0;
				padding-left: 18px;
				color: #6f4d00;
				font-size: 13px;
				line-height: 1.55;
			}

			.handwritten {
				border: 1px dashed #9db3e2;
				background: #f6f9ff;
				border-radius: 16px;
				padding: 14px 16px;
				margin-bottom: 18px;
			}

			.handwritten h2 {
				margin: 0 0 4px;
				font-size: 14px;
				color: #1e3a8a;
			}

			.handwritten p {
				margin: 0 0 12px;
				font-size: 12px;
				color: #475569;
			}

			.handwritten-line {
				margin-bottom: 10px;
			}

			.handwritten-line span {
				display: block;
				font-size: 11px;
				letter-spacing: 0.05em;
				text-transform: uppercase;
				color: #64748b;
				margin-bottom: 6px;
			}

			.handwritten-line .line {
				height: 28px;
				border-bottom: 2px solid #a3b7de;
			}

			.footer-note {
				margin: 0;
				border-top: 1px dashed var(--line);
				padding-top: 14px;
				font-size: 12px;
				line-height: 1.6;
				color: var(--muted);
			}

			@media print {
				@page {
					size: A4;
					margin: 16mm;
				}

				body {
					background: #fff;
				}

				.sheet {
					margin: 0;
					max-width: none;
					border-radius: 0;
					border: none;
					box-shadow: none;
					padding: 0;
				}
			}
		</style>
	</head>
	<body>
		<main class="sheet">
			<header class="header">
				<div>
					<div class="logo-wrap">
						<img class="logo" src="${escapeHtml(logoUrl)}" alt="Bittery" />
						<span class="badge">Recovery Kit</span>
					</div>
					<h1>${escapeHtml(options.title)}</h1>
					<p class="subtitle">${escapeHtml(options.subtitle)}</p>
				</div>
				<p class="generated">Generated: ${escapeHtml(generatedAt)}</p>
			</header>

			<section class="grid">${entriesMarkup}</section>

			${handwrittenSection}

			<section class="warning">
				<h2>Store This Offline</h2>
				<ul>${cautionsMarkup}</ul>
			</section>

			<p class="footer-note">${escapeHtml(options.footerNote)}</p>
		</main>
		<script>
			window.addEventListener("load", () => {
				setTimeout(() => {
					window.focus();
					window.print();
				}, 250);
			});
			window.onafterprint = () => window.close();
		</script>
	</body>
</html>`;
};

export const downloadRecoveryKit = (
	options: RecoveryKitOptions,
): RecoveryKitDownloadResult => {
	const html = buildRecoveryKitHtml(options);
	const printWindow = window.open("", "_blank", "width=940,height=1200");

	if (printWindow) {
		printWindow.document.open();
		printWindow.document.write(html);
		printWindow.document.close();
		return "print-opened";
	}

	const blob = new Blob([html], { type: "text/html" });
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = `${options.fileName}.html`;
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	URL.revokeObjectURL(url);
	return "html-downloaded";
};
