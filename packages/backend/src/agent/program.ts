import type { JsonValue } from "@earendil-works/chord";
import { defineDoc, defineTask, type Extension, type TaskId } from "@earendil-works/pi-durable";
import { createCodemodeTool, type CodemodeToolInput } from "@earendil-works/pi-durable/codemode";
import type { CodemodeRun, CodemodeSandboxBase } from "@earendil-works/pi-codemode/portable";
import { AUTOMATION_COPY } from "../shared/config";
import {
  createProgramToolCall,
  PROGRAM_TOOL,
  readProgramToolResult,
  requireProgramTaskOwner,
} from "./pi-program-bridge";

export const PROGRAM_EXTENSION = "amita.program";
const ProgramReturn = defineDoc<{ value?: JsonValue }>({
  kind: "amita.program.return",
  version: 1,
  scope: "task",
  initial: () => ({}),
  checkpointWhen: () => false,
});
export type ProgramInput = { code: string; captureReturn?: boolean };
export type ProgramResult = {
  output: string;
  returned?: JsonValue;
};

type ProgramCheckpoint = { phase: "start" } | { phase: "result"; child: TaskId };
export const ProgramTask = defineTask<ProgramInput, ProgramCheckpoint, ProgramResult>({
  name: "amita.program.run",
  version: 1,
  initial: () => ({ phase: "start" }),
  phases: {
    start: async (task, runtime, context) =>
      runtime.commit(async (tx) => {
        const child = await createProgramToolCall(tx, runtime.taskId, task.input.code);
        return {
          status: "waiting",
          on: [child],
          policy: "allSettled",
          checkpoint: { phase: "result", child },
        };
      }, context),
    result: async (task, runtime, context) => {
      const childId = task.state.checkpoint.child;
      const { result: nativeResult, childOutcome } = await readProgramToolResult(
        runtime,
        childId,
        context,
      );
      const returned = task.input.captureReturn
        ? (await runtime.snapshot(ProgramReturn, runtime.taskId, context))?.value
        : undefined;
      const result: ProgramResult = {
        output: outputText(nativeResult?.structuredOutput),
        ...(returned === undefined ? {} : { returned }),
      };
      const failure =
        nativeResult?.diagnostics.find(({ severity }) => severity === "error")?.message ??
        (childOutcome?.status === "failed" ? childOutcome.error?.message : undefined) ??
        result.output;
      await runtime.commit(
        () => ({
          status: "terminal",
          outcome:
            !nativeResult || nativeResult.isError
              ? {
                  status: "failed",
                  error: { message: failure || AUTOMATION_COPY.scriptFailure },
                  result,
                }
              : { status: "completed", result },
        }),
        context,
      );
    },
  },
  abort: async (_task, runtime, context) =>
    runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

function outputText(value: JsonValue | undefined): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .flatMap((part) =>
      part &&
      typeof part === "object" &&
      !Array.isArray(part) &&
      part.type === "text" &&
      typeof part.text === "string"
        ? [part.text]
        : [],
    )
    .join("\n");
}

/** Observe the public native result; execution, transport and replay remain owned by Pi. */
function captureReturn(
  sandbox: CodemodeSandboxBase,
  capture: (value: unknown) => Promise<void>,
): CodemodeSandboxBase {
  const start: CodemodeSandboxBase["start"] = (code, options) => {
    const run = sandbox.start(code, options);
    const result = run.result.then(async (result) => {
      if (result.ok) await capture(result.value);
      return result;
    });
    void result.catch(() => {});
    return {
      get finished() {
        return run.finished;
      },
      deliver: (...args) => run.deliver(...args),
      result,
    } satisfies CodemodeRun;
  };
  return new Proxy(sandbox, {
    get(target, key) {
      if (key === "start") return start;
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Selected only by program Conversations; ordinary chat keeps its original model-only codemode. */
export function createProgramExtension(sandbox: CodemodeSandboxBase): Extension {
  const native = createCodemodeTool({ sandbox, models: false });
  return {
    name: PROGRAM_EXTENSION,
    tasks: [ProgramTask],
    tools: [
      {
        ...native,
        name: PROGRAM_TOOL,
        callers: ["tools"],
        execute: async (args, api, context) => {
          const parent = await requireProgramTaskOwner(api, ProgramTask.definition.name, context);
          const program = parent.input as ProgramInput;
          const tool = program.captureReturn
            ? createCodemodeTool({
                models: false,
                sandbox: captureReturn(sandbox, async (value) => {
                  await api.commit(async (tx) => {
                    const returned = await tx.doc(ProgramReturn, parent.id);
                    if (value === undefined) delete returned.value;
                    else returned.value = value as JsonValue;
                  }, context);
                }),
              })
            : native;
          return tool.execute(
            args as CodemodeToolInput,
            {
              ...api,
              agent: async (ctx) => {
                const agent = await api.agent(ctx);
                return {
                  ...agent,
                  callable: agent.callable.filter((tool) => tool.name !== PROGRAM_TOOL),
                };
              },
            },
            context,
          );
        },
      },
    ],
  };
}
