import type { AutomationError } from "../automations/automation-rules";
import type { ComputerError } from "../computer/computer-error";
import type { FilesystemError } from "../filesystem/filesystem-error";

export type ToolErrorCode =
  | AutomationError["code"]
  | ComputerError["code"]
  | FilesystemError["code"];

type Failure = { code: ToolErrorCode; message: string };

export function toolDiagnostic({ code, message }: Failure) {
  return {
    severity: "error" as const,
    code,
    message,
  };
}

export function toolError(failure: Failure) {
  return { isError: true, output: [], diagnostics: [toolDiagnostic(failure)] };
}
