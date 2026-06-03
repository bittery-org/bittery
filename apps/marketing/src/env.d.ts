/// <reference types="vite/client" />

interface ImportMetaEnv {
	readonly VITE_WEBAPP_URL: string;
	readonly VITE_SERVER_URL: string;
	readonly VITE_BILLING_MARKETING_ENABLED: string;
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}
