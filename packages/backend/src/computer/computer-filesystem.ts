import type { Context } from "@earendil-works/chord";
import { withAbortSignal } from "@earendil-works/chord/context";
import { match } from "ts-pattern";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import type { Env } from "../env";
import { openComputerExecution, resolveComputerTarget, type ComputerAgent } from "./remote-env";
import { computerPath, virtualComputerPath } from "../filesystem/filesystem-path";
import { ComputerError } from "./computer-error";
import { FilesystemError } from "../filesystem/filesystem-error";
import type {
  FilesystemLocation,
  BinaryImportSource,
  FilesystemMutation,
  FilesystemExport,
  FilesystemProvider,
  FilesystemSession,
  OpenExport,
} from "../filesystem/filesystem";
import { CONFIG } from "../shared/config";
import { transferFile } from "./file-transfer";
import { z } from "zod";
import type {
  FilesystemMethod,
  FilesystemInputs,
  FilesystemResults,
} from "../filesystem/operations";

type ComputerLocation = FilesystemLocation & { namespace: "fs" | "workspace" };

function mount(location: FilesystemLocation): {
  namespace: "fs" | "workspace";
  requestPath: string;
} {
  const namespace = "namespace" in location ? location.namespace : undefined;
  if (namespace !== "fs" && namespace !== "workspace")
    throw new FilesystemError("invalid_path", "Unknown Computer filesystem mount.");
  if (namespace === "workspace") {
    let depth = 0;
    for (const segment of location.path.split("/")) {
      if (!segment || segment === ".") continue;
      if (segment === ".." && depth-- <= 0)
        throw new FilesystemError("invalid_path", "The path escapes its virtual workspace mount.");
      if (segment !== "..") depth++;
    }
  }
  const mountedPath = match({ namespace, path: location.path })
    .with({ namespace: "fs" }, ({ path }) => path)
    .with({ namespace: "workspace", path: "/" }, () => ".")
    .with({ namespace: "workspace" }, ({ path }) => path.replace(/^\/+/, ""))
    .exhaustive();
  const requestPath =
    namespace === "workspace" && (mountedPath === "~" || mountedPath.startsWith("~/"))
      ? `./${mountedPath}`
      : mountedPath;
  return { namespace, requestPath };
}

function mountedVirtualPath(
  computer: string,
  namespace: "fs" | "workspace",
  cwd: string,
  path: string,
) {
  const workspaceRoot = cwd.replace(/\/+$/, "");
  if (namespace === "workspace") {
    const normalized = path.replace(/\/+$/, "") || "/";
    const relative = match(normalized)
      .with(workspaceRoot, () => "/")
      .when(
        (path) => path.startsWith(`${workspaceRoot}/`),
        (path) => path.slice(workspaceRoot.length),
      )
      .otherwise(() => undefined);
    if (relative !== undefined) return virtualComputerPath(computer, relative, "workspace");
  }
  return virtualComputerPath(computer, path, "fs");
}

export class ComputerFilesystem implements FilesystemProvider {
  readonly name = "computer";
  constructor(
    private readonly env: Env,
    private readonly agent: ComputerAgent,
  ) {}
  resolve(path: string): ComputerLocation | undefined {
    const parsed = computerPath(path);
    return (
      parsed && {
        provider: this.name,
        resource: parsed.computer,
        path: parsed.path,
        namespace: parsed.namespace,
      }
    );
  }
  async importBinary(location: FilesystemLocation, source: BinaryImportSource, context: Context) {
    const { namespace, requestPath } = mount(location);
    const target = await resolveComputerTarget(this.env, this.agent, {
      computer: location.resource,
    });
    const stream = await source.open(context.abortSignal);
    let received = 0;
    const content = stream.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(bytes, controller) {
          received += bytes.length;
          if (received > source.maxBytes)
            throw new FilesystemError("too_large", "The attachment exceeds the transfer limit.");
          controller.enqueue(bytes);
        },
        flush() {
          if (source.expectedSize !== undefined && received !== source.expectedSize)
            throw new FilesystemError(
              "incomplete",
              "The attachment did not contain its expected bytes.",
            );
        },
      }),
    );
    for await (const frame of transferFile(
      this.env.COMPUTERS.getByName(target.id),
      {
        id: crypto.randomUUID(),
        method: "importFile",
        params: { path: requestPath, cwd: target.cwd },
      },
      context,
      content,
    )) {
      if (frame.type === "result") {
        const receipt = z
          .object({ path: z.string(), size: z.number(), version: z.string() })
          .parse(frame.value);
        return {
          ...receipt,
          path: mountedVirtualPath(location.resource, namespace, target.cwd, receipt.path),
        };
      }
    }
    throw new FilesystemError("incomplete", "The import result is missing.");
  }

  async inspectExport(location: FilesystemLocation, context: Context): Promise<FilesystemExport> {
    const { namespace, requestPath } = mount(location);
    const target = await resolveComputerTarget(this.env, this.agent, {
      computer: location.resource,
      cwd: virtualComputerPath(location.resource, "/", namespace),
    });
    const computer = this.env.COMPUTERS.getByName(target.id);
    for await (const frame of transferFile(
      computer,
      {
        id: crypto.randomUUID(),
        method: "inspectExport",
        params: { path: requestPath, cwd: target.cwd, maxBytes: CONFIG.binaryExportMaxBytes },
      },
      context,
    )) {
      if (frame.type === "result")
        return {
          ...z
            .object({
              name: z.string(),
              size: z.number(),

              mediaType: z.string(),
            })
            .parse(frame.value),
          provider: this.name,
          locator: { id: target.id, cwd: target.cwd, path: requestPath },
        };
    }
    throw new FilesystemError("incomplete", "The file metadata is missing.");
  }

  async openExport(source: FilesystemExport, context: Context): Promise<OpenExport> {
    const { id, cwd, path } = source.locator;
    const abort = new AbortController();
    const transferContext = withAbortSignal(abort.signal, context);
    const frames = transferFile(
      this.env.COMPUTERS.getByName(id),
      {
        id: crypto.randomUUID(),
        method: "exportFile",
        params: {
          path,
          cwd,
          maxBytes: CONFIG.binaryExportMaxBytes,
        },
      },
      transferContext,
    );
    // Open the source before starting the Telegram upload.
    let next = await frames.next();
    const close = async () => {
      abort.abort();
      await frames.return();
    };
    return {
      close,
      stream: new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (next.done || next.value.type === "result") {
            controller.close();
            return;
          }
          controller.enqueue(next.value.bytes);
          next = await frames.next();
        },
        cancel: close,
      }),
    };
  }
  async using<T>(
    location: FilesystemLocation,
    _mutation: FilesystemMutation,
    _api: ToolExecutionApi,
    context: Context,
    action: (session: FilesystemSession) => Promise<T>,
  ) {
    const { namespace, requestPath } = mount(location);
    const session = await openComputerExecution(this.env, this.agent, {
      computer: location.resource,
    });
    try {
      return await action({
        env: session.env,
        toolPath: requestPath,
        request: async <M extends FilesystemMethod>(
          method: M,
          args: FilesystemInputs[M],
          ctx: Context,
        ): Promise<FilesystemResults[M]> => {
          const result = await session.env.filesystem(
            method,
            { ...args, path: requestPath, cwd: session.env.cwd },
            ctx,
          );
          if (!result.ok) throw new ComputerError(result.error.code, result.error.message);
          // The versioned Companion protocol supplies the operation-specific payload.
          return result.value as FilesystemResults[M];
        },
        virtualPath: (path) =>
          mountedVirtualPath(location.resource, namespace, session.env.cwd, path),
      });
    } finally {
      await session.close();
    }
  }
}
