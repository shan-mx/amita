import { Workspace } from "@cloudflare/computer";
import type { Context } from "@earendil-works/chord";
import {
  FileError,
  LineScanner,
  err,
  ok,
  type FileErrorCode,
  type FileKind,
} from "@earendil-works/pi-durable/env";
import { nativeFileErrorCode } from "../shared/companion";
import { CONFIG, COPY } from "../shared/config";
import { readSkillMetadata, type SkillMetadata } from "../skills/skill-index";
import { FilesystemError } from "./filesystem-error";
import type {
  FilesystemLocation,
  FilesystemMutation,
  FilesystemProvider,
  FilesystemSession,
  FilesystemToolEnv,
} from "./filesystem";
import type { FilesystemInputs, FilesystemMethod, FilesystemResults } from "./operations";

const INTERNAL_ROOT = "/internal";
export const PERSONA_PATH = `${INTERNAL_ROOT}/PERSONA.md`;
export const MEMORY_PATH = `${INTERNAL_ROOT}/MEMORY.md`;
const WORKSPACE_ROOT = "/workspace";
const DEFAULT_LIMIT = 100;
const DEFAULT_GREP_CONTEXT = 2;
const textDecoder = new TextDecoder(undefined, { ignoreBOM: true });

const errorCodes: Record<string, FileErrorCode> = {
  ENOENT: "not_found",
  ENOTDIR: "not_directory",
  EISDIR: "is_directory",
  EACCES: "permission_denied",
  EPERM: "permission_denied",
  EINVAL: "invalid",
  ENOTEMPTY: "invalid",
  EEXIST: "invalid",
};

function workspacePath(path: string) {
  if (path !== INTERNAL_ROOT && !path.startsWith(`${INTERNAL_ROOT}/`)) return;
  const parts: string[] = [];
  for (const part of path.slice(INTERNAL_ROOT.length).split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) throw new FilesystemError("invalid_path", "The path escapes /internal.");
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.length ? `${WORKSPACE_ROOT}/${parts.join("/")}` : WORKSPACE_ROOT;
}

const personaFile = workspacePath(PERSONA_PATH)!;
const memoryFile = workspacePath(MEMORY_PATH)!;
const skillsDirectory = workspacePath(`${INTERNAL_ROOT}/skills`)!;

function virtualPath(path: string) {
  return `${INTERNAL_ROOT}${path.slice(WORKSPACE_ROOT.length)}`;
}

function workspaceError(error: unknown) {
  if (error instanceof FilesystemError) return error;
  const code =
    error instanceof Error && "code" in error ? errorCodes[String(error.code)] : undefined;
  let message = error instanceof Error ? error.message : String(error);
  const path =
    error instanceof Error && "path" in error && typeof error.path === "string"
      ? error.path
      : undefined;
  if (
    path &&
    (path === WORKSPACE_ROOT || path.startsWith(`${WORKSPACE_ROOT}/`)) &&
    message.endsWith(path)
  )
    message = message.slice(0, -path.length) + virtualPath(path);
  return new FilesystemError(
    code ?? (error instanceof SyntaxError ? "invalid" : "unknown"),
    message,
  );
}

async function nativeResult<T>(path: string, operation: () => Promise<T>) {
  try {
    return ok<T, FileError>(await operation());
  } catch (error) {
    const failure = workspaceError(error);
    return err<T, FileError>(
      new FileError(
        failure.code === "invalid_path"
          ? "invalid"
          : (nativeFileErrorCode.safeParse(failure.code).data ?? "unknown"),
        failure.message,
        virtualPath(path),
        failure,
      ),
    );
  }
}

function checkActive(context: Context) {
  if (context.abortSignal?.aborted) throw new FilesystemError("aborted", "Operation aborted.");
}

function fileKind(info: { isDirectory: boolean; isSymbolicLink: boolean }): FileKind {
  return info.isDirectory ? "directory" : info.isSymbolicLink ? "symlink" : "file";
}

export class InternalFilesystem implements FilesystemProvider {
  readonly name = "internal";
  private readonly fs: Workspace["fs"];
  private readonly ready: Promise<void>;
  private pendingMutation: Promise<unknown> = Promise.resolve();

  constructor(
    storage: DurableObjectStorage,
    private readonly id: string,
  ) {
    this.fs = new Workspace({ storage }).fs;
    this.ready = this.fs.mkdir(WORKSPACE_ROOT, { recursive: true });
  }

  resolve(path: string): FilesystemLocation | undefined {
    const localPath = workspacePath(path);
    if (!localPath) return;
    return { provider: this.name, resource: this.id, path: virtualPath(localPath) };
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.pendingMutation.then(operation, operation);
    this.pendingMutation = next;
    return next;
  }

  private async bytes(path: string) {
    return new Uint8Array(await new Response(await this.fs.readFile(path)).arrayBuffer());
  }

  private async exists(path: string) {
    try {
      await this.fs.lstat(path);
      return true;
    } catch (error) {
      const failure = workspaceError(error);
      if (failure.code === "not_found") return false;
      throw failure;
    }
  }

  private async digest(bytes: Uint8Array<ArrayBuffer>) {
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    return `sha256:${Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  }

  async readText(path: string) {
    await this.ready;
    return textDecoder.decode(await this.bytes(workspacePath(path)!));
  }

  private async readSkills() {
    await this.ready;
    const files = await this.fs.find(skillsDirectory, "*/**/SKILL.md").catch((error: unknown) => {
      const failure = workspaceError(error);
      if (failure.code === "not_found" || failure.code === "not_directory") return [];
      throw failure;
    });
    const skills: SkillMetadata[] = [];
    for (const { path, type } of files) {
      if (type !== "file") continue;
      const content = await this.fs.readFile(path, "utf8");
      const skill = readSkillMetadata(content, virtualPath(path));
      if (skill) skills.push(skill);
    }
    return skills;
  }

  readContextFiles() {
    return this.serialize(async () => {
      const [persona, memory, skills] = await Promise.all([
        this.readText(PERSONA_PATH),
        this.readText(MEMORY_PATH),
        this.readSkills(),
      ]);
      return { persona, memory, skills };
    });
  }

  async readVersionedText(path: string) {
    await this.ready;
    const bytes = await this.bytes(workspacePath(path)!);
    return {
      content: textDecoder.decode(bytes),
      version: await this.digest(bytes),
    };
  }

  async writeText(path: string, content: string, expectedVersion?: string) {
    await this.ready;
    return this.serialize(() => this.writeFile(workspacePath(path)!, content, expectedVersion));
  }

  private async fileInfo(path: string) {
    const info = await this.fs.stat(path);
    const projected = virtualPath(path);
    return {
      path,
      name: projected.slice(projected.lastIndexOf("/") + 1),
      kind: fileKind(info),
      size: info.size,
      mtimeMs: info.mtime,
    };
  }

  private async writeFile(path: string, content: string | Uint8Array, expectedVersion?: string) {
    if (typeof content === "string") {
      if (path === personaFile && content.length > CONFIG.personaMaxLength)
        throw new FilesystemError("invalid", COPY.personaTooLong);
      if (path === memoryFile && Array.from(content).length > CONFIG.memoryCodePointLimit)
        throw new FilesystemError("invalid", COPY.memoryTooLong);
    }
    if (expectedVersion !== undefined) {
      if (!/^sha256:[0-9a-fA-F]{64}$/.test(expectedVersion))
        throw new FilesystemError("invalid", "expectedVersion must be sha256:<hex>");
      if (!(await this.exists(path)))
        throw new FilesystemError("conflict", "file no longer exists");
      if ((await this.digest(await this.bytes(path))) !== expectedVersion)
        throw new FilesystemError("conflict", "file version does not match");
    }
    const parent = path.slice(0, path.lastIndexOf("/"));
    if (parent.startsWith(`${WORKSPACE_ROOT}/`)) await this.fs.mkdir(parent, { recursive: true });
    await this.fs.writeFile(path, content);
  }

  private toolEnv(): FilesystemToolEnv {
    return {
      id: this.id,
      cwd: WORKSPACE_ROOT,
      absolutePath: async (path) => ok(workspacePath(path) ?? path),
      canonicalPath: async (path) => ok(path),
      exists: (path) => nativeResult(path, () => this.exists(path)),
      fileInfo: (path) => nativeResult(path, () => this.fileInfo(path)),
      readTextFile: (path) =>
        nativeResult(path, async () => textDecoder.decode(await this.bytes(path))),
      writeFile: (path, content) => nativeResult(path, () => this.writeFile(path, content)),
      openBinaryReader: (path) =>
        nativeResult(path, async () => {
          const info = await this.fileInfo(path);
          const bytes = await this.bytes(path);
          return {
            info: async () => ok({ ...info, size: bytes.byteLength }),
            read: async (offset, length) => ok(bytes.subarray(offset, offset + length)),
            scanLines: async ({ startLine, endLine }) => {
              const scanner = new LineScanner(startLine, endLine);
              scanner.push(bytes);
              return ok(scanner.finish());
            },
            close: async () => {},
          };
        }),
    };
  }

  private operations(path: string): {
    [M in FilesystemMethod]: (args: FilesystemInputs[M]) => Promise<FilesystemResults[M]>;
  } {
    return {
      listDir: async ({ limit = DEFAULT_LIMIT, cursor = "" }) => {
        const entries = (await this.fs.readdir(path))
          .filter(({ name }) => name > cursor)
          .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
          .slice(0, limit + 1)
          .map((entry) => ({
            name: entry.name,
            path: `${path}/${entry.name}`,
            kind: fileKind(entry),
            size: entry.size,
            mtimeMs: entry.mtime,
          }));
        const page = entries.slice(0, limit);
        return {
          entries: page,
          ...(entries.length > limit ? { nextCursor: page.at(-1)!.name } : {}),
        };
      },
      glob: async ({ pattern, limit = DEFAULT_LIMIT }) => {
        const matches = await this.fs.find(path, pattern, { limit: limit + 1 });
        return {
          paths: matches.slice(0, limit).map((entry) => entry.path),
          truncated: matches.length > limit,
        };
      },
      grep: async ({
        pattern,
        literal,
        caseSensitive,
        include,
        context,
        limit = DEFAULT_LIMIT,
      }) => {
        const matches = await this.fs.grep(pattern, path, {
          regex: !literal,
          ignoreCase: caseSensitive === false,
          include,
          context: context ?? DEFAULT_GREP_CONTEXT,
          limit: limit + 1,
        });
        return {
          matches: matches.slice(0, limit).map(({ path, line, text, context = [] }) => ({
            path,
            line,
            text,
            before: context.filter((entry) => entry.line < line).map((entry) => entry.text),
            after: context.filter((entry) => entry.line > line).map((entry) => entry.text),
          })),
          truncated: matches.length > limit,
        };
      },
      mkdir: async ({ recursive }) => {
        await this.fs.mkdir(path, { recursive });
        return null;
      },
      remove: async ({ recursive }) => {
        if (path === WORKSPACE_ROOT)
          throw new FilesystemError("invalid", `Cannot remove ${virtualPath(path)}.`);
        if (path === personaFile || path === memoryFile)
          throw new FilesystemError(
            "invalid",
            `Cannot remove ${virtualPath(path)} because it is reserved. To clear it, use fs_write with empty content.`,
          );
        await this.fs.rm(path, { recursive });
        return null;
      },
    };
  }

  async using<T>(
    location: FilesystemLocation,
    mutation: FilesystemMutation,
    _api: unknown,
    context: Context,
    action: (session: FilesystemSession) => Promise<T>,
  ) {
    const path = workspacePath(location.path)!;
    const operation = async () => {
      await this.ready;
      checkActive(context);
      const handlers = this.operations(path);
      return action({
        env: this.toolEnv(),
        toolPath: location.path,
        virtualPath,
        request: async (method, args, requestContext) => {
          checkActive(requestContext);
          try {
            return await handlers[method](args);
          } catch (error) {
            throw workspaceError(error);
          }
        },
      });
    };
    return mutation.writes ? this.serialize(operation) : operation();
  }
}
