import { useRef, useState, type FormEvent } from "react";
import { ArrowUp, Square } from "lucide-react";
import { CONFIG } from "@amita/backend/config";
import { COPY } from "@/lib/copy";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { IconButton } from "@/components/patterns/icon-button";
import { InlineNotice } from "@/components/patterns/inline-notice";
import { cn } from "@/lib/utils";
import type { useSession } from "./use-session";
import type { ModelOption, ModelRef } from "@amita/backend/types";
import { ModelSelector } from "@/features/models/model-selector";

export function Composer({
  session,
  agentName,
  model,
  models,
  modelEditable,
  modelError,
  onModelChange,
  disabled,
}: {
  session: ReturnType<typeof useSession>;
  agentName: string;
  model: ModelRef | null;
  models: ModelOption[];
  modelEditable: boolean;
  modelError?: string;
  onModelChange: (model: ModelRef) => void;
  disabled: boolean;
}) {
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const submission = useRef<{ text: string; operationId: string } | undefined>(undefined);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const { running, queued, failed, needsRetry } = session.state;
  const prompt = running ? "Update current task…" : `Message ${agentName}…`;
  const showStatus = !session.connected || running || queued > 0;
  const send = async (event?: FormEvent) => {
    event?.preventDefault();
    if (disabled || !draft.trim() || submitting || !session.connected) return;
    const text = draft.trim();
    const input =
      submission.current?.text === text
        ? submission.current
        : { text, operationId: crypto.randomUUID() };
    submission.current = input;
    setSubmitting(true);
    try {
      if (await session.send(text, input.operationId)) {
        submission.current = undefined;
        setDraft((current) => (current.trim() === text ? "" : current));
        if (textarea.current?.value.trim() === text) textarea.current.style.height = "auto";
      }
    } finally {
      setSubmitting(false);
      textarea.current?.focus();
    }
  };
  return (
    <div className="chat-column pb-[max(1rem,env(safe-area-inset-bottom))] sm:pb-6">
      {(session.error || failed || modelError) && (
        <InlineNotice className="mb-3">
          {modelError ?? session.error ?? COPY.requestFailed}
        </InlineNotice>
      )}
      {needsRetry && (
        <div className="mb-3 flex items-center justify-between rounded-lg border border-border px-3 py-2 text-sm">
          <span>Needs retry</span>
          <Button size="sm" variant="outline" onClick={session.retry}>
            Retry
          </Button>
        </div>
      )}
      <div
        role="status"
        className={cn(
          "mb-2 flex flex-wrap items-center gap-x-3 px-1 text-xs text-muted-foreground",
          !showStatus && "sr-only",
        )}
      >
        <span className={cn(session.connected && "sr-only")}>
          {session.connected ? COPY.connected : COPY.reconnecting}
        </span>
        {running && <span>{COPY.running}</span>}
        {queued > 0 && <span>Update queued{queued > 1 ? ` · ${queued}` : ""}</span>}
      </div>
      <form
        onSubmit={send}
        className="rounded-xl border border-border bg-card p-2.5 focus-within:border-ring"
      >
        <Textarea
          ref={textarea}
          disabled={disabled}
          aria-label={prompt}
          placeholder={prompt}
          value={draft}
          maxLength={CONFIG.messageMaxLength}
          rows={1}
          className="block max-h-40 min-h-12 w-full resize-none rounded-none border-0 bg-transparent px-1 py-2 text-base leading-6 shadow-none focus-visible:ring-0 md:text-base dark:bg-transparent"
          onChange={(event) => {
            setDraft(event.target.value);
            event.target.style.height = "auto";
            event.target.style.height = `${Math.min(event.target.scrollHeight, 160)}px`;
          }}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing &&
              !matchMedia("(pointer: coarse)").matches
            ) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0 max-w-[75%]">
            <ModelSelector
              value={model}
              models={models}
              disabled={running || session.stopping || !session.connected || !modelEditable}
              onChange={(next) => {
                if (next) onModelChange(next);
              }}
            />
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {running && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={session.stop}
                disabled={session.stopping}
                aria-label="Stop"
              >
                <Square />
                {session.stopping ? "Stopping…" : "Stop"}
              </Button>
            )}
            <IconButton
              type="submit"
              size="icon"
              variant="default"
              className="size-10 rounded-lg"
              disabled={disabled || !draft.trim() || submitting || !session.connected}
              aria-label="Send"
            >
              <ArrowUp className="size-4" />
            </IconButton>
          </div>
        </div>
      </form>
    </div>
  );
}
