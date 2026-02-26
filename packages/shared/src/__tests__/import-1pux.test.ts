import { describe, expect, test } from "bun:test";
import { onePassword1puxImportProvider } from "../import/providers/1password-1pux";

const ZIP_LOCAL_FILE_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_DIR_SIGNATURE = 0x02014b50;
const ZIP_EOCD_SIGNATURE = 0x06054b50;

function concatUint8Arrays(chunks: Uint8Array[]): Uint8Array {
	const totalLength = chunks.reduce((total, chunk) => total + chunk.length, 0);
	const output = new Uint8Array(totalLength);
	let offset = 0;
	for (const chunk of chunks) {
		output.set(chunk, offset);
		offset += chunk.length;
	}
	return output;
}

function createStoredZip(
	entries: Array<{ name: string; content: string }>,
): Uint8Array {
	const encoder = new TextEncoder();
	const localChunks: Uint8Array[] = [];
	const centralChunks: Uint8Array[] = [];
	let localOffset = 0;

	for (const entry of entries) {
		const nameBytes = encoder.encode(entry.name);
		const contentBytes = encoder.encode(entry.content);

		const localHeader = new Uint8Array(30 + nameBytes.length);
		const localView = new DataView(localHeader.buffer);
		localView.setUint32(0, ZIP_LOCAL_FILE_SIGNATURE, true);
		localView.setUint16(4, 20, true);
		localView.setUint16(6, 0, true);
		localView.setUint16(8, 0, true);
		localView.setUint16(10, 0, true);
		localView.setUint16(12, 0, true);
		localView.setUint32(14, 0, true);
		localView.setUint32(18, contentBytes.length, true);
		localView.setUint32(22, contentBytes.length, true);
		localView.setUint16(26, nameBytes.length, true);
		localView.setUint16(28, 0, true);
		localHeader.set(nameBytes, 30);

		const centralHeader = new Uint8Array(46 + nameBytes.length);
		const centralView = new DataView(centralHeader.buffer);
		centralView.setUint32(0, ZIP_CENTRAL_DIR_SIGNATURE, true);
		centralView.setUint16(4, 20, true);
		centralView.setUint16(6, 20, true);
		centralView.setUint16(8, 0, true);
		centralView.setUint16(10, 0, true);
		centralView.setUint16(12, 0, true);
		centralView.setUint16(14, 0, true);
		centralView.setUint32(16, 0, true);
		centralView.setUint32(20, contentBytes.length, true);
		centralView.setUint32(24, contentBytes.length, true);
		centralView.setUint16(28, nameBytes.length, true);
		centralView.setUint16(30, 0, true);
		centralView.setUint16(32, 0, true);
		centralView.setUint16(34, 0, true);
		centralView.setUint16(36, 0, true);
		centralView.setUint32(38, 0, true);
		centralView.setUint32(42, localOffset, true);
		centralHeader.set(nameBytes, 46);

		localChunks.push(localHeader, contentBytes);
		centralChunks.push(centralHeader);
		localOffset += localHeader.length + contentBytes.length;
	}

	const centralDirectory = concatUint8Arrays(centralChunks);
	const eocd = new Uint8Array(22);
	const eocdView = new DataView(eocd.buffer);
	eocdView.setUint32(0, ZIP_EOCD_SIGNATURE, true);
	eocdView.setUint16(4, 0, true);
	eocdView.setUint16(6, 0, true);
	eocdView.setUint16(8, entries.length, true);
	eocdView.setUint16(10, entries.length, true);
	eocdView.setUint32(12, centralDirectory.length, true);
	eocdView.setUint32(16, localOffset, true);
	eocdView.setUint16(20, 0, true);

	return concatUint8Arrays([...localChunks, centralDirectory, eocd]);
}

function create1puxFile(payload: unknown): File {
	const archive = createStoredZip([
		{
			name: "export.data",
			content: JSON.stringify(payload),
		},
	]);
	const fileBytes = new Uint8Array(archive.byteLength);
	fileBytes.set(archive);
	return new File([fileBytes.buffer], "sample.1pux", {
		type: "application/octet-stream",
	});
}

describe("onePassword1puxImportProvider", () => {
	test("parses a valid 1PUX with multiple vaults and items", async () => {
		const payload = {
			accounts: [
				{
					attrs: { name: "Main Account" },
					vaults: [
						{
							attrs: { uuid: "vault-personal", name: "Personal" },
							items: [
								{
									uuid: "login-1",
									categoryUuid: "001",
									favIndex: 1,
									overview: {
										title: "GitHub",
										url: "github.com",
										urls: [{ url: "https://github.com/login" }],
									},
									details: {
										notesPlain: "primary login",
										loginFields: [
											{
												id: "username",
												designation: "username",
												value: "octocat",
											},
											{
												id: "password",
												designation: "password",
												value: { concealed: "hunter2" },
											},
											{
												id: "otp",
												designation: "totp",
												value:
													"otpauth://totp/GitHub:octocat?secret=JBSWY3DPEHPK3PXP&issuer=GitHub&digits=6&period=30",
											},
											{
												id: "favorite-color",
												title: "Favorite Color",
												value: "blue",
											},
										],
									},
								},
								{
									uuid: "card-1",
									categoryUuid: "002",
									overview: { title: "Visa Personal" },
									details: {
										fields: [
											{ id: "cardholder", value: "Jane Doe" },
											{ id: "ccnum", value: "4111111111111111" },
											{ id: "expiry", value: "08/2032" },
											{ id: "cvv", value: "123" },
										],
									},
								},
							],
						},
						{
							attrs: { uuid: "vault-work", name: "Work" },
							items: [
								{
									uuid: "identity-1",
									categoryUuid: "004",
									overview: { title: "Identity" },
									details: {
										fields: [
											{ id: "firstName", value: "Jane" },
											{ id: "lastName", value: "Doe" },
											{ id: "email", value: "jane@example.com" },
											{ id: "phone", value: "+1 555 0100" },
											{ id: "street", value: "1 Main St" },
											{ id: "city", value: "San Francisco" },
											{ id: "state", value: "CA" },
											{ id: "zip", value: "94105" },
											{ id: "country", value: "US" },
										],
									},
								},
								{
									uuid: "totp-1",
									category: "one-time password",
									overview: { title: "AWS OTP" },
									details: {
										fields: [
											{
												id: "totp",
												designation: "totp",
												value:
													"otpauth://totp/AWS:jane@example.com?secret=JBSWY3DPEHPK3PXP&issuer=AWS&algorithm=SHA1&digits=6&period=30",
											},
										],
									},
								},
								{
									uuid: "doc-1",
									category: "document",
									overview: { title: "Passport Scan" },
									details: {
										documentAttributes: { fileName: "passport.pdf" },
									},
								},
								{
									uuid: "attach-login",
									categoryUuid: "001",
									overview: { title: "AWS Root" },
									file: { attrs: { name: "backup.txt" } },
									details: {
										fields: [
											{ id: "username", value: "root" },
											{ id: "password", value: "secret" },
										],
										files: [{ name: "backup.txt" }],
									},
								},
								{
									uuid: "unknown-1",
									category: "spaceship",
									overview: { title: "Unknown Category" },
									details: {
										fields: [{ id: "username", value: "pilot" }],
									},
								},
								{
									uuid: "archived-1",
									state: "archived",
									categoryUuid: "001",
									overview: { title: "Archived Login" },
									details: {
										fields: [
											{ id: "username", value: "old-user" },
											{ id: "password", value: "old-pass" },
										],
									},
								},
							],
						},
					],
				},
			],
		};

		const preview = await onePassword1puxImportProvider.parse(
			create1puxFile(payload),
		);

		expect(preview.summary.vaultCount).toBe(2);
		expect(preview.summary.itemCount).toBe(6);
		expect(preview.summary.skippedCount).toBe(2);
		expect(
			preview.sourceVaults.find((vault) => vault.id === "vault-work"),
		).toEqual({
			id: "vault-work",
			name: "Work",
			itemCount: 4,
			skippedCount: 2,
		});

		const loginItem = preview.sourceItems.find((item) => item.id === "login-1");
		expect(loginItem?.category).toBe("login");
		expect(loginItem?.favorite).toBe(true);
		expect(loginItem?.data.url).toBe("https://github.com");
		expect(loginItem?.data.urls).toEqual(["https://github.com/login"]);
		expect(loginItem?.data.username).toBe("octocat");
		expect(loginItem?.data.password).toBe("hunter2");
		expect(loginItem?.data.totpIssuer).toBe("GitHub");

		const cardItem = preview.sourceItems.find((item) => item.id === "card-1");
		expect(cardItem?.category).toBe("credit-card");
		expect(cardItem?.data.cardholderName).toBe("Jane Doe");
		expect(cardItem?.data.cardNumber).toBe("4111111111111111");
		expect(cardItem?.data.cvv).toBe("123");
		expect(cardItem?.data.expiryDate).toBe("08/2032");

		const identityItem = preview.sourceItems.find(
			(item) => item.id === "identity-1",
		);
		expect(identityItem?.category).toBe("identity");
		expect(identityItem?.data.firstName).toBe("Jane");
		expect(identityItem?.data.addresses?.[0]?.city).toBe("San Francisco");
		expect(identityItem?.data.phoneNumbers?.[0]?.number).toBe("+1 555 0100");

		const totpItem = preview.sourceItems.find((item) => item.id === "totp-1");
		expect(totpItem?.category).toBe("totp");
		expect(totpItem?.data.totpSecret).toBe("JBSWY3DPEHPK3PXP");
		expect(totpItem?.data.totpIssuer).toBe("AWS");
		expect(totpItem?.data.totpDigits).toBe(6);

		const unknownItem = preview.sourceItems.find(
			(item) => item.id === "unknown-1",
		);
		expect(unknownItem?.category).toBe("login");

		expect(preview.sourceItems.some((item) => item.id === "doc-1")).toBe(false);
		expect(
			preview.warnings.some(
				(warning) => warning.code === "attachments-skipped",
			),
		).toBe(true);
		expect(
			preview.warnings.some((warning) => warning.code === "documents-skipped"),
		).toBe(true);
		expect(
			preview.warnings.some((warning) => warning.code === "archived-skipped"),
		).toBe(true);
		expect(
			preview.warnings.some((warning) => warning.code === "category-fallback"),
		).toBe(true);

		if (!loginItem) {
			throw new Error("Expected login item to exist in parsed preview");
		}

		const decrypted =
			onePassword1puxImportProvider.toDecryptedItemData(loginItem);
		expect(decrypted.category).toBe("login");
		expect(decrypted.favorite).toBe(true);
		expect(decrypted.data.title).toBe("GitHub");
	});

	test("degrades gracefully for missing fields and titles", async () => {
		const payload = {
			vaults: [
				{
					uuid: "vault-1",
					name: "Imported Vault",
					items: [
						{
							uuid: "item-1",
							categoryUuid: "003",
							details: {
								fields: [{ id: "notes", value: "No title present" }],
							},
						},
					],
				},
			],
		};

		const preview = await onePassword1puxImportProvider.parse(
			create1puxFile(payload),
		);

		expect(preview.summary.itemCount).toBe(1);
		expect(preview.sourceItems[0]?.title).toBe("Imported item 1");
		expect(preview.sourceItems[0]?.category).toBe("secure-note");
		expect(preview.sourceItems[0]?.data.note).toBe("No title present");
		expect(
			preview.warnings.some((warning) => warning.code === "missing-title"),
		).toBe(true);
	});

	test("removes section prefixes from imported custom field labels", async () => {
		const payload = {
			vaults: [
				{
					uuid: "vault-1",
					name: "Imported Vault",
					items: [
						{
							uuid: "item-1",
							categoryUuid: "001",
							overview: { title: "Paddle" },
							details: {
								fields: [{ id: "username", value: "jane@example.com" }],
								sections: [
									{
										title: "Section_lgecg5mjbhe66jwummkvyywwga",
										fields: [{ title: "secret access key", value: "abc123" }],
									},
									{
										title: "Gespeichert auf login.paddle.com",
										fields: [{ title: "First name", value: "Jane" }],
									},
								],
							},
						},
					],
				},
			],
		};

		const preview = await onePassword1puxImportProvider.parse(
			create1puxFile(payload),
		);
		const item = preview.sourceItems[0];
		const labels = item?.data.customFields?.map((field) => field.label) ?? [];

		expect(labels).toEqual(["secret access key", "First name"]);
	});

	test("prefers meaningful password fields over boolean-style values", async () => {
		const payload = {
			vaults: [
				{
					uuid: "vault-1",
					name: "Imported Vault",
					items: [
						{
							uuid: "item-1",
							categoryUuid: "001",
							overview: { title: "Legacy Login" },
							details: {
								fields: [
									{ id: "username", designation: "username", value: "jane" },
									{
										id: "entry[password]",
										designation: "password",
										value: "1",
									},
									{
										id: "entry[password][repeat]",
										type: "p",
										value: { concealed: "correct-horse-battery-staple" },
									},
								],
							},
						},
					],
				},
			],
		};

		const preview = await onePassword1puxImportProvider.parse(
			create1puxFile(payload),
		);
		const item = preview.sourceItems[0];
		const customFieldLabels =
			item?.data.customFields?.map((field) => field.label) ?? [];

		expect(item?.data.password).toBe("correct-horse-battery-staple");
		expect(customFieldLabels).not.toContain("entry[password]");
		expect(customFieldLabels).not.toContain("entry[password][repeat]");
	});

	test("throws a clear error for corrupt 1PUX files", async () => {
		const corruptFile = new File([new Uint8Array([1, 2, 3, 4])], "bad.1pux", {
			type: "application/octet-stream",
		});

		await expect(
			onePassword1puxImportProvider.parse(corruptFile),
		).rejects.toThrow("Could not read 1PUX archive");
	});
});
