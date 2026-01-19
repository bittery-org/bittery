import {
	daysSince,
	OLD_PASSWORD_THRESHOLD_DAYS,
	type PasswordAnalysis,
	type PasswordIssue,
	type SecurityRecommendation,
	type SecurityReport,
	scoreToStrength,
	WEAK_PASSWORD_THRESHOLD,
} from "@bittery/shared/password-analysis";
import type { DecryptedItem } from "@bittery/shared/types";
import { useMemo } from "react";
import zxcvbn from "zxcvbn";

/**
 * Analyze a single password using zxcvbn
 */
export function analyzePassword(password: string): PasswordAnalysis {
	const result = zxcvbn(password);

	return {
		strength: scoreToStrength(result.score),
		score: result.score,
		crackTime: result.crack_times_display
			.offline_slow_hashing_1e4_per_second as string,
		crackTimeSeconds: result.crack_times_seconds
			.offline_slow_hashing_1e4_per_second as number,
		feedback: {
			warning: result.feedback.warning || "",
			suggestions: result.feedback.suggestions || [],
		},
	};
}

/**
 * Generate security recommendations based on the analysis
 */
function generateRecommendations(
	weakCount: number,
	reusedCount: number,
	oldCount: number,
	totalPasswords: number,
): SecurityRecommendation[] {
	const recommendations: SecurityRecommendation[] = [];

	if (weakCount > 0) {
		recommendations.push({
			priority: "high",
			title: `Update ${weakCount} weak password${weakCount > 1 ? "s" : ""}`,
			description:
				"Weak passwords can be easily cracked. Use the password generator to create strong, unique passwords.",
			actionable: true,
		});
	}

	if (reusedCount > 0) {
		recommendations.push({
			priority: "high",
			title: `Change ${reusedCount} reused password${reusedCount > 1 ? "s" : ""}`,
			description:
				"Using the same password across multiple accounts puts all of them at risk if one is compromised.",
			actionable: true,
		});
	}

	if (oldCount > 0) {
		recommendations.push({
			priority: "medium",
			title: `Review ${oldCount} old password${oldCount > 1 ? "s" : ""}`,
			description:
				"Passwords that haven't been updated in over a year may be at risk. Consider updating them periodically.",
			actionable: true,
		});
	}

	if (totalPasswords > 0 && weakCount === 0 && reusedCount === 0) {
		recommendations.push({
			priority: "low",
			title: "Great job!",
			description:
				"Your passwords are strong and unique. Keep up the good security practices.",
			actionable: false,
		});
	}

	if (totalPasswords === 0) {
		recommendations.push({
			priority: "low",
			title: "Add some passwords",
			description:
				"Start adding passwords to your vault to see security recommendations.",
			actionable: false,
		});
	}

	return recommendations;
}

/**
 * Calculate an overall security score (0-100)
 */
function calculateSecurityScore(
	totalPasswords: number,
	weakCount: number,
	reusedCount: number,
	oldCount: number,
	averageStrength: number,
): number {
	if (totalPasswords === 0) return 100;

	// Start with base score from average strength (0-4 -> 0-50 points)
	let score = (averageStrength / 4) * 50;

	// Deduct points for weak passwords (up to 25 points)
	const weakPenalty = Math.min(25, (weakCount / totalPasswords) * 50);
	score -= weakPenalty;

	// Deduct points for reused passwords (up to 15 points)
	const reusedPenalty = Math.min(15, (reusedCount / totalPasswords) * 30);
	score -= reusedPenalty;

	// Deduct points for old passwords (up to 10 points)
	const oldPenalty = Math.min(10, (oldCount / totalPasswords) * 20);
	score -= oldPenalty;

	// Bonus for having no issues
	if (weakCount === 0 && reusedCount === 0) {
		score += 25;
	}

	return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * Hook to analyze password security across all provided items
 */
export function usePasswordSecurity(items: DecryptedItem[]): SecurityReport {
	return useMemo(() => {
		// Filter to only login items with passwords
		const loginItems = items.filter(
			(item) => item.category === "login" && item.password,
		);

		if (loginItems.length === 0) {
			return {
				totalPasswords: 0,
				weakPasswords: [],
				reusedPasswords: [],
				oldPasswords: [],
				averageStrength: 0,
				securityScore: 100,
				recommendations: generateRecommendations(0, 0, 0, 0),
			};
		}

		// Analyze all passwords
		const analysisMap = new Map<string, PasswordAnalysis>();
		const passwordToItems = new Map<string, DecryptedItem[]>();

		for (const item of loginItems) {
			const password = item.password!;

			// Get or compute analysis
			if (!analysisMap.has(password)) {
				analysisMap.set(password, analyzePassword(password));
			}

			// Track password reuse
			const existing = passwordToItems.get(password) || [];
			existing.push(item);
			passwordToItems.set(password, existing);
		}

		// Identify weak passwords
		const weakPasswords: PasswordIssue[] = [];
		for (const item of loginItems) {
			const analysis = analysisMap.get(item.password!);
			if (analysis && analysis.score < WEAK_PASSWORD_THRESHOLD) {
				weakPasswords.push({
					item,
					issueType: "weak",
					analysis,
				});
			}
		}

		// Identify reused passwords
		const reusedPasswords: PasswordIssue[] = [];
		for (const [password, items] of passwordToItems) {
			if (items.length > 1) {
				const analysis = analysisMap.get(password);
				for (const item of items) {
					reusedPasswords.push({
						item,
						issueType: "reused",
						analysis,
						reusedCount: items.length,
					});
				}
			}
		}

		// Identify old passwords
		const oldPasswords: PasswordIssue[] = [];
		for (const item of loginItems) {
			const days = daysSince(item.updatedAt);
			if (days > OLD_PASSWORD_THRESHOLD_DAYS) {
				const analysis = analysisMap.get(item.password!);
				oldPasswords.push({
					item,
					issueType: "old",
					analysis,
					daysSinceUpdate: days,
				});
			}
		}

		// Calculate average strength
		let totalStrength = 0;
		for (const analysis of analysisMap.values()) {
			totalStrength += analysis.score;
		}
		const averageStrength =
			analysisMap.size > 0 ? totalStrength / analysisMap.size : 0;

		// Calculate security score
		const securityScore = calculateSecurityScore(
			loginItems.length,
			weakPasswords.length,
			reusedPasswords.length,
			oldPasswords.length,
			averageStrength,
		);

		// Generate recommendations
		const recommendations = generateRecommendations(
			weakPasswords.length,
			reusedPasswords.length,
			oldPasswords.length,
			loginItems.length,
		);

		return {
			totalPasswords: loginItems.length,
			weakPasswords,
			reusedPasswords,
			oldPasswords,
			averageStrength,
			securityScore,
			recommendations,
		};
	}, [items]);
}
