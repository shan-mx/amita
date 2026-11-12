import type { Context } from "@earendil-works/chord";
import {
  NestedCallDoc,
  ToolTask,
  type TaskId,
  type ToolExecutionApi,
  type Tx,
} from "@earendil-works/pi-durable";

export const PROGRAM_TOOL = "amita_program";
const PROGRAM_CALL_KEY = "script";
const PROGRAM_OWNER_REQUIRED = "Program entry requires a ProgramTask owner.";

export async function createProgramToolCall(tx: Tx, parentTaskId: TaskId, code: string) {
  const call = await tx.doc(NestedCallDoc, parentTaskId, PROGRAM_CALL_KEY, null);
  const callId = `program:${parentTaskId}`;
  const child = await tx.createTask(
    ToolTask,
    {
      kind: "nested",
      parent: parentTaskId,
      parentCallId: callId,
      key: PROGRAM_CALL_KEY,
      call: {
        type: "toolCall",
        id: `${callId}/${PROGRAM_CALL_KEY}`,
        name: PROGRAM_TOOL,
        arguments: { code },
      },
      progress: false,
    },
    { ownership: { kind: "task", taskId: parentTaskId } },
  );
  call.taskId = child;
  return child;
}

export async function readProgramToolResult(
  runtime: Pick<ToolExecutionApi, "taskId" | "snapshot" | "getTask">,
  childId: TaskId,
  context: Context,
) {
  const call = await runtime.snapshot(NestedCallDoc, runtime.taskId, PROGRAM_CALL_KEY, context);
  const child = await runtime.getTask(childId, context);
  return { result: call?.result, childOutcome: child?.state.outcome };
}

export async function requireProgramTaskOwner(
  api: Pick<ToolExecutionApi, "taskId" | "getTask">,
  expectedTaskKind: string,
  context: Context,
) {
  const own = await api.getTask(api.taskId, context);
  const input = own?.input;
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    input.kind !== "nested" ||
    typeof input.parent !== "number"
  )
    throw new Error(PROGRAM_OWNER_REQUIRED);
  const parent = await api.getTask(input.parent as TaskId, context);
  if (parent?.kind !== expectedTaskKind) throw new Error(PROGRAM_OWNER_REQUIRED);
  return parent;
}
