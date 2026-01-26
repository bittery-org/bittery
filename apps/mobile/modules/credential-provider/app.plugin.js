const {
	withAndroidManifest,
	withDangerousMod,
} = require("expo/config-plugins");
const fs = require("fs");
const path = require("path");

/**
 * Config plugin that adds the Credential Provider service to the Android manifest
 * and copies required XML resources.
 */
const withCredentialProvider = (config) => {
	// First, copy the XML resource file
	config = withDangerousMod(config, [
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

			return config;
		},
	]);

	// Then, modify the Android manifest
	config = withAndroidManifest(config, async (config) => {
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

		return config;
	});

	return config;
};

module.exports = withCredentialProvider;
