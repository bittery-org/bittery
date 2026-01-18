export interface CustomField {
	id: string;
	label: string;
	value: string;
	type: "text" | "password" | "email" | "url";
}

export interface VaultOption {
	id: string;
	name: string;
	type: "personal" | "team";
}
