/**
 * Password Strength Analysis Utilities
 * Uses zxcvbn for advanced password analysis and provides recommendations
 */

import type { DecryptedItem } from "./types";

/**
 * Password strength levels
 */
export type PasswordStrength =
	| "very-weak"
	| "weak"
	| "fair"
	| "strong"
	| "very-strong";

/**
 * Password analysis result for a single password
 */
export interface PasswordAnalysis {
	strength: PasswordStrength;
	score: number; // 0-4 from zxcvbn
	crackTime: string; // Human-readable crack time
	crackTimeSeconds: number;
	feedback: {
		warning: string;
		suggestions: string[];
	};
}

/**
 * Password issue types
 */
export type PasswordIssueType = "weak" | "reused" | "old";

/**
 * A password with an identified issue
 */
export interface PasswordIssue {
	item: DecryptedItem;
	issueType: PasswordIssueType;
	analysis?: PasswordAnalysis;
	reusedCount?: number;
	daysSinceUpdate?: number;
}

/**
 * Overall security report for all passwords
 */
export interface SecurityReport {
	totalPasswords: number;
	weakPasswords: PasswordIssue[];
	reusedPasswords: PasswordIssue[];
	oldPasswords: PasswordIssue[];
	averageStrength: number; // 0-4
	securityScore: number; // 0-100
	recommendations: SecurityRecommendation[];
}

/**
 * Security recommendation
 */
export interface SecurityRecommendation {
	priority: "high" | "medium" | "low";
	title: string;
	description: string;
	actionable: boolean;
}

/**
 * Maps zxcvbn score (0-4) to strength level
 */
export function scoreToStrength(score: number): PasswordStrength {
	switch (score) {
		case 0:
			return "very-weak";
		case 1:
			return "weak";
		case 2:
			return "fair";
		case 3:
			return "strong";
		case 4:
			return "very-strong";
		default:
			return "very-weak";
	}
}

/**
 * Maps strength level to color for UI
 */
export function strengthToColor(strength: PasswordStrength): string {
	switch (strength) {
		case "very-weak":
			return "bg-red-500";
		case "weak":
			return "bg-orange-500";
		case "fair":
			return "bg-yellow-500";
		case "strong":
			return "bg-lime-500";
		case "very-strong":
			return "bg-green-500";
		default:
			return "bg-gray-500";
	}
}

/**
 * Maps strength level to text color for UI
 */
export function strengthToTextColor(strength: PasswordStrength): string {
	switch (strength) {
		case "very-weak":
			return "text-red-500";
		case "weak":
			return "text-orange-500";
		case "fair":
			return "text-yellow-500";
		case "strong":
			return "text-lime-500";
		case "very-strong":
			return "text-green-500";
		default:
			return "text-gray-500";
	}
}

/**
 * Maps strength level to human-readable label
 */
export function strengthToLabel(strength: PasswordStrength): string {
	switch (strength) {
		case "very-weak":
			return "Very Weak";
		case "weak":
			return "Weak";
		case "fair":
			return "Fair";
		case "strong":
			return "Strong";
		case "very-strong":
			return "Very Strong";
		default:
			return "Unknown";
	}
}

/**
 * Calculate days since a date
 */
export function daysSince(date: string | Date): number {
	const d = typeof date === "string" ? new Date(date) : date;
	const now = new Date();
	const diff = now.getTime() - d.getTime();
	return Math.floor(diff / (1000 * 60 * 60 * 24));
}

/**
 * Threshold for considering a password "old" (in days)
 */
export const OLD_PASSWORD_THRESHOLD_DAYS = 365; // 1 year

/**
 * Threshold for weak password score
 */
export const WEAK_PASSWORD_THRESHOLD = 2; // Score below 2 is considered weak

/**
 * Configuration for password analysis
 */
export interface AnalysisConfig {
	weakThreshold?: number;
	oldThresholdDays?: number;
}
