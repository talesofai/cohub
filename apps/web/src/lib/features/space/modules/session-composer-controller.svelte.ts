import {
	type ComposerAttachment,
	type ComposerFileAttachment,
	type ComposerImageAttachment,
	createComposerAttachmentId,
	isComposerImageFile,
	isSupportedComposerAttachmentFile,
	isSupportedComposerImageFile,
	MAX_COMPOSER_ATTACHMENTS,
	readComposerTextAttachment,
} from "$lib/composer-attachments";
import { prepareChatImageAttachment } from "$lib/public-asset-images";
import { entriesFromFiles, type LocalUploadEntry } from "$lib/upload-entries";

export function revokeComposerAttachmentPreview(
	attachment: ComposerAttachment,
) {
	if (attachment.kind === "image") URL.revokeObjectURL(attachment.previewUrl);
}

export function createSessionComposerController() {
	let input = $state("");
	let attachments = $state<ComposerAttachment[]>([]);
	let sending = $state(false);
	let aborting = $state(false);
	let error = $state("");
	let errorCode = $state<string | null>(null);

	function clearError() {
		error = "";
		errorCode = null;
	}

	function setError(message: string, code: string | null = null) {
		error = message;
		errorCode = code;
	}

	function setAttachments(next: ComposerAttachment[]) {
		attachments = next;
	}

	function setUploading(kind: "file" | "image") {
		attachments = attachments.map((attachment) =>
			attachment.kind === kind
				? { ...attachment, status: "uploading" as const }
				: attachment,
		);
	}

	function setUploadedImageUrls(imageUrls: Map<string, string>) {
		attachments = attachments.map((attachment) =>
			attachment.kind === "image"
				? {
						...attachment,
						status: "ready" as const,
						uploadedUrl: imageUrls.get(attachment.id) ?? attachment.uploadedUrl,
					}
				: attachment,
		);
	}

	function clearDraft() {
		input = "";
		attachments = [];
	}

	function restoreDraft(
		nextInput: string,
		nextAttachments: ComposerAttachment[],
	) {
		input = nextInput;
		attachments = nextAttachments;
	}

	function markAttachmentUploadsFailed() {
		attachments = attachments.map((attachment) =>
			attachment.kind === "file" || attachment.kind === "image"
				? { ...attachment, status: "failed" as const }
				: attachment,
		);
	}

	async function handlePickAttachments(
		files: FileList | File[] | LocalUploadEntry[] | null,
	) {
		if (!files) return;
		let pickedEntries: LocalUploadEntry[];
		try {
			pickedEntries =
				Array.isArray(files) &&
				files.every((item) => "file" in item && "relativePath" in item)
					? (files as LocalUploadEntry[])
					: entriesFromFiles(Array.from(files as FileList | File[]));
		} catch {
			setError("Invalid upload path.");
			return;
		}
		if (pickedEntries.length === 0) return;

		const remainingSlots = MAX_COMPOSER_ATTACHMENTS - attachments.length;
		if (remainingSlots <= 0) {
			setError(`You can attach up to ${MAX_COMPOSER_ATTACHMENTS} files.`);
			return;
		}
		const acceptedEntries = pickedEntries.slice(0, remainingSlots);
		if (acceptedEntries.length < pickedEntries.length) {
			setError(
				`Only the first ${remainingSlots} file${remainingSlots === 1 ? "" : "s"} were attached.`,
			);
		} else {
			clearError();
		}

		try {
			const nextAttachments = await Promise.all(
				acceptedEntries.map(async (entry): Promise<ComposerAttachment> => {
					const { file, relativePath } = entry;
					const fallbackFileAttachment = (): ComposerFileAttachment => ({
						kind: "file",
						id: createComposerAttachmentId(file),
						name: file.name,
						relativePath,
						mediaType: file.type || null,
						file,
						size: file.size,
						status: "ready",
					});
					if (file.size === 0) throw new Error(`File "${file.name}" is empty.`);
					if (!isSupportedComposerAttachmentFile(file))
						return fallbackFileAttachment();
					if (!isComposerImageFile(file)) {
						try {
							return await readComposerTextAttachment(file);
						} catch (error) {
							if (error instanceof Error && !error.message.includes("exceeds"))
								throw error;
							return fallbackFileAttachment();
						}
					}
					if (!isSupportedComposerImageFile(file))
						return fallbackFileAttachment();
					try {
						const compressed = await prepareChatImageAttachment(file);
						return {
							kind: "image",
							id: createComposerAttachmentId(file),
							name: compressed.name,
							mediaType: compressed.mediaType,
							file: compressed.file,
							previewUrl: compressed.previewUrl,
							size: compressed.size,
							status: "ready",
						} satisfies ComposerImageAttachment;
					} catch (error) {
						console.warn("[composer] image preprocessing failed", {
							name: file.name,
							type: file.type,
							size: file.size,
							error,
						});
						return fallbackFileAttachment();
					}
				}),
			);
			attachments = [...attachments, ...nextAttachments];
		} catch (error) {
			setError(
				error instanceof Error ? error.message : "Failed to read attachment",
			);
		}
	}

	function handleRemoveAttachment(id: string) {
		const removed = attachments.find((attachment) => attachment.id === id);
		if (removed) revokeComposerAttachmentPreview(removed);
		attachments = attachments.filter((attachment) => attachment.id !== id);
	}

	function dispose() {
		for (const attachment of attachments)
			revokeComposerAttachmentPreview(attachment);
	}

	return {
		get input() {
			return input;
		},
		set input(value: string) {
			input = value;
		},
		get attachments() {
			return attachments;
		},
		set attachments(value: ComposerAttachment[]) {
			attachments = value;
		},
		get sending() {
			return sending;
		},
		set sending(value: boolean) {
			sending = value;
		},
		get aborting() {
			return aborting;
		},
		set aborting(value: boolean) {
			aborting = value;
		},
		get error() {
			return error;
		},
		get errorCode() {
			return errorCode;
		},
		clearError,
		setError,
		setAttachments,
		setUploading,
		setUploadedImageUrls,
		clearDraft,
		restoreDraft,
		markAttachmentUploadsFailed,
		handlePickAttachments,
		handleRemoveAttachment,
		dispose,
	};
}
