import { arr, bool, int, nul, num, obj, opt, str, type Schema } from "@earendil-works/pi-schema";
import { match, P } from "ts-pattern";
import type { FilesystemInputs, FilesystemResult } from "./operations";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { createReadTool, createWriteTool, createEditTool } from "@earendil-works/pi-durable/tools";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { toolError } from "../shared/tool-error";
import { ComputerError } from "../computer/computer-error";
import { FilesystemError } from "./filesystem-error";
import type { FilesystemArguments, FilesystemRouter, FilesystemSession } from "./filesystem";

export const FS_READ_TOOL_NAME = "fs_read";

const LIST_MAX = 1000;
const GREP_MAX = 500;
const CONTEXT_MAX = 5;
const pathParameters = {
  path: str({
    minLength: 1,
    description:
      "Complete virtual path, such as /internal/notes.md, /computers/<computer-slug>/fs/<absolute-host-path>, or /computers/<computer-slug>/workspace/<path>.",
  }),
};
const fileInfo = obj({
  name: str(),
  path: str(),
  kind: str(),
  size: num(),
  mtimeMs: num(),
});

function failed(error: unknown) {
  if (!(error instanceof FilesystemError || error instanceof ComputerError)) throw error;
  const { code, message } = error;
  return { ...toolError(error), details: { error: { code, message } } };
}

function virtualResult(value: FilesystemResult, session: FilesystemSession): FilesystemResult {
  return match(value)
    .with(null, () => null)
    .with({ entries: P.array(P._) }, (value) => ({
      ...value,
      entries: value.entries.map((entry) => ({ ...entry, path: session.virtualPath(entry.path) })),
    }))
    .with({ paths: P.array(P._) }, (value) => ({
      ...value,
      paths: value.paths.map((path) => session.virtualPath(path)),
    }))
    .with({ matches: P.array(P._) }, (value) => ({
      ...value,
      matches: value.matches.map((entry) => ({ ...entry, path: session.virtualPath(entry.path) })),
    }))
    .exhaustive();
}

export function filesystemTools(router: FilesystemRouter): ToolRegistration[] {
  const native = [
    { name: FS_READ_TOOL_NAME, tool: createReadTool() },
    { name: "fs_write", tool: createWriteTool() },
    { name: "fs_edit", tool: createEditTool() },
  ].map(({ name, tool }): ToolRegistration => ({
    ...tool,
    name,
    parameters: {
      ...tool.parameters,
      properties: {
        ...(tool.parameters.properties as Record<string, Schema>),
        ...pathParameters,
      },
    },
    execute: async (args, api, context) => {
      try {
        return await router.using(
          args as FilesystemArguments,
          api,
          context,
          tool.name === "edit" ? "edit" : tool.name === "write" ? "write" : "read",
          async (session) => {
            return (tool as ToolRegistration).execute(
              { ...(args as Record<string, unknown>), path: session.toolPath },
              { ...api, env: session.env as ExecutionEnv },
              context,
            );
          },
        );
      } catch (error) {
        return failed(error);
      }
    },
  }));
  const definitions = [
    {
      name: "fs_list",
      method: "listDir",
      description: "List directory entries.",
      parameters: obj(
        {
          ...pathParameters,
          limit: opt(int({ minimum: 1, maximum: LIST_MAX })),
          cursor: opt(str({ description: "nextCursor from the previous page." })),
        },
        { open: true },
      ),
      output: obj({
        entries: arr(fileInfo),
        nextCursor: opt(str()),
      }),
    },
    {
      name: "fs_glob",
      method: "glob",
      description: "Find paths matching a glob pattern.",
      parameters: obj(
        {
          ...pathParameters,
          pattern: str({ minLength: 1 }),
          limit: opt(int({ minimum: 1, maximum: LIST_MAX })),
        },
        { open: true },
      ),
      output: obj({ paths: arr(str()), truncated: bool() }),
    },
    {
      name: "fs_grep",
      method: "grep",
      description: "Search files for matching lines.",
      parameters: obj(
        {
          ...pathParameters,
          pattern: str({ minLength: 1 }),
          literal: opt(bool({ description: "Match the pattern as plain text." })),
          caseSensitive: opt(bool()),
          include: opt(str()),
          context: opt(int({ minimum: 0, maximum: CONTEXT_MAX })),
          limit: opt(int({ minimum: 1, maximum: GREP_MAX })),
        },
        { open: true },
      ),
      output: obj({
        matches: arr(
          obj({
            path: str(),
            line: int(),
            text: str(),
            before: arr(str()),
            after: arr(str()),
          }),
        ),
        truncated: bool(),
      }),
    },
    {
      name: "fs_mkdir",
      method: "mkdir",
      description: "Create a directory.",
      parameters: obj(
        {
          ...pathParameters,
          recursive: opt(bool({ description: "Create missing parent directories." })),
        },
        { open: true },
      ),
      output: nul(),
    },
    {
      name: "fs_remove",
      method: "remove",
      description: "Remove a file, directory, or symlink.",
      parameters: obj(
        {
          ...pathParameters,
          recursive: opt(bool({ description: "Remove a directory and its contents." })),
        },
        { open: true },
      ),
      output: nul(),
    },
  ] as const;
  return [
    ...native,
    ...definitions.map((definition): ToolRegistration => ({
      name: definition.name,
      description: definition.description,
      // Pi can retry reads after interruption. File mutations keep its unsafe default.
      ...(["listDir", "glob", "grep"].includes(definition.method)
        ? { replay: "safe" as const }
        : {}),
      parameters: definition.parameters,
      structuredOutputSchema: definition.output,
      execute: async (args, api, context) => {
        try {
          return await router.using(
            args as FilesystemArguments,
            api,
            context,
            definition.method === "mkdir" || definition.method === "remove" ? "write" : "read",
            async (session) => {
              // Pi validates parameters against this operation's schema before execution.
              const params = args as FilesystemInputs[typeof definition.method];
              const result = await session.request(definition.method, params, context);
              const value = virtualResult(result, session);
              return {
                output: [{ type: "text" as const, text: JSON.stringify(value) }],
                structuredOutput: value,
              };
            },
          );
        } catch (error) {
          return failed(error);
        }
      },
    })),
  ];
}
