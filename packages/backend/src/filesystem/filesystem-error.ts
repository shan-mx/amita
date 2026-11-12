import type { FileErrorCode } from "@earendil-works/pi-durable/env";

export class FilesystemError extends Error {
  constructor(
    readonly code:
      | FileErrorCode
      | "invalid_path"
      | "conflict"
      | "incomplete"
      | "too_large"
      | "unavailable",
    message: string,
  ) {
    super(message);
    this.name = "FilesystemError";
  }
}
