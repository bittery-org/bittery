import {
	commitWebAttachmentDownloadRuntimeIncarnation,
	ownsWebAttachmentDownloadRuntimeIncarnation,
	prepareWebAttachmentDownloadRuntimeIncarnation,
	type WebAttachmentDownloadSinkRegistry,
} from "../web-attachment-download-sink";
import {
	commitWebAttachmentUploadRuntimeIncarnation,
	ownsWebAttachmentUploadRuntimeIncarnation,
	prepareWebAttachmentUploadRuntimeIncarnation,
	type WebAttachmentUploadSourceRegistry,
} from "../web-attachment-upload-source";

type RetainedScopes = {
	incarnation: string;
	download: boolean;
	upload: boolean;
};

async function retire(
	downloads: WebAttachmentDownloadSinkRegistry,
	uploads: WebAttachmentUploadSourceRegistry,
	retained: RetainedScopes,
): Promise<void> {
	const results = await Promise.allSettled([
		retained.download
			? downloads.invoke(
					'{"type":"retireRuntime"}',
					undefined,
					retained.incarnation,
				)
			: undefined,
		retained.upload
			? uploads.invoke('{"type":"retireRuntime"}', retained.incarnation)
			: undefined,
	]);
	if (
		retained.download &&
		results[0].status === "fulfilled" &&
		results[0].value === '{"type":"retired"}'
	)
		retained.download = false;
	if (
		retained.upload &&
		results[1].status === "fulfilled" &&
		results[1].value?.controlResponseJson === '{"type":"retired"}'
	)
		retained.upload = false;
	if (retained.download || retained.upload)
		throw new Error("Attachment Runtime scope retirement failed");
}

export function createAttachmentRuntimeIncarnationTransitions(
	downloads: WebAttachmentDownloadSinkRegistry,
	uploads: WebAttachmentUploadSourceRegistry,
): (
	phase: "prepare" | "commit",
	incarnation: string,
) => Promise<"prepare" | "commit"> {
	let retained: RetainedScopes | undefined;
	let tail = Promise.resolve();
	return (phase, incarnation) => {
		const transition = tail.then(async () => {
			if (phase === "prepare") {
				if (retained !== undefined) {
					await retire(downloads, uploads, retained);
					retained = undefined;
				}
				retained = { incarnation, download: false, upload: false };
			}
			if (
				phase === "commit" &&
				retained !== undefined &&
				retained.incarnation !== incarnation
			)
				throw new Error(
					"Attachment Runtime commit does not own the prepared pair",
				);
			try {
				if (phase === "prepare") {
					const preparedScopes = retained;
					if (preparedScopes?.incarnation !== incarnation)
						throw new Error(
							"Attachment Runtime preparation ownership was lost",
						);
					await prepareWebAttachmentDownloadRuntimeIncarnation(
						downloads,
						incarnation,
					);
					preparedScopes.download = true;
					await prepareWebAttachmentUploadRuntimeIncarnation(
						uploads,
						incarnation,
					);
					preparedScopes.upload = true;
				} else {
					await commitWebAttachmentDownloadRuntimeIncarnation(
						downloads,
						incarnation,
					);
					await commitWebAttachmentUploadRuntimeIncarnation(
						uploads,
						incarnation,
					);
				}
			} catch (error) {
				if (retained?.incarnation === incarnation) {
					retained.download =
						retained.download ||
						ownsWebAttachmentDownloadRuntimeIncarnation(downloads, incarnation);
					retained.upload =
						retained.upload ||
						ownsWebAttachmentUploadRuntimeIncarnation(uploads, incarnation);
				}
				try {
					if (retained !== undefined)
						await retire(downloads, uploads, retained);
					retained = undefined;
				} catch {
					// The exact failed scope remains retained for the next serialized retry.
				}
				throw error;
			}
			if (phase === "commit" && retained?.incarnation === incarnation)
				retained = undefined;
			return phase;
		});
		tail = transition.then(
			() => undefined,
			() => undefined,
		);
		return transition;
	};
}
