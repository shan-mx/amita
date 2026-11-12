import type { RemoteErrorCode } from "../shared/companion";

type ComputerSelectionErrorCode =
  | "invalid_computer"
  | "not_found"
  | "revoked"
  | "computer_offline"
  | "computer_unavailable";

export class ComputerError extends Error {
  constructor(
    readonly code: ComputerSelectionErrorCode | RemoteErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ComputerError";
  }
}
