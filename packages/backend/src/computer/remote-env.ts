import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import {
  FileError,
  ExecutionError,
  ok,
  err,
  type ExecutionEnv,
  type Result,
  type FileInfo,
  type BinaryReader,
  type TextLineReader,
  type DirReader,
  type FileWatcher,
  type ShellExecOptions,
  type ShellExecResult,
} from "@earendil-works/pi-durable/env";
import { createBashTool } from "@earendil-works/pi-durable/tools";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { arr, bool, obj, str, type Schema } from "@earendil-works/pi-schema";
import { CONFIG } from "../shared/config";
import { toolError } from "../shared/tool-error";
import { ComputerError } from "./computer-error";
import {
  EXPIRED_BEFORE_START,
  interruptedOperation,
  nativeFileErrorCode,
  nativeExecutionErrorCode,
  READER_SCAN_LINES,
  lineScanSchema,
  type RemoteError,
  type RemoteFrame,
  type RemoteResult,
  type RemoteRequest,
  type OutputPosition,
} from "../shared/companion";
import { directory } from "../deployment/directory";
import type { Env } from "../env";
import type { Computer } from "./computer";
import { listComputerStatus } from "./computers";
import { computerPath, virtualComputerPath } from "../filesystem/filesystem-path";
import { FilesystemError } from "../filesystem/filesystem-error";

export const BASH_TOOL_NAME = "bash";
const offlineMessage = (slug: string) =>
  `Computer ${slug} is offline. The operation did not run. Try again after the computer reconnects.`;
function fileError(error: RemoteError) {
  const { code: remoteCode, message, path } = error;
  const code = nativeFileErrorCode.safeParse(remoteCode).data ?? "unknown";
  return new FileError(code, message, path, new ComputerError(remoteCode, message));
}
const bytesFromBase64 = (text: string) => Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
const base64FromBytes = (bytes: Uint8Array) => {
  let text = "";
  for (let offset = 0; offset < bytes.length; offset += CONFIG.computerReadChunkBytes)
    text += String.fromCharCode(...bytes.subarray(offset, offset + CONFIG.computerReadChunkBytes));
  return btoa(text);
};

/** One native tool invocation; cancellation never crosses into another invocation. */
export class RemoteExecutionEnv implements ExecutionEnv {
  private readonly active = new Set<string>();
  private readonly readers = new Set<BinaryReader>();
  constructor(
    readonly id: string,
    private readonly slug: string,
    public cwd: string,
    private readonly computer: DurableObjectStub<Computer>,
    private workspace: string | undefined,
  ) {}

  private async call(
    method: string,
    params: Record<string, unknown>,
    context: Context,
    options?: ShellExecOptions,
  ): Promise<RemoteResult> {
    const aborted: RemoteError = { code: "aborted", message: "Operation aborted" };
    if (context.abortSignal?.aborted) return { ok: false, error: aborted };
    const id = crypto.randomUUID();
    const duration =
      method === READER_SCAN_LINES
        ? undefined
        : method === "exec"
          ? options?.timeout === undefined
            ? undefined
            : Math.ceil(options.timeout * 1000) + CONFIG.computerCommandResultGraceMs
          : CONFIG.computerFileDeadlineMs;
    const request: RemoteRequest = {
      id,
      method,
      params,
      workspace: this.workspace,
      ...(duration === undefined ? {} : { deadline: Date.now() + duration }),
    };
    this.workspace = undefined;
    this.active.add(id);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const cancel = () => {
      void this.computer.cancel(id, "aborted").catch(() => {});
      void reader?.cancel().catch(() => {});
    };
    context.abortSignal?.addEventListener("abort", cancel, { once: true });
    try {
      const stream = await this.computer.open(request);
      reader = stream.getReader();
      if (context.abortSignal?.aborted) cancel();
      const decoder = new TextDecoder();
      let buffer = "";
      let sequence = 0;
      let position: OutputPosition = { bytes: 0, newlines: 0, endsWithNewline: false };
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf("\n")) !== -1) {
          const frame: RemoteFrame = JSON.parse(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          if (frame.id !== id || frame.seq <= sequence) continue;
          sequence = frame.seq;
          if (frame.type === "result") return frame.result;
          const bytes = new TextEncoder().encode(frame.text);
          const endBytes = frame.before.bytes + bytes.byteLength;
          const endNewlines = frame.before.newlines + frame.text.split("\n").length - 1;
          if (endBytes < position.bytes || endNewlines < position.newlines) {
            await this.computer.cancel(id, "aborted");
            return {
              ok: false,
              error: {
                code: context.abortSignal?.aborted ? "aborted" : "unknown",
                message: `The execution output sequence from Computer ${this.slug} was interrupted before a result was confirmed.`,
              },
            };
          }
          try {
            const skipped =
              frame.before.bytes > position.bytes
                ? {
                    bytes: frame.before.bytes - position.bytes,
                    newlines: frame.before.newlines - position.newlines,
                    endsWithNewline: frame.before.endsWithNewline,
                  }
                : undefined;
            const text = new TextDecoder().decode(
              bytes.subarray(Math.max(0, position.bytes - frame.before.bytes)),
            );
            options?.onOutput?.(text, context, {
              stream: frame.stream,
              ...(skipped ? { skipped } : {}),
            });
            position = {
              bytes: endBytes,
              newlines: endNewlines,
              endsWithNewline: frame.text.endsWith("\n"),
            };
          } catch {
            await this.computer.cancel(id, "aborted");
            return {
              ok: false,
              error: {
                code: context.abortSignal?.aborted ? "aborted" : "callback_error",
                message: "Execution output consumer was interrupted.",
              },
            };
          }
        }
      }
      return {
        ok: false,
        error: context.abortSignal?.aborted ? aborted : interruptedOperation(method),
      };
    } catch {
      return {
        ok: false,
        error: context.abortSignal?.aborted ? aborted : interruptedOperation(method),
      };
    } finally {
      context.abortSignal?.removeEventListener("abort", cancel);
      this.active.delete(id);
      await reader?.cancel().catch(() => {});
    }
  }
  private async file<T>(
    method: string,
    params: Record<string, unknown>,
    context: Context,
  ): Promise<Result<T, FileError>> {
    const result = await this.call(method, params, context);
    if (result.ok) return ok(result.value as T);
    return err(fileError(result.error));
  }
  absolutePath(path: string, context: Context) {
    return this.file<string>("absolutePath", { path, cwd: this.cwd }, context);
  }
  exists(path: string, context: Context) {
    return this.file<boolean>("exists", { path }, context);
  }
  fileInfo(path: string, context: Context) {
    return this.file<FileInfo>("fileInfo", { path }, context);
  }
  async readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
    const result = await this.file<string>("readTextFile", { path, cwd: this.cwd }, context);
    return result.ok
      ? ok(new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytesFromBase64(result.value)))
      : result;
  }
  filesystem(method: string, params: Record<string, unknown>, context: Context) {
    return this.call(method, { cwd: this.cwd, ...params }, context);
  }

  async writeFile(
    path: string,
    content: string | Uint8Array,
    context: Context,
  ): Promise<Result<void, FileError>> {
    const result = await this.file<null>(
      "writeFile",
      {
        path,
        content: typeof content === "string" ? content : base64FromBytes(content),
        encoding: typeof content === "string" ? "utf8" : "base64",
      },
      context,
    );
    return result.ok ? ok(undefined) : result;
  }
  async openBinaryReader(
    path: string,
    options: { noFollow?: boolean } | undefined,
    context: Context,
  ): Promise<Result<BinaryReader, FileError>> {
    const opened = await this.file<string>("openBinaryReader", { path, ...options }, context);
    if (!opened.ok) return opened;
    const handle = opened.value;
    const reader: BinaryReader = {
      info: (context) => this.file<FileInfo>("readerInfo", { handle }, context),
      read: async (offset, length, context) => {
        const chunks: Uint8Array[] = [];
        let total = 0;
        while (total < length) {
          const size = Math.min(length - total, CONFIG.computerReadMaxBytes);
          const result = await this.file<string>(
            "readerRead",
            { handle, offset: offset + total, length: size },
            context,
          );
          if (!result.ok) return result;
          const bytes = bytesFromBase64(result.value);
          chunks.push(bytes);
          total += bytes.length;
          if (bytes.length < size) break;
        }
        const output = new Uint8Array(total);
        let cursor = 0;
        for (const chunk of chunks) {
          output.set(chunk, cursor);
          cursor += chunk.length;
        }
        return ok(output);
      },
      scanLines: async (options, context) => {
        const result = await this.call(READER_SCAN_LINES, { handle, ...options }, context);
        if (!result.ok) return err(fileError(result.error));
        const scan = lineScanSchema.safeParse(result.value);
        return scan.success
          ? ok(scan.data)
          : err(new FileError("unknown", "The Computer returned an invalid line scan result."));
      },
      close: async () => {
        this.readers.delete(reader);
        await this.file<null>("readerClose", { handle }, BG);
      },
    };
    this.readers.add(reader);
    return ok(reader);
  }
  async exec(
    command: string | readonly string[],
    options: ShellExecOptions | undefined,
    context: Context,
  ): Promise<Result<ShellExecResult, ExecutionError>> {
    const result = await this.call(
      "exec",
      {
        command,
        cwd: options?.cwd ?? this.cwd,
        env: options?.env ?? {},
        inheritEnv: options?.inheritEnv ?? true,
        ...(options?.timeout === undefined ? {} : { timeout: options.timeout }),
        ...(options?.spill ? { spill: options.spill } : {}),
        ...(options?.window ? { window: options.window } : {}),
      },
      context,
      options,
    );
    const virtualSpillPath = (path: string | undefined) =>
      path === undefined ? undefined : virtualComputerPath(this.slug, path);
    if (result.ok) {
      const value = result.value as ShellExecResult;
      return ok({ ...value, spillPath: virtualSpillPath(value.spillPath) });
    }
    const spillPath = virtualSpillPath(result.error.spillPath);
    const { code: remoteCode, message } = result.error;
    const code =
      remoteCode === "computer_offline" || remoteCode === EXPIRED_BEFORE_START
        ? "shell_unavailable"
        : (nativeExecutionErrorCode.safeParse(remoteCode).data ?? "unknown");
    const error = new ExecutionError(code, message);
    error.spillPath = spillPath;
    return err(error);
  }
  async cleanup(_context: Context) {
    await Promise.all(
      [...this.active].map((id) => this.computer.cancel(id, "aborted").catch(() => {})),
    );
    await Promise.all([...this.readers].map((reader) => reader.close(BG).catch(() => {})));
  }
  private unsupported<T>(): Promise<Result<T, FileError>> {
    return Promise.resolve(
      err(new FileError("not_supported", "This filesystem operation is not supported.")),
    );
  }
  joinPath = () => this.unsupported<string>();
  openTextLineReader = () => this.unsupported<TextLineReader>();
  readTextLines = () => this.unsupported<string[]>();
  readBinaryFile = () => this.unsupported<Uint8Array>();
  appendFile = () => this.unsupported<void>();
  truncateFile = () => this.unsupported<void>();
  flushFile = () => this.unsupported<void>();
  renameFile = () => this.unsupported<void>();
  listDir = () => this.unsupported<FileInfo[]>();
  openDirReader = () => this.unsupported<DirReader>();
  watch = () => this.unsupported<FileWatcher>();
  canonicalPath = () => this.unsupported<string>();
  createDir = () => this.unsupported<void>();
  remove = () => this.unsupported<void>();
  createTempDir = () => this.unsupported<string>();
  createTempFile = () => this.unsupported<string>();
}

type ComputerArguments = { computer: string; cwd?: string };
export type ComputerAgent = { slug(): Promise<string> };

export async function resolveComputerTarget(
  env: Env,
  agent: ComputerAgent,
  args: ComputerArguments,
) {
  const virtualCwd = args.cwd === undefined ? undefined : computerPath(args.cwd);
  if (virtualCwd && virtualCwd.computer !== args.computer)
    throw new FilesystemError("invalid_path", "The working directory belongs to another Computer.");

  const resolved = await directory(env).resolveComputer(args.computer);
  if (!resolved.ok) throw new ComputerError(resolved.error, resolved.message);

  const computer = env.COMPUTERS.getByName(resolved.computer.id);
  let cwd = virtualCwd?.path ?? args.cwd;
  let workspace: string | undefined;
  if (cwd === undefined || virtualCwd?.namespace === "workspace") {
    const status = await computer.status();
    if (!status.online) throw new ComputerError("computer_offline", offlineMessage(args.computer));
    if (!status.home.startsWith("/"))
      throw new ComputerError("computer_unavailable", `Computer ${args.computer} is unavailable.`);
    const root = `${status.home.replace(/\/+$/, "")}/${CONFIG.workspaceDirectory}/${await agent.slug()}`;
    if (cwd === undefined) workspace = root;
    cwd = virtualCwd?.namespace === "workspace" ? `${root}${virtualCwd.path}` : root;
  }

  return { id: resolved.computer.id, cwd, workspace };
}

export async function openComputerExecution(
  env: Env,
  agent: ComputerAgent,
  args: ComputerArguments,
) {
  const { id, cwd, workspace } = await resolveComputerTarget(env, agent, args);
  const computer = env.COMPUTERS.getByName(id);
  const remote = new RemoteExecutionEnv(id, args.computer, cwd, computer, workspace);
  return { env: remote, close: () => remote.cleanup(BG) };
}

export function computerTools(env: Env, agent: ComputerAgent) {
  const discover: ToolRegistration = {
    name: "computer_list",
    description: "List registered Computers with their Slugs, names, and online status.",
    replay: "safe",
    parameters: obj({}, { open: true }),
    structuredOutputSchema: obj({
      computers: arr(
        obj({
          slug: str(),
          name: str(),
          online: bool(),
        }),
      ),
    }),
    execute: async () => {
      const result = {
        computers: (await listComputerStatus(env)).map(({ slug, name, online }) => ({
          slug,
          name,
          online,
        })),
      };
      return { output: [{ type: "text", text: JSON.stringify(result) }], structuredOutput: result };
    },
  };
  const bash = createBashTool();
  const properties = bash.parameters.properties as Record<string, Schema>;
  const execute: ToolRegistration = {
    ...bash,
    name: BASH_TOOL_NAME,
    description: "Run a Bash command on a Computer.",
    parameters: {
      ...bash.parameters,
      properties: {
        ...properties,
        computer: str({
          minLength: 1,
          description: "Stable Computer Slug.",
        }),
        cwd: str({
          minLength: 1,
          description:
            "Working directory. Defaults to this Agent's Workspace on the selected Computer.",
        }),
      },
      required: [...(bash.parameters.required as readonly string[]), "computer"],
    },
    execute: async (args: unknown, api, context) => {
      const { computer, cwd, ...nativeArgs } = args as ComputerArguments & Record<string, unknown>;
      try {
        const session = await openComputerExecution(env, agent, { computer, cwd });
        try {
          return await (bash as ToolRegistration).execute(
            nativeArgs,
            { ...api, env: session.env },
            context,
          );
        } finally {
          await session.close();
        }
      } catch (error) {
        if (!(error instanceof FilesystemError || error instanceof ComputerError)) throw error;
        return toolError(error);
      }
    },
  };
  return [discover, execute];
}
