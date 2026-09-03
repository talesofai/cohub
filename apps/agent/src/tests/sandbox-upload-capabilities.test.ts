import assert from "node:assert/strict";
import test from "node:test";
import {
  SANDBOX_UPLOAD_UNSUPPORTED_PREFIX,
  sandboxUploadUnsupportedErrorMessage,
  supportsAtomicUpload,
} from "../sandbox-upload-capabilities.js";

const supported = {
  fsWriteSource: true,
  fsWriteExpected: true,
  fsWriteDisposition: true,
};

test("atomic uploads require all write capabilities", () => {
  assert.equal(supportsAtomicUpload(supported), true);
  assert.equal(supportsAtomicUpload({ ...supported, fsWriteSource: false }), false);
  assert.equal(supportsAtomicUpload({ ...supported, fsWriteExpected: false }), false);
  assert.equal(supportsAtomicUpload({ ...supported, fsWriteDisposition: false }), false);
  assert.equal(supportsAtomicUpload(undefined), false);
});

test("unsupported upload errors use the queue error prefix", () => {
  assert.equal(
    sandboxUploadUnsupportedErrorMessage(),
    `${SANDBOX_UPLOAD_UNSUPPORTED_PREFIX} sandbox must be upgraded before this upload can be completed`,
  );
});
