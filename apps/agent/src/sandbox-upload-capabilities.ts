import type { SandboxCapabilities } from "@cohub/protocol/sandbox";

export const SANDBOX_UPLOAD_UNSUPPORTED_PREFIX = "sandbox_unsupported:";
export const SANDBOX_UPLOAD_UNSUPPORTED_MESSAGE =
  "sandbox must be upgraded before this upload can be completed";

type AtomicUploadCapabilities = Pick<
  SandboxCapabilities,
  "fsWriteSource" | "fsWriteExpected" | "fsWriteDisposition"
>;

export function supportsAtomicUpload(capabilities: AtomicUploadCapabilities | undefined) {
  return capabilities?.fsWriteSource === true &&
    capabilities.fsWriteExpected === true &&
    capabilities.fsWriteDisposition === true;
}

export function sandboxUploadUnsupportedErrorMessage() {
  return `${SANDBOX_UPLOAD_UNSUPPORTED_PREFIX} ${SANDBOX_UPLOAD_UNSUPPORTED_MESSAGE}`;
}
