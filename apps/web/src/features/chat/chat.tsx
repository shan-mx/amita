import { useMemo } from "react";
import {
  AssistantRuntimeProvider,
  ThreadPrimitive,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import type { AgentInfo } from "@amita/backend/types";
import { useMutation, useQuery } from "@tanstack/react-query";
import { rpc } from "@/lib/query";
import { apiErrorMessage } from "@/lib/api-error";
import type { TranscriptItem } from "@earendil-works/pi-durable";
import { COPY } from "@/lib/copy";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ToolView } from "./tool-card";
import { UserMessage, AssistantMessage } from "./messages";
import { Composer } from "./composer";
import { sessionMessages } from "./runtime-adapter";
import { STREAMING_MESSAGE_ID, visibleEntryMessages } from "./session-state";
import { useSession } from "./use-session";

type Gap = Extract<TranscriptItem, { kind: "gap" }>;

export function Chat({
  agent,
  sessionId,
  modelEditable,
  modelSetupNeeded,
  onExpired,
  onChanged,
}: {
  agent: AgentInfo;
  sessionId: string;
  modelEditable: boolean;
  modelSetupNeeded: boolean;
  onExpired: () => void;
  onChanged: () => void;
}) {
  const session = useSession(agent.id, sessionId, onExpired, onChanged);
  const models = useQuery(rpc.providers.models.queryOptions());
  const setModel = useMutation(rpc.sessions.setModel.mutationOptions());
  const messages = useMemo(() => sessionMessages(session.state), [session.state]);
  const historyGaps = useMemo(() => {
    const before = new Map<string, Gap[]>();
    let pending: Gap[] = [];
    for (const item of session.items) {
      if (item.kind === "gap") pending.push(item);
      if (item.kind === "entry" && pending.length > 0) {
        const first = visibleEntryMessages(item.entry)[0];
        if (first) {
          before.set(first.id, pending);
          pending = [];
        }
      }
    }
    return { before, trailing: pending };
  }, [session.items]);
  const runtime = useExternalStoreRuntime({
    messages,
    convertMessage: (message) => message,
    isRunning: session.state.running,
    isLoading: session.loading,
    onNew: async (message) => {
      const text = message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("");
      await session.send(text, crypto.randomUUID());
    },
    onCancel: session.stop,
  });
  const renderGap = (gap: Gap) => (
    <div key={`gap:${gap.after}:${gap.upTo}`} className="my-4 flex justify-center">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => void session.loadHistory(gap)}
        disabled={session.loadingHistory}
      >
        Load missing messages
      </Button>
    </div>
  );
  return (
    <ToolView.Provider value={session.state}>
      <AssistantRuntimeProvider runtime={runtime}>
        <ThreadPrimitive.Root className="flex min-h-0 flex-1 flex-col">
          <ThreadPrimitive.Viewport
            className="chat-scroll min-h-0 flex-1 overflow-y-auto"
            autoScroll
          >
            <div className="chat-column pb-8 pt-4 sm:pt-8">
              {session.items[0]?.kind === "earlier" && (
                <div className="mb-6 flex justify-center">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void session.loadHistory()}
                    disabled={session.loadingHistory}
                  >
                    Load earlier messages
                  </Button>
                </div>
              )}
              {session.loading && (
                <div aria-label={COPY.loading} className="space-y-4 pt-6">
                  <Skeleton className="ml-auto h-12 w-48" />
                  <Skeleton className="h-4 w-2/3" />
                  <Skeleton className="h-4 w-1/2" />
                </div>
              )}
              <ThreadPrimitive.Messages>
                {({ message }) => (
                  <>
                    {(message.id === STREAMING_MESSAGE_ID
                      ? historyGaps.trailing
                      : historyGaps.before.get(message.id)
                    )?.map(renderGap)}
                    {message.role === "user" ? <UserMessage /> : <AssistantMessage />}
                  </>
                )}
              </ThreadPrimitive.Messages>
              {!session.state.live && historyGaps.trailing.map(renderGap)}
              {session.state.stopped && (
                <p className="mt-3 text-xs text-muted-foreground">Stopped by you</p>
              )}
            </div>
          </ThreadPrimitive.Viewport>
          <Composer
            session={session}
            agentName={agent.name}
            model={session.state.model}
            models={models.data ?? []}
            modelEditable={modelEditable && !setModel.isPending}
            modelError={
              setModel.error
                ? apiErrorMessage(setModel.error)
                : models.error
                  ? apiErrorMessage(models.error)
                  : undefined
            }
            onModelChange={(next) => setModel.mutate({ agentId: agent.id, sessionId, model: next })}
            disabled={modelSetupNeeded}
          />
        </ThreadPrimitive.Root>
      </AssistantRuntimeProvider>
    </ToolView.Provider>
  );
}
