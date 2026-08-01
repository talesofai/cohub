import type { HttpTransport } from "../transport.js";

export type PublicAssetPurpose = "user_avatar" | "space_avatar" | "chat_attachment";
export type PublicAssetUploadProtocol = "s3_post_v1" | "presigned_put_v1";
/** Avatar + preprocessed chat images. General chat files may use any mime string. */
export type PublicAssetMimeType = "image/webp" | "image/jpeg";

/** Strip characters Safari rejects in FormData file names. */
function sanitizeFormDataFilename(filename: string | undefined): string | undefined {
  if (typeof filename !== "string") return undefined;
  const base = filename.split(/[/\\]/).pop()?.replace(/[\r\n\0]/g, "").trim() ?? "";
  return base.length > 0 ? base : undefined;
}

export type CreatePublicAssetUploadInput = {
  purpose: PublicAssetPurpose;
  uploadProtocol?: PublicAssetUploadProtocol;
  spaceId?: string;
  sessionId?: string;
  file: {
    size: number;
    mimeType: string;
    filename?: string;
  };
};

type PublicAssetUploadBase = {
  purpose: PublicAssetPurpose;
  objectKey: string;
  publicUrl: string;
  uploadUrl: string;
};

export type CreatePublicAssetUploadResponse = {
  expiresAt: string;
  asset: PublicAssetUploadBase & (
    | { uploadMethod: "POST"; uploadFields: Record<string, string> }
    | { uploadMethod: "PUT"; uploadHeaders?: Record<string, string> }
  );
};

export type UploadPublicAssetInput = {
  purpose: PublicAssetPurpose;
  spaceId?: string;
  sessionId?: string;
  file: Blob;
  mimeType: string;
  filename?: string;
};

export type UploadChatAttachmentInput = {
  /** Optional account association; Work uploads are always bound to the Work Space. */
  spaceId?: string;
  /** Optional association for an authorized prompt session. */
  sessionId?: string;
  file: Blob;
  mimeType: string;
  filename?: string;
};

/** @deprecated Prefer UploadChatAttachmentInput — images are a special case of chat attachments. */
export type UploadChatImageAttachmentInput = UploadChatAttachmentInput & {
  mimeType: PublicAssetMimeType;
};

export class PublicAssetsApi {
  constructor(private readonly transport: HttpTransport) {}

  createUpload(input: CreatePublicAssetUploadInput) {
    return this.transport.request<CreatePublicAssetUploadResponse>("/api/public-assets/uploads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  }

  async upload(input: UploadPublicAssetInput) {
    const plan = await this.createUpload({
      purpose: input.purpose,
      uploadProtocol: input.purpose === "chat_attachment" ? "presigned_put_v1" : undefined,
      spaceId: input.spaceId,
      sessionId: input.sessionId,
      file: {
        size: input.file.size,
        mimeType: input.mimeType,
        filename: input.filename,
      },
    });
    let response: Response;
    if (plan.asset.uploadMethod === "PUT") {
      response = await fetch(plan.asset.uploadUrl, {
        method: "PUT",
        headers: plan.asset.uploadHeaders,
        body: input.file,
      });
    } else {
      const formData = new FormData();
      for (const [key, value] of Object.entries(plan.asset.uploadFields)) {
        formData.append(key, value);
      }
      // Safari rejects FormData filenames with CR/LF/control chars.
      const safeFilename = sanitizeFormDataFilename(input.filename);
      if (safeFilename) formData.append("file", input.file, safeFilename);
      else formData.append("file", input.file);
      try {
        response = await fetch(plan.asset.uploadUrl, {
          method: "POST",
          body: formData,
        });
      } catch (error) {
        if (
          error instanceof TypeError &&
          (error.message === "The string did not match the expected pattern." ||
            /Failed to construct|invalid/i.test(error.message))
        ) {
          throw new Error(
            `Public asset upload failed: invalid upload request${safeFilename ? ` (${safeFilename})` : ""}`,
            { cause: error },
          );
        }
        throw error;
      }
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`Public asset upload failed: HTTP ${response.status}${detail ? ` — ${detail}` : ""}`);
    }
    return plan.asset;
  }

  /** Durable viewer-scoped upload. Work sessions infer and enforce their bound Space. */
  uploadChatAttachment(input: UploadChatAttachmentInput) {
    return this.upload({
      purpose: "chat_attachment",
      spaceId: input.spaceId,
      sessionId: input.sessionId,
      file: input.file,
      mimeType: input.mimeType,
      filename: input.filename,
    });
  }

  /** Preprocessed chat image (webp/jpeg). Same durable path as uploadChatAttachment. */
  uploadChatImageAttachment(input: UploadChatImageAttachmentInput) {
    return this.uploadChatAttachment(input);
  }
}
