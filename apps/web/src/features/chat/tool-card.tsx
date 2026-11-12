import { createContext, useContext } from "react";
import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import { CODEMODE_NAME, emptyState, toolPresentation, type ToolStatus } from "./session-state";
import { COPY } from "@/lib/copy";

export const ToolView = createContext(emptyState());

const STATUS_LABELS: Record<ToolStatus, string> = {
  running: COPY.running,
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  interrupted: "Interrupted",
};

export function ToolFallback({ toolCallId, toolName, args }: ToolCallMessagePartProps) {
  const state = useContext(ToolView);
  const view = toolPresentation(state, toolCallId);
  const running = view.status === "running";
  const code = toolName === CODEMODE_NAME && typeof args.code === "string" ? args.code : undefined;
  return (
    <details
      className="my-3 min-w-0 overflow-hidden rounded-xl border border-border text-sm"
      open={running || view.status === "failed"}
    >
      <summary className="flex cursor-pointer items-center justify-between gap-3 bg-muted/50 px-3 py-2">
        <span className="min-w-0 break-all font-mono text-xs">{toolName}</span>
        <span className="shrink-0 text-xs text-muted-foreground">{STATUS_LABELS[view.status]}</span>
      </summary>
      <div className="min-w-0 space-y-3 p-3">
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs text-muted-foreground">
          <code>{code ?? JSON.stringify(args, null, 2)}</code>
        </pre>
        {view.calls.length > 0 && (
          <details className="min-w-0 rounded-lg border border-border" open={running}>
            <summary className="cursor-pointer px-3 py-2 text-xs text-muted-foreground">
              Tool calls · {view.calls.length}
            </summary>
            <div className="min-w-0 space-y-2 px-2 pb-2">
              {view.calls.map((call) => (
                <details
                  key={call.id}
                  className="min-w-0 rounded-md bg-muted/40"
                  open={call.status === "running"}
                >
                  <summary className="flex cursor-pointer items-center justify-between gap-3 px-2 py-2 text-xs">
                    <span className="min-w-0 break-all font-mono">{call.name}</span>
                    <span className="shrink-0 text-muted-foreground">
                      {STATUS_LABELS[call.status]}
                    </span>
                  </summary>
                  <div className="min-w-0 space-y-2 px-2 pb-2">
                    <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all text-xs text-muted-foreground">
                      {call.args}
                    </pre>
                    {call.output && (
                      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs leading-relaxed">
                        {call.output}
                      </pre>
                    )}
                    {call.error && (
                      <p className="break-words text-xs text-destructive">{call.error}</p>
                    )}
                  </div>
                </details>
              ))}
            </div>
          </details>
        )}
        {view.output && (
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words text-xs leading-relaxed">
            {view.output}
          </pre>
        )}
        {view.result?.content.map((part, index) =>
          part.type === "image" ? (
            <img
              key={index}
              alt={`${toolName} output`}
              src={`data:${part.mimeType};base64,${part.data}`}
              className="max-h-80 max-w-full rounded-lg object-contain"
            />
          ) : null,
        )}
      </div>
    </details>
  );
}
