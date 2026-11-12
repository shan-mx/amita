import { ORPCError } from "@orpc/client";
import { COPY } from "./copy";

export function apiErrorMessage(error: unknown, fallback: string = COPY.requestFailed): string {
  if (
    error instanceof ORPCError &&
    (error.status < 500 || error.code === "BAD_GATEWAY" || error.code === "SERVICE_UNAVAILABLE") &&
    error.message
  )
    return error.message;
  return fallback;
}
