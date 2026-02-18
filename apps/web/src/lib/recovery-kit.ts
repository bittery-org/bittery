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

export type RecoveryKitDownloadResult = "pdf-downloaded" | "txt-downloaded";

const A4_WIDTH = 595.28;
const A4_HEIGHT = 841.89;
const PAGE_MARGIN = 44;

const triggerDownload = (blob: Blob, fileName: string) => {
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = fileName;
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	URL.revokeObjectURL(url);
};

const splitLongToken = (
	token: string,
	font: any,
	size: number,
	maxWidth: number,
): string[] => {
	if (!token) return [""];
	if (font.widthOfTextAtSize(token, size) <= maxWidth) return [token];

	const parts: string[] = [];
	let remainder = token;

	while (font.widthOfTextAtSize(remainder, size) > maxWidth) {
		let low = 1;
		let high = remainder.length;
		let best = 1;

		while (low <= high) {
			const mid = Math.floor((low + high) / 2);
			const candidate = remainder.slice(0, mid);
			if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
				best = mid;
				low = mid + 1;
			} else {
				high = mid - 1;
			}
		}

		parts.push(remainder.slice(0, best));
		remainder = remainder.slice(best);
	}

	if (remainder) {
		parts.push(remainder);
	}

	return parts;
};

const wrapText = (
	text: string,
	font: any,
	size: number,
	maxWidth: number,
): string[] => {
	if (!text) return [];

	const tokens = text.split(/\s+/).filter(Boolean);
	const lines: string[] = [];
	let currentLine = "";

	for (const token of tokens) {
		const tokenParts = splitLongToken(token, font, size, maxWidth);
		for (const part of tokenParts) {
			const candidate = currentLine ? `${currentLine} ${part}` : part;
			if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
				currentLine = candidate;
				continue;
			}

			if (currentLine) {
				lines.push(currentLine);
			}
			currentLine = part;
		}
	}

	if (currentLine) {
		lines.push(currentLine);
	}

	return lines;
};

const drawWrappedText = ({
	page,
	text,
	font,
	size,
	lineHeight,
	x,
	y,
	maxWidth,
	color,
}: {
	page: any;
	text: string;
	font: any;
	size: number;
	lineHeight: number;
	x: number;
	y: number;
	maxWidth: number;
	color: any;
}): number => {
	const lines = wrapText(text, font, size, maxWidth);

	for (const line of lines) {
		page.drawText(line, { x, y, font, size, color });
		y -= lineHeight;
	}

	return y;
};

const drawRoundedRect = ({
	page,
	x,
	y,
	width,
	height,
	radius,
	color,
	borderColor,
	borderWidth,
}: {
	page: any;
	x: number;
	y: number;
	width: number;
	height: number;
	radius: number;
	color?: any;
	borderColor?: any;
	borderWidth?: number;
}) => {
	const r = Math.min(radius, width / 2, height / 2);
	const w = width;
	const h = height;

	const path = [
		`M ${r} 0`,
		`L ${w - r} 0`,
		`Q ${w} 0 ${w} ${r}`,
		`L ${w} ${h - r}`,
		`Q ${w} ${h} ${w - r} ${h}`,
		`L ${r} ${h}`,
		`Q 0 ${h} 0 ${h - r}`,
		`L 0 ${r}`,
		`Q 0 0 ${r} 0`,
		"Z",
	].join(" ");

	const options: any = { x, y: y + height };
	if (color) options.color = color;
	if (borderColor) options.borderColor = borderColor;
	if (borderWidth !== undefined) options.borderWidth = borderWidth;

	page.drawSvgPath(path, options);
};

const buildRecoveryKitText = (options: RecoveryKitOptions): string => {
	const generatedAt = new Date().toLocaleString();
	const lines: string[] = [
		"BITTERY RECOVERY KIT",
		`Generated: ${generatedAt}`,
		"",
		options.title,
		options.subtitle,
		"",
	];

	for (const entry of options.entries) {
		lines.push(`${entry.label.toUpperCase()}: ${entry.value}`);
		lines.push(entry.description);
		lines.push("");
	}

	if (options.includeHandwrittenPasswordSection) {
		lines.push(
			"MASTER PASSWORD (WRITE BY HAND): ______________________________",
		);
		lines.push("");
	}

	lines.push("STORE THIS OFFLINE:");
	for (const caution of options.cautions) {
		lines.push(`- ${caution}`);
	}
	lines.push("");
	lines.push(options.footerNote);

	return lines.join("\n");
};

const tryGeneratePdf = async (
	options: RecoveryKitOptions,
): Promise<Uint8Array> => {
	const pdfLib: any = await import("pdf-lib");
	const { PDFDocument, StandardFonts, rgb } = pdfLib;

	const pdfDoc = await PDFDocument.create();
	const page = pdfDoc.addPage([A4_WIDTH, A4_HEIGHT]);
	const regularFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
	const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
	const monoFont = await pdfDoc.embedFont(StandardFonts.Courier);

	let logoImage: any = null;
	try {
		const logoResponse = await fetch("/logo.png");
		if (logoResponse.ok) {
			const logoBytes = await logoResponse.arrayBuffer();
			logoImage = await pdfDoc.embedPng(logoBytes);
		}
	} catch {
		// Logo is optional for PDF generation.
	}

	const colors = {
		text: rgb(0.07, 0.11, 0.19),
		muted: rgb(0.39, 0.46, 0.58),
		line: rgb(0.84, 0.89, 0.95),
		softCard: rgb(0.96, 0.98, 1.0),
		keyCard: rgb(0.97, 0.99, 1.0),
		keyValueBg: rgb(0.09, 0.13, 0.2),
		keyValueText: rgb(0.98, 0.99, 1.0),
		warnCard: rgb(1.0, 0.97, 0.88),
		handCard: rgb(0.96, 0.98, 1.0),
	};

	const contentWidth = A4_WIDTH - PAGE_MARGIN * 2;
	let y = A4_HEIGHT - PAGE_MARGIN;

	const generatedAt = `Generated: ${new Date().toLocaleString()}`;
	const headerHeight = 118;
	drawRoundedRect({
		page,
		x: PAGE_MARGIN,
		y: y - headerHeight,
		width: contentWidth,
		height: headerHeight,
		radius: 8,
		color: colors.softCard,
		borderColor: colors.line,
		borderWidth: 1,
	});

	const headerLeft = PAGE_MARGIN + 16;
	let headerTop = y - 18;
	const maxLogoWidth = 96;
	const maxLogoHeight = 30;
	let logoWidth = 0;
	let logoHeight = 0;

	if (logoImage) {
		const logoScale = Math.min(
			maxLogoWidth / logoImage.width,
			maxLogoHeight / logoImage.height,
		);
		logoWidth = logoImage.width * logoScale;
		logoHeight = logoImage.height * logoScale;
		page.drawImage(logoImage, {
			x: headerLeft,
			y: headerTop - logoHeight + 2,
			width: logoWidth,
			height: logoHeight,
		});
	}

	const generatedWidth = regularFont.widthOfTextAtSize(generatedAt, 9);
	const generatedX = PAGE_MARGIN + contentWidth - 16 - generatedWidth;
	const headerTextX = headerLeft + (logoWidth > 0 ? logoWidth + 12 : 0);
	const badgeText = "RECOVERY KIT";
	const badgeFontSize = 8.5;
	const badgePaddingX = 7;
	const badgePaddingY = 4;
	const badgeTextWidth = boldFont.widthOfTextAtSize(badgeText, badgeFontSize);
	const badgeWidth = badgeTextWidth + badgePaddingX * 2;
	const badgeHeight = badgeFontSize + badgePaddingY * 2;
	const badgeY = headerTop - badgeHeight + 2;

	drawRoundedRect({
		page,
		x: headerTextX,
		y: badgeY,
		width: badgeWidth,
		height: badgeHeight,
		radius: 4,
		color: rgb(0.9, 0.93, 1.0),
		borderColor: rgb(0.75, 0.82, 0.98),
		borderWidth: 0.7,
	});
	page.drawText(badgeText, {
		x: headerTextX + badgePaddingX,
		y: badgeY + badgeHeight / 2 - badgeFontSize * 0.36,
		size: badgeFontSize,
		font: boldFont,
		color: rgb(0.16, 0.31, 0.84),
	});

	page.drawText(generatedAt, {
		x: generatedX,
		y: headerTop - 4,
		size: 9,
		font: regularFont,
		color: colors.muted,
	});

	const logoBottomY =
		logoWidth > 0 ? headerTop - logoHeight + 2 : headerTop - 4;
	headerTop = logoBottomY - 14;
	const subtitleMaxWidth = contentWidth - 32;
	drawWrappedText({
		page,
		text: options.subtitle,
		font: regularFont,
		size: 10.5,
		lineHeight: 13.5,
		x: headerLeft,
		y: headerTop,
		maxWidth: subtitleMaxWidth,
		color: colors.muted,
	});

	y -= headerHeight + 18;

	for (const entry of options.entries) {
		const cardX = PAGE_MARGIN;
		const cardInnerX = cardX + 20;
		const cardInnerWidth = contentWidth - 40;
		const valueFontSize = 14.2;
		const valueLineHeight = 18;
		const valueLines = wrapText(
			entry.value,
			monoFont,
			valueFontSize,
			cardInnerWidth - 24,
		);
		const valueTextHeight = valueLines.length * valueLineHeight;
		const valueHeight = Math.max(46, valueTextHeight + 16);
		const descLineHeight = 13;
		const descLines = wrapText(
			entry.description,
			regularFont,
			10.5,
			cardInnerWidth,
		);
		const descHeight =
			descLines.length > 0 ? descLines.length * descLineHeight + 2 : 0;
		const cardTopPadding = 20;
		const cardBottomPadding = 18;
		const cardHeight =
			cardTopPadding + 16 + valueHeight + 16 + descHeight + cardBottomPadding;
		const cardTopY = y;
		const cardBottomY = cardTopY - cardHeight;

		drawRoundedRect({
			page,
			x: cardX,
			y: cardBottomY,
			width: contentWidth,
			height: cardHeight,
			radius: 8,
			color: colors.keyCard,
			borderColor: colors.line,
			borderWidth: 1,
		});

		let cardY = cardTopY - cardTopPadding;

		page.drawText(entry.label.toUpperCase(), {
			x: cardInnerX,
			y: cardY,
			size: 9,
			font: boldFont,
			color: colors.muted,
		});

		cardY -= 14;
		const valueRectTop = cardY;
		const valueRectBottom = valueRectTop - valueHeight;
		drawRoundedRect({
			page,
			x: cardInnerX - 1,
			y: valueRectBottom,
			width: cardInnerWidth + 1,
			height: valueHeight,
			radius: 6,
			color: colors.keyValueBg,
		});

		const textBlockSpan = (valueLines.length - 1) * valueLineHeight;
		let valueY =
			valueRectBottom +
			(valueHeight + textBlockSpan) / 2 -
			valueFontSize * 0.25;
		for (const line of valueLines) {
			page.drawText(line, {
				x: cardInnerX + 10,
				y: valueY,
				size: valueFontSize,
				font: monoFont,
				color: colors.keyValueText,
			});
			valueY -= valueLineHeight;
		}

		cardY = valueRectBottom - 16;
		for (const line of descLines) {
			page.drawText(line, {
				x: cardInnerX,
				y: cardY,
				size: 10.5,
				font: regularFont,
				color: rgb(0.24, 0.31, 0.43),
			});
			cardY -= descLineHeight;
		}

		y -= cardHeight + 14;
	}

	if (options.includeHandwrittenPasswordSection) {
		const sectionHeight = 106;
		drawRoundedRect({
			page,
			x: PAGE_MARGIN,
			y: y - sectionHeight,
			width: contentWidth,
			height: sectionHeight,
			radius: 8,
			color: colors.handCard,
			borderColor: rgb(0.69, 0.77, 0.93),
			borderWidth: 1,
		});

		const sectionX = PAGE_MARGIN + 16;
		page.drawText("Optional: Write Password By Hand", {
			x: sectionX,
			y: y - 20,
			size: 12,
			font: boldFont,
			color: rgb(0.12, 0.22, 0.54),
		});
		page.drawText(
			"For paper storage only. Leave this blank in digital copies.",
			{
				x: sectionX,
				y: y - 36,
				size: 9,
				font: regularFont,
				color: colors.muted,
			},
		);
		page.drawText("Master Password", {
			x: sectionX,
			y: y - 58,
			size: 9,
			font: boldFont,
			color: colors.muted,
		});
		page.drawLine({
			start: { x: sectionX, y: y - 82 },
			end: { x: PAGE_MARGIN + contentWidth - 16, y: y - 82 },
			thickness: 1.1,
			color: rgb(0.64, 0.72, 0.88),
		});

		y -= sectionHeight + 10;
	}

	const cautionLines = options.cautions.map((caution) =>
		wrapText(caution, regularFont, 10, contentWidth - 56),
	);
	const cautionBodyHeight = cautionLines.reduce(
		(total, lines) => total + lines.length * 12 + 4,
		0,
	);
	const cautionHeight = 28 + cautionBodyHeight + 10;

	drawRoundedRect({
		page,
		x: PAGE_MARGIN,
		y: y - cautionHeight,
		width: contentWidth,
		height: cautionHeight,
		radius: 8,
		color: colors.warnCard,
		borderColor: rgb(0.96, 0.86, 0.64),
		borderWidth: 1,
	});

	page.drawText("Store This Offline", {
		x: PAGE_MARGIN + 16,
		y: y - 18,
		size: 11,
		font: boldFont,
		color: rgb(0.54, 0.35, 0.0),
	});

	let cautionY = y - 34;
	for (const lines of cautionLines) {
		if (lines.length === 0) continue;
		page.drawText("•", {
			x: PAGE_MARGIN + 18,
			y: cautionY,
			size: 11,
			font: boldFont,
			color: rgb(0.44, 0.29, 0.0),
		});
		for (const line of lines) {
			page.drawText(line, {
				x: PAGE_MARGIN + 30,
				y: cautionY,
				size: 10,
				font: regularFont,
				color: rgb(0.44, 0.29, 0.0),
			});
			cautionY -= 12;
		}
		cautionY -= 4;
	}

	y -= cautionHeight + 10;

	page.drawLine({
		start: { x: PAGE_MARGIN, y: y - 2 },
		end: { x: PAGE_MARGIN + contentWidth, y: y - 2 },
		thickness: 0.8,
		color: colors.line,
	});
	drawWrappedText({
		page,
		text: options.footerNote,
		font: regularFont,
		size: 9,
		lineHeight: 11,
		x: PAGE_MARGIN,
		y: y - 16,
		maxWidth: contentWidth,
		color: colors.muted,
	});

	return pdfDoc.save();
};

export const downloadRecoveryKit = async (
	options: RecoveryKitOptions,
): Promise<RecoveryKitDownloadResult> => {
	try {
		const pdfBytes = await tryGeneratePdf(options);
		const normalizedPdfBytes = new Uint8Array(pdfBytes);
		const pdfBlob = new Blob([normalizedPdfBytes], {
			type: "application/pdf",
		});
		triggerDownload(pdfBlob, `${options.fileName}.pdf`);
		return "pdf-downloaded";
	} catch (error) {
		console.error("PDF generation failed, using txt fallback.", error);
		const textContent = buildRecoveryKitText(options);
		const textBlob = new Blob([textContent], { type: "text/plain" });
		triggerDownload(textBlob, `${options.fileName}.txt`);
		return "txt-downloaded";
	}
};
