// Reexport the native module. On web, it will be resolved to CredentialProviderModule.web.ts
// and on native platforms to CredentialProviderModule.ts
export { default } from "./src/CredentialProviderModule";
export * from "./src/CredentialProvider.types";
