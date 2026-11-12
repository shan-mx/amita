import { Buffer } from "node:buffer";

// Keep the full route digest as the key for persisted Pi references.
export function publicDestinationId(key: string) {
  return Buffer.from(key, "hex").subarray(0, 16).toString("base64url");
}
