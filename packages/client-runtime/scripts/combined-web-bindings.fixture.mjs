import { takeFullOwnedUint8ArrayIntrinsic } from "../src/binary-intrinsics.ts";

export const unavailableDownloadSink = () => ({
	invoke: async (controlRequestJson) => {
		const type = JSON.parse(controlRequestJson).type;
		if (type === "retireAccount" || type === "retireRuntime")
			return '{"type":"retired"}';
		return type === "completeAccountRetirement"
			? '{"type":"retirementCompleted"}'
			: '{"type":"invariantViolation"}';
	},
});

export const unavailableUploadSource = () => ({
	invoke: async (controlRequestJson) => {
		const type = JSON.parse(controlRequestJson).type;
		const answer =
			type === "retireAccount" || type === "retireRuntime"
				? { type: "retired" }
				: type === "completeAccountRetirement"
					? { type: "retirementCompleted" }
					: { type: "invariantViolation" };
		return { controlResponseJson: JSON.stringify(answer) };
	},
});

export const unavailableVaultImageArtifact = () => ({
	invoke: async (controlRequestJson) => {
		const type = JSON.parse(controlRequestJson).type;
		return {
			controlResponseJson: JSON.stringify({
				type:
					type === "wipe"
						? "wiped"
						: type === "deleteAccount"
							? "accountDeleted"
							: "invariantViolation",
			}),
		};
	},
});

export const unavailableVaultImageSource = () => ({
	invoke: async (controlRequestJson) => ({
		controlResponseJson: JSON.stringify({
			type: [
				"retireAccount",
				"completeAccountRetirement",
				"retireRuntime",
			].includes(JSON.parse(controlRequestJson).type)
				? "retired"
				: "invariantViolation",
		}),
	}),
});

export const timerProbeRuntime = (
	bindings,
	downloadSink = unavailableDownloadSink(),
) =>
	bindings.WebClientRuntime.withConfiguredAttachmentMovePreparation(
		async () => '{"type":"deviceState","accounts":[]}',
		async (requestJson) =>
			JSON.parse(requestJson).type === "get"
				? '{"type":"value","value":null}'
				: '{"type":"done"}',
		async () => '{"type":"networkFailure"}',
		() => undefined,
		{ invoke: async () => ({ controlResponseJson: '{"type":"deviceWiped"}' }) },
		{
			invoke: async () => ({ controlResponseJson: '{"type":"deviceWiped"}' }),
			close: () => undefined,
		},
		{ acquire: async () => null },
		"timer-probe",
		"web",
		"1.0.0",
		() => undefined,
		downloadSink,
		unavailableUploadSource(),
		takeFullOwnedUint8ArrayIntrinsic,
		unavailableVaultImageArtifact(),
		unavailableVaultImageSource(),
		"runtime-vault-image",
	);
