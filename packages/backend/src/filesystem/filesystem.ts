import type { Context } from "@earendil-works/chord";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { FilesystemError } from "./filesystem-error";
import type { FilesystemMethod, FilesystemInputs, FilesystemResults } from "./operations";

export type FilesystemArguments = {
  path: string;
};
export type FilesystemLocation = {
  provider: string;
  resource: string;
  path: string;
};
export type FilesystemToolEnv = Pick<
  ExecutionEnv,
  | "id"
  | "cwd"
  | "absolutePath"
  | "canonicalPath"
  | "exists"
  | "fileInfo"
  | "openBinaryReader"
  | "readTextFile"
  | "writeFile"
>;
export type FilesystemMutation = {
  writes: boolean;
};
export type FilesystemSession = {
  env: FilesystemToolEnv;
  /** Path spelling passed to the native Pi tool after resolving the virtual mount. */
  toolPath: string;
  request<M extends FilesystemMethod>(
    method: M,
    args: FilesystemInputs[M],
    context: Context,
  ): Promise<FilesystemResults[M]>;
  virtualPath(path: string): string;
};

export type BinaryImportSource = {
  open(signal?: AbortSignal): Promise<ReadableStream<Uint8Array>>;
  maxBytes: number;
  expectedSize?: number;
};
export type ImportReceipt = { path: string; size: number; version: string };
export type ExportInfo = { name: string; size: number; mediaType: string };
export type FilesystemExport = ExportInfo & {
  provider: string;
  locator: Record<string, string>;
};
export type OpenExport = { stream: ReadableStream<Uint8Array>; close(): Promise<void> };

/** Storage-specific I/O stays here; native tools and their Task ownership stay shared. */
export interface FilesystemProvider {
  readonly name: string;
  resolve(path: string): FilesystemLocation | undefined | Promise<FilesystemLocation | undefined>;
  importBinary?(
    location: FilesystemLocation,
    source: BinaryImportSource,
    context: Context,
  ): Promise<ImportReceipt>;
  inspectExport?(location: FilesystemLocation, context: Context): Promise<FilesystemExport>;
  openExport?(source: FilesystemExport, context: Context): Promise<OpenExport>;
  using<T>(
    location: FilesystemLocation,
    mutation: FilesystemMutation,
    api: ToolExecutionApi,
    context: Context,
    action: (session: FilesystemSession) => Promise<T>,
  ): Promise<T>;
}

export class FilesystemRouter {
  constructor(private readonly providers: readonly FilesystemProvider[]) {}

  private async resolve(path: string) {
    if (!path || path.includes("\0"))
      throw new FilesystemError("invalid_path", "A nonempty path without NUL is required.");
    const location = (
      await Promise.all(this.providers.map(async (provider) => provider.resolve(path)))
    ).find(Boolean);
    if (!location)
      throw new FilesystemError("invalid_path", "Use a complete virtual filesystem path.");
    return location;
  }

  async importBinary(path: string, source: BinaryImportSource, context: Context) {
    const location = await this.resolve(path);
    const provider = this.providers.find(({ name }) => name === location.provider);
    if (!provider?.importBinary)
      throw new FilesystemError("not_supported", "This filesystem cannot import binary files.");
    return provider.importBinary(location, source, context);
  }

  async inspectExport(path: string, context: Context) {
    const location = await this.resolve(path);
    const provider = this.providers.find(({ name }) => name === location.provider);
    if (!provider?.inspectExport)
      throw new FilesystemError("not_supported", "This filesystem does not export files.");
    return provider.inspectExport(location, context);
  }

  openExport(source: FilesystemExport, context: Context) {
    const provider = this.providers.find(({ name }) => name === source.provider);
    if (!provider?.openExport)
      throw new FilesystemError("not_supported", "This filesystem does not export files.");
    return provider.openExport(source, context);
  }

  async using<T>(
    args: FilesystemArguments,
    api: ToolExecutionApi,
    context: Context,
    mode: "read" | "write" | "edit",
    action: (session: FilesystemSession, path: string) => Promise<T>,
  ) {
    if (!args.path || args.path.includes("\0"))
      throw new FilesystemError("invalid_path", "A nonempty path without NUL is required.");
    let location = await api.memo<FilesystemLocation>("amita.filesystem.path", context);
    if (!location) {
      // Future explicit mount aliases resolve here, before the resource is durably bound.
      location = await this.resolve(args.path);
      location = await api.memo("amita.filesystem.path", location, context);
    }
    const bound = location;
    const provider = this.providers.find((provider) => provider.name === bound.provider);
    if (!provider)
      throw new FilesystemError(
        "not_supported",
        `Filesystem provider ${bound.provider} is not installed.`,
      );
    return provider.using(
      bound,
      {
        writes: mode !== "read",
      },
      api,
      context,
      (session) => action(session, bound.path),
    );
  }
}
