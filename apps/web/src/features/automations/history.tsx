import { Button } from "@/components/ui/button";
import { AUTOMATION_COPY as C } from "@/features/automations/copy";
import type { AutomationRunInfo } from "@amita/backend/types";

import { displayTime } from "./format";
export function RunCard({
  run,
  timezone,
  onStop,
  onOpen,
  busy,
}: {
  run: AutomationRunInfo;
  timezone: string;
  onStop: () => void;
  onOpen?: () => void;
  busy: boolean;
}) {
  const status: Record<AutomationRunInfo["status"], string> = {
    running: C.running,
    succeeded: C.succeeded,
    skipped: C.skipped,
    failed: C.failed,
    cancelled: C.cancelled,
  };
  return (
    <article className="min-w-0 border-t border-border py-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">{status[run.status]}</span>
        <time className="text-xs text-muted-foreground">
          {displayTime(run.startedAt ?? run.admittedAt, timezone)}
        </time>
      </div>
      {run.error && (
        <p className="mt-2 whitespace-pre-wrap break-words text-xs text-destructive">{run.error}</p>
      )}
      {run.output && (
        <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/50 p-2 text-xs">
          {run.output}
        </pre>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        {run.status === "running" && (
          <Button size="sm" variant="ghost" onClick={onStop} disabled={busy}>
            {C.stop}
          </Button>
        )}
        {onOpen && (
          <Button size="sm" variant="ghost" onClick={onOpen}>
            {C.openSession}
          </Button>
        )}
      </div>
    </article>
  );
}
