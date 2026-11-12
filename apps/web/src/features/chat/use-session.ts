import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { applyImmutable } from "@earendil-works/chord/delta";
import { BACKGROUND_CONTEXT as BG, withCancel, type Context } from "@earendil-works/chord/context";
import {
  ConversationTranscript,
  type ConversationView,
  type LiveState,
  type TranscriptItem,
  type TranscriptView,
} from "@earendil-works/pi-durable";
import { ORPCError } from "@orpc/client";
import { api } from "@/lib/api";
import { emptyState, projectView } from "./session-state";
import { connectChat } from "./transport";
import { CHAT_LOGIN_EXPIRED, CONFIG } from "@amita/backend/config";
import { COPY } from "@/lib/copy";
import type { StreamPacket } from "@amita/backend/types";

const EMPTY_ITEMS: readonly TranscriptItem[] = [];
type Gap = Extract<TranscriptItem, { kind: "gap" }>;
type SessionTranscript = {
  transcript: ConversationTranscript;
  context: Context;
  view?: ConversationView;
};
const isModelRejection = (error: unknown): error is ORPCError<"PRECONDITION_FAILED", unknown> =>
  error instanceof ORPCError && error.code === "PRECONDITION_FAILED";

export function useSession(
  agentId: string | undefined,
  sessionId: string | undefined,
  onExpired: () => void,
  onChanged: () => void,
) {
  const [transcriptView, setTranscriptView] = useState<TranscriptView>();
  const items = transcriptView?.items ?? EMPTY_ITEMS;
  const entries = useMemo(
    () => items.flatMap((item) => (item.kind === "entry" ? [item.entry] : [])),
    [items],
  );
  const docs = transcriptView?.docs;
  const state = useMemo(
    () => (docs ? projectView({ entries, docs }) : emptyState()),
    [docs, entries],
  );
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [error, setError] = useState<string>();
  const [stopping, setStopping] = useState(false);
  const callbacks = useRef({ onExpired, onChanged });
  const current = useRef<SessionTranscript | undefined>(undefined);
  useLayoutEffect(() => {
    callbacks.current = { onExpired, onChanged };
  }, [onExpired, onChanged]);

  useEffect(() => {
    setTranscriptView(undefined);
    setConnected(false);
    setLoading(true);
    setLoadingHistory(false);
    setError(undefined);
    setStopping(false);
    if (!agentId || !sessionId) {
      setLoading(false);
      return;
    }
    const { context, cancel } = withCancel(BG);
    const transcript = new ConversationTranscript(
      async (query, limit, pageContext) => {
        const page = await api.sessions.history(
          { agentId, sessionId, ...query, limit },
          { signal: pageContext.abortSignal },
        );
        return { items: page.entries, next: page.next };
      },
      { pageSize: CONFIG.historyPageSize },
    );
    const session: SessionTranscript = { transcript, context };
    current.current = session;
    let active = true;
    let retry: ReturnType<typeof setTimeout>;
    let socket: WebSocket | undefined;

    const connect = () => {
      const next = connectChat(window.location.origin, agentId, {
        session: sessionId,
        from: transcript.resume?.from,
      });
      socket = next;
      let view: ConversationView | undefined;
      let running = false;
      next.onmessage = ({ data }) => {
        if (!active || socket !== next) return;
        try {
          const packet = JSON.parse(data as string) as StreamPacket;
          if (packet.type === "session_changed") {
            callbacks.current.onChanged();
            return;
          }
          const previousView = view;
          if (packet.type === "snapshot") view = packet.view;
          else if (view && packet.type === "delta") view = applyImmutable(view, packet.ops);
          else throw new Error("Expected a conversation snapshot before deltas");
          session.view = view;
          setTranscriptView(transcript.merge(view));
          const nextRunning = Boolean((view.docs["pi.live"] as LiveState | undefined)?.run);
          if (!previousView) {
            setConnected(true);
            setLoading(false);
            setError(undefined);
          }
          if (
            packet.type === "snapshot" ||
            running !== nextRunning ||
            previousView?.entries.at(-1)?.id !== view.entries.at(-1)?.id
          ) {
            callbacks.current.onChanged();
          }
          running = nextRunning;
        } catch {
          setError(COPY.requestFailed);
          next.close();
        }
      };
      next.onclose = ({ code }) => {
        if (!active || socket !== next) return;
        setConnected(false);
        if (code === CHAT_LOGIN_EXPIRED) {
          callbacks.current.onExpired();
          return;
        }
        if (!view) setError(COPY.requestFailed);
        retry = setTimeout(connect, CONFIG.reconnectDelayMs);
      };
    };
    connect();
    return () => {
      active = false;
      current.current = undefined;
      cancel();
      socket?.close();
      clearTimeout(retry);
    };
  }, [agentId, sessionId]);

  const send = useCallback(
    async (text: string, operationId: string) => {
      if (!agentId || !sessionId) return;
      const input = {
        agentId,
        sessionId,
        text,
        operationId,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      };
      setError(undefined);
      try {
        await api.sessions.submit(input);
        callbacks.current.onChanged();
      } catch (error) {
        setError(isModelRejection(error) ? error.message : COPY.requestFailed);
        return false;
      }
      return true;
    },
    [agentId, sessionId],
  );

  const stop = useCallback(async () => {
    if (!agentId || !sessionId) return;
    setStopping(true);
    try {
      await api.sessions.stop({ agentId, sessionId });
    } catch {
      setError(COPY.requestFailed);
    } finally {
      setStopping(false);
    }
  }, [agentId, sessionId]);

  const loadHistory = async (gap?: Gap) => {
    const session = current.current;
    if (!session?.view) return;
    setLoadingHistory(true);
    try {
      if (gap) await session.transcript.fillGap(gap, session.context);
      else await session.transcript.loadEarlier(session.context);
      if (current.current === session) setTranscriptView(session.transcript.merge(session.view));
    } catch {
      if (current.current === session) setError(COPY.requestFailed);
    } finally {
      if (current.current === session) setLoadingHistory(false);
    }
  };

  const retry = async () => {
    if (!agentId || !sessionId) return;
    try {
      await api.sessions.retry({ agentId, sessionId });
    } catch {
      setError(COPY.requestFailed);
    }
  };
  return {
    state,
    connected,
    loading,
    error,
    stopping,
    send,
    stop,
    retry,
    items,
    loadHistory,
    loadingHistory,
  };
}
