import type { JsonValue } from "@earendil-works/chord";
import { match } from "ts-pattern";
import { CronDate, CronExpressionParser } from "cron-parser";
import { z } from "zod";
import { modelRefSchema } from "../models/schema";
import { CONFIG, AUTOMATION_LIMITS as LIMIT, AUTOMATION_COPY as COPY } from "../shared/config";
import type { AutomationDefinition, AutomationWrite } from "../shared/automations";

export class AutomationError extends Error {
  constructor(
    readonly code: "invalid" | "conflict" | "not_found",
    message: string,
  ) {
    super(message);
    this.name = "AutomationError";
  }
}
export function validTimezone(value: string) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}
export const timezoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine(validTimezone, COPY.invalidTimezone);
const triggerSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("once"),
    runAt: z.string().min(16).max(64).describe("ISO date and time."),
  }),
  z.object({
    type: z.literal("cron"),
    expression: z.string().trim().min(1).max(256).describe("Five-field cron expression."),
  }),
]);
const nullableSource = z.string().max(LIMIT.sourceMaxLength).nullable().optional();
export const automationSessionIdSchema = z
  .string()
  .regex(/^[1-9][0-9]*$/)
  .refine((value) => Number.isSafeInteger(Number(value)), COPY.invalidSession);
export const newSessionExecutionSchema = z.strictObject({
  kind: z
    .literal("new_session")
    .describe(
      "Start a fresh Session on each run. Use for independent tasks, including when sending results back to the originating chat.",
    ),
  model: modelRefSchema.optional().describe("Defaults to the Agent model."),
});
export const existingSessionExecutionSchema = z.strictObject({
  kind: z
    .literal("existing_session")
    .describe(
      "Continue an existing Session when the task needs its conversation history. The Session's own model rules apply.",
    ),
  sessionId: automationSessionIdSchema,
});
const executionSchema = z.discriminatedUnion("kind", [
  newSessionExecutionSchema,
  existingSessionExecutionSchema,
]);
export const automationWriteSchema = z.strictObject({
  name: z.string().trim().min(1).max(CONFIG.nameMaxLength),
  trigger: triggerSchema,
  timezone: timezoneSchema.optional().describe("IANA time zone for the schedule."),
  script: nullableSource.describe(
    "JavaScript to run. When paired with a prompt, return {runAgent: boolean, context?: JSON}.",
  ),
  prompt: nullableSource,
  enabled: z.boolean().optional(),
  execution: executionSchema.nullable().optional(),
});
export const automationPatchSchema = automationWriteSchema.partial();
const nonempty = (text: string | null | undefined) => (text?.trim() ? text : null);
function cron(expression: string, timezone: string, currentDate: number) {
  if (expression.split(/\s+/).length !== 5) throw new AutomationError("invalid", COPY.invalidCron);
  return CronExpressionParser.parse(expression, {
    currentDate,
    tz: timezone,
    hashSeed: `${timezone}:${expression}`,
  });
}
function once(runAt: string, timezone: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?$/.test(runAt))
    throw new AutomationError("invalid", COPY.invalidTime);
  try {
    return new CronDate(runAt, timezone).getTime();
  } catch {
    throw new AutomationError("invalid", COPY.invalidTime);
  }
}
export function normalizeAutomation(
  input: AutomationWrite | Partial<AutomationWrite>,
  fallbackTimezone?: string,
  existing?: AutomationDefinition,
): AutomationDefinition {
  const value = (existing ? automationPatchSchema : automationWriteSchema).parse(input);
  if (existing && !Object.values(value).some((field) => field !== undefined))
    throw new AutomationError("invalid", COPY.emptyPatch);
  const timezone = value.timezone ?? existing?.timezone ?? fallbackTimezone;
  if (!timezone) throw new AutomationError("invalid", COPY.missingTimezone);
  if (!validTimezone(timezone)) throw new AutomationError("invalid", COPY.invalidTimezone);
  let trigger = existing?.trigger;
  if (value.trigger) {
    if (value.trigger.type === "once")
      trigger = { type: "once", at: once(value.trigger.runAt, timezone) };
    else {
      try {
        cron(value.trigger.expression, timezone, Date.now()).next();
      } catch {
        throw new AutomationError("invalid", COPY.invalidCron);
      }
      trigger = { type: "cron", expression: value.trigger.expression };
    }
  }
  if (!trigger) throw new AutomationError("invalid", COPY.invalidTime);
  const script = value.script === undefined ? (existing?.script ?? null) : nonempty(value.script);
  const prompt = value.prompt === undefined ? (existing?.prompt ?? null) : nonempty(value.prompt);
  if (!script && !prompt) throw new AutomationError("invalid", COPY.missingProgram);
  const execution = value.execution === undefined ? (existing?.execution ?? null) : value.execution;
  if (!prompt && execution) throw new AutomationError("invalid", COPY.agentSettingsRequireMessage);
  return {
    name: value.name ?? existing!.name,
    timezone,
    trigger,
    script,
    prompt,
    enabled: value.enabled ?? existing?.enabled ?? true,
    execution: prompt ? (execution ?? { kind: "new_session" }) : null,
  };
}
export function nextOccurrence(definition: AutomationDefinition, after: number): number | null {
  return match(definition.trigger)
    .with({ type: "once" }, ({ at }) => (at > after ? at : null))
    .with({ type: "cron" }, ({ expression }) =>
      cron(expression, definition.timezone, after).next().getTime(),
    )
    .exhaustive();
}
export function dueOccurrence(
  definition: AutomationDefinition,
  cursor: number,
  now: number,
): { due: number | null; next: number | null } {
  const next = nextOccurrence(definition, cursor);
  if (next === null || next > now) return { due: null, next };
  const due =
    definition.trigger.type === "once"
      ? definition.trigger.at
      : cron(definition.trigger.expression, definition.timezone, now + 1)
          .prev()
          .getTime();
  return { due: due > cursor ? due : null, next: nextOccurrence(definition, now) };
}

export type AutomationReply<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: AutomationError["code"]; message: string } };
export async function automationReply<T>(
  action: () => T | Promise<T>,
): Promise<AutomationReply<T>> {
  try {
    return { ok: true, value: await action() };
  } catch (error) {
    if (error instanceof AutomationError)
      return { ok: false, error: { code: error.code, message: error.message } };
    if (error instanceof z.ZodError) {
      const issue = error.issues[0];
      const path = issue?.path.map(String).join(".");
      const message = issue?.message ?? "Invalid automation.";
      return {
        ok: false,
        error: {
          code: "invalid",
          message: path ? `${path}: ${message}` : message,
        },
      };
    }
    throw error;
  }
}

export function outputText(value: JsonValue | undefined): string {
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
