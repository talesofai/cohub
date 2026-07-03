import sharp from "sharp";
import type { CohubHttpClient, PublicAssetPurpose } from "@neta-art/cohub";

const AVATAR_SIZE = 1024;
const AVATAR_QUALITY = 86;

export async function normalizeAvatarFile(path: string): Promise<Buffer> {
  return sharp(path)
    .rotate()
    .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: "cover", position: "centre" })
    .webp({ quality: AVATAR_QUALITY })
    .toBuffer();
}

export async function uploadAvatarAsset(input: {
  client: CohubHttpClient;
  purpose: PublicAssetPurpose;
  path: string;
  spaceId?: string;
}) {
  const body = await normalizeAvatarFile(input.path);
  return input.client.publicAssets.upload({
    purpose: input.purpose,
    spaceId: input.spaceId,
    file: new Blob([new Uint8Array(body)], { type: "image/webp" }),
    mimeType: "image/webp",
    filename: "avatar.webp",
  });
}

const CHAT_IMAGE_MAX_EDGE = 1984;
const CHAT_IMAGE_QUALITY = 86;

export async function normalizeChatImageFile(path: string): Promise<Buffer> {
  return sharp(path)
    .rotate()
    .resize(CHAT_IMAGE_MAX_EDGE, CHAT_IMAGE_MAX_EDGE, { fit: "inside", withoutEnlargement: true })
    .webp({ quality: CHAT_IMAGE_QUALITY })
    .toBuffer();
}

export async function uploadChatImageAsset(input: {
  client: CohubHttpClient;
  spaceId: string;
  sessionId: string;
  path: string;
}) {
  const body = await normalizeChatImageFile(input.path);
  const asset = await input.client.publicAssets.uploadChatImageAttachment({
    spaceId: input.spaceId,
    sessionId: input.sessionId,
    file: new Blob([new Uint8Array(body)], { type: "image/webp" }),
    mimeType: "image/webp",
    filename: "image.webp",
  });
  return { ...asset, size: body.byteLength };
}
