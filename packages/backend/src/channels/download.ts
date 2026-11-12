import { num, obj, str } from "@earendil-works/pi-schema";
import { defineTool } from "@earendil-works/pi-durable";
import { withAbortSignal } from "@earendil-works/chord/context";
import { ComputerError } from "../computer/computer-error";
import { FilesystemError } from "../filesystem/filesystem-error";
import { virtualComputerPath } from "../filesystem/filesystem-path";
import type { FilesystemRouter } from "../filesystem/filesystem";
import { CONFIG } from "../shared/config";
import { ChannelError, type ChannelEndpoint } from "./adapter";
import { AttachmentRef } from "./attachments";

const UNAVAILABLE = "This attachment is no longer available. Ask the sender to upload it again.";

function safeFileName(name: string) {
  const leaf = Array.from(name.split(/[/\\]/).at(-1) ?? "")
    .filter((char) => char.charCodeAt(0) >= 0x20 && char.charCodeAt(0) !== 0x7f)
    .join("")
    .trim();
  return !leaf || leaf === "." || leaf === ".." ? "attachment" : leaf;
}

export function downloadTool(
  filesystem: FilesystemRouter,
  connection: (id: string) => Promise<ChannelEndpoint | undefined>,
) {
  return defineTool({
    name: "channel_download",
    description:
      "Download an attachment from the current Session to a registered Computer. Existing files are not overwritten.",
    replay: "unsafe",
    parameters: obj({
      attachmentId: str({ format: "uuid", description: "Attachment ID from the Session message." }),
      computer: str({ minLength: 1, description: "Slug of the destination Computer." }),
    }),
    structuredOutputSchema: obj({
      path: str(),
      size: num(),
      version: str(),
    }),
    execute: async ({ attachmentId, computer }, api, context) => {
      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(), CONFIG.binaryTransferTimeoutMs);
      try {
        const attachment = (await api.snapshot(AttachmentRef, attachmentId, context))?.value;
        if (!attachment || attachment.conversationId !== api.conversationId)
          throw new FilesystemError("not_found", UNAVAILABLE);
        const target = virtualComputerPath(
          computer,
          `attachments/${attachmentId}/${safeFileName(attachment.name)}`,
          "workspace",
        );
        const endpoint = await connection(attachment.connectionId);
        const download = endpoint?.attachmentDownload;
        if (endpoint?.status !== "connected" || !download)
          throw new FilesystemError("unavailable", UNAVAILABLE);
        const maxBytes = Math.min(download.maxBytes, CONFIG.binaryImportMaxBytes);
        if (attachment.size !== undefined && attachment.size > maxBytes)
          throw new FilesystemError(
            "too_large",
            `${attachment.name} exceeds the ${maxBytes} byte limit for this transfer.`,
          );
        const receipt = await filesystem.importBinary(
          target,
          {
            expectedSize: attachment.size,
            open: (signal) => download.open(attachment.locator, signal),
            maxBytes,
          },
          withAbortSignal(deadline.signal, context),
        );
        return {
          output: [{ type: "text", text: JSON.stringify(receipt) }],
          structuredOutput: receipt,
        };
      } catch (error) {
        context.abortSignal?.throwIfAborted();
        let code = "unavailable";
        let message = UNAVAILABLE;
        if (deadline.signal.aborted) {
          code = "timeout";
          message = "The attachment download timed out.";
        } else if (error instanceof FilesystemError || error instanceof ComputerError) {
          code = error.code;
          message = error.message;
        } else if (error instanceof ChannelError) message = error.message;
        return {
          output: [],
          isError: true,
          diagnostics: [{ severity: "error" as const, code, message: `[${code}] ${message}` }],
        };
      } finally {
        clearTimeout(timer);
      }
    },
  });
}
