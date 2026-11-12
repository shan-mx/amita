import { match } from "ts-pattern";
import { AUTOMATION_COPY as C } from "@/features/automations/copy";
import type { AutomationInfo } from "@amita/backend/types";

export const displayTime = (timestamp: number, timezone: string) =>
  new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: timezone,
  }).format(timestamp);

export function automationStatusLabel(automation: AutomationInfo, now: number): string {
  const { definition, nextRun } = automation;
  const finished =
    now > 0 &&
    definition.trigger.type === "once" &&
    nextRun === null &&
    definition.trigger.at <= now;
  return match({ finished, enabled: definition.enabled })
    .with({ finished: true }, () => C.finished)
    .with({ enabled: true }, () => C.enabled)
    .otherwise(() => C.paused);
}
