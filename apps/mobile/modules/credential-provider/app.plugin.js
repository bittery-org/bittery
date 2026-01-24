const { withAndroidManifest } = require("expo/config-plugins");

/**
 * Config plugin that adds the Credential Provider service to the Android manifest.
 * This is needed for the app to appear in Android's credential provider settings.
 */
const withCredentialProvider = (config) => {
  return withAndroidManifest(config, async (config) => {
    // Ensure tools namespace is declared
    if (!config.modResults.manifest.$["xmlns:tools"]) {
      config.modResults.manifest.$["xmlns:tools"] = "http://schemas.android.com/tools";
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
        "expo.modules.credentialprovider.service.BitteryCredentialProviderService"
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
        "expo.modules.credentialprovider.activity.GetCredentialsActivity"
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
};

module.exports = withCredentialProvider;
