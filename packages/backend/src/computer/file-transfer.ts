import { z } from "zod";
import type { Context } from "@earendil-works/chord";
import type { Computer } from "./computer";
import { ComputerError } from "./computer-error";
import { CONFIG } from "../shared/config";
import { remoteErrorCode } from "../shared/companion";

export type FileRequest = { id: string } & (
  | {
      method: "inspectExport" | "exportFile";
      params: { path: string; cwd: string; maxBytes: number };
    }
  | { method: "importFile"; params: { path: string; cwd: string } }
);

const FILE_CHUNK_ENCODED_LIMIT = Math.ceil(CONFIG.computerReadChunkBytes / 3) * 4;

const fileFrame = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("file_chunk"),
    id: z.string(),
    content: z.string().max(FILE_CHUNK_ENCODED_LIMIT),
  }),
  z.object({
    type: z.literal("file_result"),
    id: z.string(),
    result: z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true), value: z.unknown() }),
      z.object({
        ok: z.literal(false),
        error: z.object({ code: remoteErrorCode, message: z.string() }),
      }),
    ]),
  }),
]);
const encoder = new TextEncoder();
const fileRoute = z.object({ type: z.enum(["file_chunk", "file_result"]), id: z.string() });
const rpcComputerError = z.object({
  name: z.literal("ComputerError"),
  code: remoteErrorCode,
  message: z.string(),
});

/** Content frames are transient. Pi owns the tool and the final import publication. */
export class FileTransfers {
  private readonly pending = new Map<
    string,
    {
      controller: ReadableStreamDefaultController<Uint8Array>;
      timer: ReturnType<typeof setTimeout>;
      reader?: ReadableStreamDefaultReader<Uint8Array>;
    }
  >();

  constructor(private readonly send: (frame: object) => void) {}

  async open(request: FileRequest, content?: ReadableStream<Uint8Array>) {
    const cancel = async () => {
      const pending = this.remove(request.id);
      this.send({ type: "file_cancel", id: request.id });
      await pending?.reader?.cancel().catch(() => {});
    };
    const response = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const timer = setTimeout(() => {
          void cancel().then(() => controller.error(new Error("The file transfer timed out.")));
        }, CONFIG.binaryTransferTimeoutMs);
        this.pending.set(request.id, { controller, timer });
        this.send({ type: "file_request", ...request });
      },
      cancel,
    });
    // Consume RPC input while its invocation is alive, before returning the response stream.
    if (content) {
      try {
        await this.upload(request.id, content);
      } catch {
        await response.cancel();
        throw new ComputerError(
          "unknown",
          "The file source stream was interrupted before publication.",
        );
      }
    }
    return response;
  }

  private remove(id: string) {
    const pending = this.pending.get(id);
    if (pending) {
      clearTimeout(pending.timer);
    }
    this.pending.delete(id);
    return pending;
  }

  async receive(value: unknown, raw: string) {
    const frame = fileRoute.parse(value);
    const pending = this.pending.get(frame.id);
    if (!pending) return;
    if (frame.type === "file_result") {
      this.remove(frame.id);
      await pending.reader?.cancel().catch(() => {});
    }
    pending.controller.enqueue(encoder.encode(raw + "\n"));
    if (frame.type === "file_result") pending.controller.close();
  }

  async close() {
    await Promise.all(
      [...this.pending.keys()].map(async (id) => {
        const pending = this.remove(id);
        await pending?.reader?.cancel().catch(() => {});
        pending?.controller.error(new Error("The Computer disconnected during file transfer."));
      }),
    );
  }

  private async upload(id: string, content: ReadableStream<Uint8Array>) {
    const reader = content.getReader();
    void reader.closed.catch(() => {});
    const pending = this.pending.get(id);
    if (pending) pending.reader = reader;
    let size = 0;
    try {
      while (this.pending.has(id)) {
        const chunk = await reader.read();
        if (!this.pending.has(id)) return;
        if (chunk.done) {
          this.send({ type: "file_end", id });
          return;
        }
        size += chunk.value.length;
        if (size > CONFIG.binaryImportMaxBytes)
          throw new Error("The file exceeds the transfer limit.");
        for (let offset = 0; offset < chunk.value.length; offset += CONFIG.computerReadChunkBytes) {
          const bytes = chunk.value.subarray(offset, offset + CONFIG.computerReadChunkBytes);
          this.send({ type: "file_chunk", id, content: btoa(String.fromCharCode(...bytes)) });
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}

export async function* transferFile(
  computer: DurableObjectStub<Computer>,
  request: FileRequest,
  context: Context,
  content?: ReadableStream<Uint8Array>,
) {
  context.abortSignal?.throwIfAborted();
  const stream = await computer.openFileTransfer(request, content).catch((error: unknown) => {
    const remote = rpcComputerError.safeParse(error);
    if (remote.success) throw new ComputerError(remote.data.code, remote.data.message);
    throw error;
  });
  const reader = stream.getReader();
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  context.abortSignal?.addEventListener("abort", abort, { once: true });
  if (context.abortSignal?.aborted) abort();
  let text = "";
  const decoder = new TextDecoder();
  try {
    while (true) {
      const next = await reader.read();
      context.abortSignal?.throwIfAborted();
      if (next.done)
        throw new ComputerError("unknown", "The file transfer ended without a result.");
      text += decoder.decode(next.value, { stream: true });
      let newline: number;
      while ((newline = text.indexOf("\n")) !== -1) {
        const frame = fileFrame.parse(JSON.parse(text.slice(0, newline)));
        text = text.slice(newline + 1);
        if (frame.type === "file_result") {
          if (!frame.result.ok)
            throw new ComputerError(frame.result.error.code, frame.result.error.message);
          yield { type: "result" as const, value: frame.result.value };
          return;
        }
        yield {
          type: "data" as const,
          bytes: Uint8Array.from(atob(frame.content), (char) => char.charCodeAt(0)),
        };
      }
    }
  } finally {
    context.abortSignal?.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
