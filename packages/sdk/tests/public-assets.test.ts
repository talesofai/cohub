import assert from "node:assert/strict";
import { it } from "node:test";
import { PublicAssetsApi, type CreatePublicAssetUploadResponse } from "../src/apis/public-assets.js";
import type { HttpTransport } from "../src/transport.js";

it("negotiates PUT uploads for chat attachments and avatars", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const responses: CreatePublicAssetUploadResponse[] = [
    {
      expiresAt: "2026-01-01T00:00:00.000Z",
      asset: {
        purpose: "chat_attachment",
        objectKey: "chat-attachments/user/file.txt",
        publicUrl: "https://uploads.example.com/chat-attachments/user/file.txt",
        uploadMethod: "PUT",
        uploadUrl: "https://bucket.account.r2.cloudflarestorage.com/chat-attachments/user/file.txt",
        uploadHeaders: { "content-type": "text/plain" },
      },
    },
    {
      expiresAt: "2026-01-01T00:00:00.000Z",
      asset: {
        purpose: "user_avatar",
        objectKey: "avatars/users/user/avatar-id.webp",
        publicUrl: "https://uploads.example.com/avatars/users/user/avatar-id.webp",
        uploadMethod: "PUT",
        uploadUrl: "https://bucket.example.com/avatars/users/user/avatar-id.webp",
        uploadHeaders: { "content-type": "image/webp" },
      },
    },
  ];
  const transport = {
    request: async (_path: string, init: RequestInit) => {
      requests.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return responses.shift();
    },
  } as unknown as HttpTransport;
  const uploads: RequestInit[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    uploads.push(init ?? {});
    return new Response(null, { status: 200 });
  }) as typeof fetch;

  try {
    const api = new PublicAssetsApi(transport);
    const chatFile = new Blob(["hello"], { type: "text/plain" });
    await api.uploadChatAttachment({ file: chatFile, mimeType: "text/plain", filename: "file.txt" });
    await api.upload({
      purpose: "user_avatar",
      file: new Blob(["avatar"], { type: "image/webp" }),
      mimeType: "image/webp",
      filename: "avatar.webp",
    });

    assert.equal(requests[0]?.uploadProtocol, "presigned_put_v1");
    assert.equal(requests[1]?.uploadProtocol, "presigned_put_v1");
    assert.equal(uploads[0]?.method, "PUT");
    assert.equal(uploads[0]?.body, chatFile);
    assert.deepEqual(uploads[0]?.headers, { "content-type": "text/plain" });
    assert.equal(uploads[1]?.method, "PUT");
    assert.equal(uploads[1]?.body instanceof Blob, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

it("reports browser upload progress without changing the fetch fallback", async () => {
  const transport = {
    request: async () => ({
      expiresAt: "2026-01-01T00:00:00.000Z",
      asset: {
        purpose: "chat_attachment" as const,
        objectKey: "chat-attachments/user/file.txt",
        publicUrl: "https://uploads.example.com/chat-attachments/user/file.txt",
        uploadMethod: "PUT" as const,
        uploadUrl: "https://bucket.example.com/chat-attachments/user/file.txt",
        uploadHeaders: { "content-type": "text/plain" },
      },
    }),
  } as unknown as HttpTransport;
  const progress: Array<{ loadedBytes: number; totalBytes: number; ratio: number }> = [];
  const originalXhr = globalThis.XMLHttpRequest;

  class FakeXMLHttpRequest {
    status = 0;
    responseText = "";
    upload = { onprogress: null } as XMLHttpRequestUpload;
    onload: ((event: ProgressEvent) => void) | null = null;
    onerror: ((event: ProgressEvent) => void) | null = null;
    onabort: ((event: ProgressEvent) => void) | null = null;

    open() {}
    setRequestHeader() {}
    abort() {
      this.onabort?.({} as ProgressEvent);
    }
    send() {
      queueMicrotask(() => {
        this.upload.onprogress?.({
          lengthComputable: true,
          loaded: 1,
          total: 4,
        } as ProgressEvent);
        this.status = 204;
        this.onload?.({} as ProgressEvent);
      });
    }
  }

  globalThis.XMLHttpRequest = FakeXMLHttpRequest as unknown as typeof XMLHttpRequest;
  try {
    const api = new PublicAssetsApi(transport);
    await api.uploadChatAttachment({
      file: new Blob(["test"], { type: "text/plain" }),
      mimeType: "text/plain",
      filename: "file.txt",
      onProgress: (event) => progress.push(event),
    });

    assert.deepEqual(progress, [
      { loadedBytes: 1, totalBytes: 4, ratio: 0.25 },
      { loadedBytes: 4, totalBytes: 4, ratio: 1 },
    ]);
  } finally {
    globalThis.XMLHttpRequest = originalXhr;
  }
});

it("does not create an upload plan for an already-aborted request", async () => {
  let requestCount = 0;
  const transport = {
    request: async () => {
      requestCount += 1;
      throw new Error("unexpected request");
    },
  } as unknown as HttpTransport;
  const controller = new AbortController();
  controller.abort();

  const api = new PublicAssetsApi(transport);
  await assert.rejects(
    api.uploadChatAttachment({
      file: new Blob(["test"], { type: "text/plain" }),
      mimeType: "text/plain",
      filename: "file.txt",
      signal: controller.signal,
    }),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
  assert.equal(requestCount, 0);
});

it("forwards abort signals to upload plan requests", async () => {
  const controller = new AbortController();
  let requestSignal: AbortSignal | null | undefined;
  const transport = {
    request: async (_path: string, init: RequestInit) => {
      requestSignal = init.signal;
      return {
        expiresAt: "2026-01-01T00:00:00.000Z",
        asset: {
          purpose: "chat_attachment" as const,
          objectKey: "chat-attachments/user/file.txt",
          publicUrl: "https://uploads.example.com/chat-attachments/user/file.txt",
          uploadMethod: "PUT" as const,
          uploadUrl: "https://bucket.example.com/chat-attachments/user/file.txt",
        },
      };
    },
  } as unknown as HttpTransport;

  const api = new PublicAssetsApi(transport);
  await api.createUpload({
    purpose: "chat_attachment",
    uploadProtocol: "presigned_put_v1",
    file: { size: 4, mimeType: "text/plain", filename: "file.txt" },
  }, { signal: controller.signal });

  assert.equal(requestSignal, controller.signal);
});
