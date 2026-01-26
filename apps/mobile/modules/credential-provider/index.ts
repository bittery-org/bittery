// Reexport the native module. On web, it will be resolved to CredentialProviderModule.web.ts
// and on native platforms to CredentialProviderModule.ts

export * from "./src/CredentialProvider.types";
export { default } from "./src/CredentialProviderModule";
