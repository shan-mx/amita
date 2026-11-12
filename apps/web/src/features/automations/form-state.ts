import type { AutomationInfo, ModelRef } from "@amita/backend/types";
export type FormState = {
  id: string;
  isExisting: boolean;
  originalOnce?: { at: number; runAt: string; timezone: string };
  name: string;
  triggerType: "once" | "cron";
  runAt: string;
  expression: string;
  timezone: string;
  sessionId: string;
  script: string;
  prompt: string;
  model: ModelRef | null;
  enabled: boolean;
};

const browserTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "";
const toLocalInput = (timestamp: number, timezone: string) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(timestamp);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}:${values.second}`;
};
export const validTimezone = (timezone: string) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
};
export const newForm = (): FormState => ({
  id: crypto.randomUUID(),
  isExisting: false,
  name: "",
  triggerType: "once",
  runAt: "",
  expression: "0 9 * * *",
  timezone: browserTimezone(),
  sessionId: "",
  script: "",
  prompt: "",
  model: null,
  enabled: true,
});
export const editForm = (item: AutomationInfo): FormState => {
  const d = item.definition;
  const displayedRunAt = d.trigger.type === "once" ? toLocalInput(d.trigger.at, d.timezone) : "";
  return {
    id: item.id,
    isExisting: true,
    originalOnce:
      d.trigger.type === "once"
        ? { at: d.trigger.at, runAt: displayedRunAt, timezone: d.timezone }
        : undefined,
    name: d.name,
    triggerType: d.trigger.type,
    runAt: displayedRunAt,
    expression: d.trigger.type === "cron" ? d.trigger.expression : "0 9 * * *",
    timezone: d.timezone,
    sessionId: d.execution?.kind === "existing_session" ? d.execution.sessionId : "",
    script: d.script ?? "",
    prompt: d.prompt ?? "",
    model: d.execution?.kind === "new_session" ? (d.execution.model ?? null) : null,
    enabled: d.enabled,
  };
};
