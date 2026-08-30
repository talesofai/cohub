import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createPresignedPostObject,
  createPresignedPutObjectUrl,
  type PresignStorageConfig,
} from "./object-presign.js";

const storage: PresignStorageConfig = {
  endpoint: "https://account-id.r2.cloudflarestorage.com",
  publicEndpoint: "https://account-id.r2.cloudflarestorage.com",
  region: "auto",
  bucket: "cohub-chat-attachments",
  accessKeyId: "test-access-key",
  secretAccessKey: "test-secret-key",
  includeUnsignedPayloadQuery: true,
};

describe("object presigning", () => {
  it("signs an R2 PUT with immutable attachment headers", () => {
    const signed = createPresignedPutObjectUrl(
      storage,
      "dev/chat-attachments/user/file.txt",
      "text/plain",
      "public, max-age=31536000, immutable",
      "attachment; filename=\"file.txt\"",
    );
    const url = new URL(signed.uploadUrl);

    assert.equal(url.hostname, "cohub-chat-attachments.account-id.r2.cloudflarestorage.com");
    assert.equal(url.pathname, "/dev/chat-attachments/user/file.txt");
    assert.equal(url.searchParams.get("X-Amz-Algorithm"), "AWS4-HMAC-SHA256");
    assert.equal(url.searchParams.get("X-Amz-Content-Sha256"), "UNSIGNED-PAYLOAD");
    assert.match(url.searchParams.get("X-Amz-SignedHeaders") ?? "", /content-disposition/);
    assert.deepEqual(signed.headers, {
      "content-type": "text/plain",
      "cache-control": "public, max-age=31536000, immutable",
      "content-disposition": "attachment; filename=\"file.txt\"",
    });
  });

  it("signs exact PUT length and OSS create-only conditions when requested", () => {
    const signed = createPresignedPutObjectUrl(
      storage,
      "dev/p/space/file.html",
      "text/html",
      "public, max-age=300",
      null,
      { contentLength: 42, forbidOverwrite: true },
    );
    const url = new URL(signed.uploadUrl);

    assert.match(url.searchParams.get("X-Amz-SignedHeaders") ?? "", /content-length/);
    assert.match(url.searchParams.get("X-Amz-SignedHeaders") ?? "", /x-oss-forbid-overwrite/);
    assert.deepEqual(signed.headers, {
      "content-type": "text/html",
      "cache-control": "public, max-age=300",
      "content-length": "42",
      "x-oss-forbid-overwrite": "true",
    });
  });

  it("signs a content checksum for local-agent objects", () => {
    const checksum = Buffer.alloc(32, 7).toString("base64");
    const signed = createPresignedPutObjectUrl(
      storage,
      "local-agent/blob/space/hash",
      "application/octet-stream",
      "private, max-age=0",
      null,
      { contentLength: 12, checksumSha256Base64: checksum },
    );
    const url = new URL(signed.uploadUrl);

    assert.match(url.searchParams.get("X-Amz-SignedHeaders") ?? "", /x-amz-checksum-sha256/);
    assert.equal(signed.headers?.["x-amz-checksum-sha256"], checksum);
  });

  it("keeps the legacy POST policy signer available for avatars and old clients", () => {
    const signed = createPresignedPostObject({
      storage,
      objectKey: "users/user/avatar.webp",
      contentType: "image/webp",
      maxBytes: 2 * 1024 * 1024,
    });

    assert.equal(new URL(signed.uploadUrl).hostname, "cohub-chat-attachments.account-id.r2.cloudflarestorage.com");
    assert.equal(signed.fields.key, "users/user/avatar.webp");
    assert.equal(signed.fields["Content-Type"], "image/webp");
    assert.ok(signed.fields.policy);
  });
});
