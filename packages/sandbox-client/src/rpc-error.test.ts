import assert from "node:assert/strict";
import test from "node:test";
import {
  SANDBOX_CONNECTION_LOST_MESSAGE,
  SandboxRpcError,
  getSandboxRpcFailurePresentation,
} from "./rpc-error.js";

test("business RPC errors are not classified from file content", () => {
  const error = new SandboxRpcError(
    "oldText failed; current line says connection closed",
    {
      method: "fs.edit",
      rpcErrorCode: "EDIT_NOT_FOUND",
      retryable: false,
      transportReason: "oldText failed; current line says connection closed",
    },
  );

  assert.deepEqual(getSandboxRpcFailurePresentation(error), {
    kind: "rpc_error",
    message: error.message,
    infrastructure: false,
  });
});

test("structured IO errors retain connection-lost presentation", () => {
  const error = new SandboxRpcError(SANDBOX_CONNECTION_LOST_MESSAGE, {
    method: "fs.edit",
    rpcErrorCode: "IO_ERROR",
    retryable: false,
    transportReason: "connection replaced",
  });

  assert.deepEqual(getSandboxRpcFailurePresentation(error), {
    kind: "connection_lost",
    message: SANDBOX_CONNECTION_LOST_MESSAGE,
    infrastructure: true,
  });
});
