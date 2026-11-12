import { z } from "zod";
import type { FileErrorCode, ExecutionErrorCode, LineScan } from "@earendil-works/pi-durable/env";

/** Versioned transport of external effects. Pi remains the owner of Agent tasks. */
export type RemoteRequest = {
  id: string;
  method: string;
  params: Record<string, unknown>;
  workspace?: string;
  deadline?: number;
};
export type RemoteError = {
  code: RemoteErrorCode;
  message: string;
  path?: string;
  spillPath?: string;
};
export type RemoteResult = { ok: true; value: unknown } | { ok: false; error: RemoteError };
export type OutputPosition = { bytes: number; newlines: number; endsWithNewline: boolean };
export type RemoteOutput = {
  type: "output";
  id: string;
  seq: number;
  stream: "stdout" | "stderr";
  text: string;
  snapshot: true;
  before: OutputPosition;
};
export type RemoteFrame =
  | RemoteOutput
  | { type: "result"; id: string; seq: number; result: RemoteResult };
export type CancelReason = "aborted" | "timeout" | "revoked";
export const COMPANION_PROTOCOL = 1;
export const EXPIRED_BEFORE_START = "expired_before_start";
export const READER_SCAN_LINES = "readerScanLines";
const scanPosition = z.number().int().nonnegative();
export const lineScanSchema = z.object({
  newlines: scanPosition,
  start: scanPosition,
  end: scanPosition,
  firstLineEnd: scanPosition,
  lastLineStart: scanPosition,
  selectedBytes: scanPosition,
  firstLineBytes: scanPosition,
}) satisfies z.ZodType<LineScan>;
export const nativeFileErrorCode = z.enum([
  "aborted",
  "not_found",
  "permission_denied",
  "not_directory",
  "is_directory",
  "invalid",
  "not_supported",
  "unknown",
] satisfies FileErrorCode[]);

export const nativeExecutionErrorCode = z.enum([
  "aborted",
  "timeout",
  "shell_unavailable",
  "spawn_error",
  "callback_error",
  "unknown",
] satisfies ExecutionErrorCode[]);

export const remoteErrorCode = z.enum([
  ...nativeFileErrorCode.options,
  ...nativeExecutionErrorCode.options,
  EXPIRED_BEFORE_START,
  "computer_offline",
  "computer_unavailable",
  "conflict",
  "not_empty",
  "reader_expired",
  "too_large",
]);
export type RemoteErrorCode = z.infer<typeof remoteErrorCode>;

export const REMOTE_METHODS = [
  "absolutePath",
  "exists",
  "fileInfo",
  "readTextFile",
  "writeFile",
  "listDir",
  "glob",
  "grep",
  "mkdir",
  "remove",
  "openBinaryReader",
  "readerInfo",
  "readerRead",
  READER_SCAN_LINES,
  "readerClose",
  "exec",
] as const;

const FILE_MUTATIONS: ReadonlySet<string> = new Set(["writeFile", "mkdir", "remove"]);

export function interruptedOperation(method: string): RemoteError {
  if (method === "exec" || FILE_MUTATIONS.has(method)) {
    return {
      code: "unknown",
      message: "The operation ended without a confirmed result.",
    };
  }
  return { code: "computer_unavailable", message: "The remote read was interrupted." };
}
