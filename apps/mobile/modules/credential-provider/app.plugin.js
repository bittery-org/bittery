const {
	withAndroidManifest,
	withDangerousMod,
} = require("expo/config-plugins");
const fs = require("node:fs");
const path = require("node:path");

/**
 * Config plugin that adds the Credential Provider service to the Android manifest
 * and copies required XML resources.
 */
const withCredentialProvider = (config) => {
	// First, copy the XML resource file
	let modifiedConfig = withDangerousMod(config, [
		"android",
		async (config) => {
			const projectRoot = config.modRequest.projectRoot;
			const androidResPath = path.join(
				projectRoot,
				"android",
				"app",
				"src",
				"main",
				"res",
			);

			// Ensure xml directory exists
			const xmlDir = path.join(androidResPath, "xml");
			if (!fs.existsSync(xmlDir)) {
				fs.mkdirSync(xmlDir, { recursive: true });
			}

			// Ensure raw directory exists
			const rawDir = path.join(androidResPath, "raw");
			if (!fs.existsSync(rawDir)) {
				fs.mkdirSync(rawDir, { recursive: true });
			}

			// Copy credential_provider.xml from module to app
			const sourceXml = path.join(
				projectRoot,
				"modules",
				"credential-provider",
				"android",
				"src",
				"main",
				"res",
				"xml",
				"credential_provider.xml",
			);
			const destXml = path.join(xmlDir, "credential_provider.xml");

			if (fs.existsSync(sourceXml)) {
				fs.copyFileSync(sourceXml, destXml);
				console.log(
					"withCredentialProvider: Copied credential_provider.xml to app resources",
				);
			} else {
				console.warn(
					"withCredentialProvider: Source XML not found at",
					sourceXml,
				);
			}

			// Copy autofill_service.xml from module to app
			const sourceAutofillXml = path.join(
				projectRoot,
				"modules",
				"credential-provider",
				"android",
				"src",
				"main",
				"res",
				"xml",
				"autofill_service.xml",
			);
			const destAutofillXml = path.join(xmlDir, "autofill_service.xml");

			if (fs.existsSync(sourceAutofillXml)) {
				fs.copyFileSync(sourceAutofillXml, destAutofillXml);
				console.log(
					"withCredentialProvider: Copied autofill_service.xml to app resources",
				);
			} else {
				console.warn(
					"withCredentialProvider: Autofill service XML not found at",
					sourceAutofillXml,
				);
			}

			// Copy privileged allowlist JSON from module to app
			const sourceAllowlist = path.join(
				projectRoot,
				"modules",
				"credential-provider",
				"apps.json",
			);
			const destAllowlist = path.join(
				rawDir,
				"credential_provider_allowlist.json",
			);

			if (fs.existsSync(sourceAllowlist)) {
				fs.copyFileSync(sourceAllowlist, destAllowlist);
				console.log(
					"withCredentialProvider: Copied credential_provider_allowlist.json to app resources",
				);
			} else {
				console.warn(
					"withCredentialProvider: Source allowlist not found at",
					sourceAllowlist,
				);
			}

			return config;
		},
	]);

	// Then, modify the Android manifest
	modifiedConfig = withAndroidManifest(modifiedConfig, async (config) => {
		// Ensure tools namespace is declared
		if (!config.modResults.manifest.$["xmlns:tools"]) {
			config.modResults.manifest.$["xmlns:tools"] =
				"http://schemas.android.com/tools";
		}

		const mainApplication = config.modResults.manifest.application?.[0];
		if (!mainApplication) {
			console.warn("withCredentialProvider: No application found in manifest");
			return config;
		}

		// Ensure the service array exists
		if (!mainApplication.service) {
			mainApplication.service = [];
		}

		// Check if service already exists
		const existingService = mainApplication.service.find(
			(service) =>
				service.$?.["android:name"] ===
				"expo.modules.credentialprovider.service.BitteryCredentialProviderService",
		);

		if (!existingService) {
			// Add the Credential Provider Service
			mainApplication.service.push({
				$: {
					"android:name":
						"expo.modules.credentialprovider.service.BitteryCredentialProviderService",
					"android:enabled": "true",
					"android:exported": "true",
					"android:label": "Bittery",
					"android:icon": "@mipmap/ic_launcher",
					"android:permission":
						"android.permission.BIND_CREDENTIAL_PROVIDER_SERVICE",
					"tools:targetApi": "upside_down_cake",
				},
				"intent-filter": [
					{
						action: [
							{
								$: {
									"android:name":
										"android.service.credentials.CredentialProviderService",
								},
							},
						],
					},
				],
				"meta-data": [
					{
						$: {
							"android:name": "android.credentials.provider",
							"android:resource": "@xml/credential_provider",
						},
					},
				],
			});
		}

		const existingAutofillService = mainApplication.service.find(
			(service) =>
				service.$?.["android:name"] ===
				"expo.modules.credentialprovider.service.BitteryAutofillService",
		);

		if (!existingAutofillService) {
			mainApplication.service.push({
				$: {
					"android:name":
						"expo.modules.credentialprovider.service.BitteryAutofillService",
					"android:enabled": "true",
					"android:exported": "true",
					"android:label": "Bittery",
					"android:permission": "android.permission.BIND_AUTOFILL_SERVICE",
					"tools:targetApi": "o",
				},
				"intent-filter": [
					{
						action: [
							{
								$: {
									"android:name": "android.service.autofill.AutofillService",
								},
							},
						],
					},
				],
				"meta-data": [
					{
						$: {
							"android:name": "android.autofill",
							"android:resource": "@xml/autofill_service",
						},
					},
				],
			});
		}

		// Ensure the activity array exists
		if (!mainApplication.activity) {
			mainApplication.activity = [];
		}

		// Check if activity already exists
		const existingActivity = mainApplication.activity.find(
			(activity) =>
				activity.$?.["android:name"] ===
				"expo.modules.credentialprovider.activity.GetCredentialsActivity",
		);

		if (!existingActivity) {
			// Add the GetCredentialsActivity
			mainApplication.activity.push({
				$: {
					"android:name":
						"expo.modules.credentialprovider.activity.GetCredentialsActivity",
					"android:exported": "false",
					"android:theme": "@style/Theme.Bittery.CredentialProvider",
					"android:excludeFromRecents": "true",
					"android:noHistory": "true",
				},
			});
		}

		const existingAutofillAuthActivity = mainApplication.activity.find(
			(activity) =>
				activity.$?.["android:name"] ===
				"expo.modules.credentialprovider.activity.AutofillAuthActivity",
		);

		if (!existingAutofillAuthActivity) {
			mainApplication.activity.push({
				$: {
					"android:name":
						"expo.modules.credentialprovider.activity.AutofillAuthActivity",
					"android:exported": "false",
					"android:theme": "@style/Theme.Bittery.CredentialProvider",
					"android:excludeFromRecents": "true",
					"android:noHistory": "true",
				},
			});
		}

		return config;
	});

	return modifiedConfig;
};

module.exports = withCredentialProvider;
