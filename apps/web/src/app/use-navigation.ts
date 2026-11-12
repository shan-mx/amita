import { useCallback, useEffect, useState } from "react";
import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { rpc } from "@/lib/query";
import { COPY } from "@/lib/copy";
import type { AgentInfo, SessionInfo } from "@amita/backend/types";

type Selection = { agentId?: string; sessionId?: string };
const initialSelection = (): Selection => {
  const params = new URLSearchParams(location.search);
  return {
    agentId: params.get("agent") ?? undefined,
    sessionId: params.get("session") ?? undefined,
  };
};

export function useNavigation() {
  const client = useQueryClient();
  const [requested, setSelection] = useState<Selection>(initialSelection);
  const [archived, setArchived] = useState(
    () => new URLSearchParams(location.search).get("archived") === "1",
  );
  const agentsQuery = useQuery(rpc.agents.list.queryOptions());
  const agents = agentsQuery.data ?? [];
  const agent = agents.find((item) => item.id === requested.agentId) ?? agents[0];
  const agentId = agent?.id;
  const sessionsQuery = useQuery(
    rpc.sessions.list.queryOptions({
      input: agentId ? { agentId, archived } : skipToken,
    }),
  );
  const sessions = sessionsQuery.data ?? [];
  const selectedSession = sessions.find((item) => item.id === requested.sessionId) ?? sessions[0];
  const sessionId = selectedSession?.id;
  const selection: Selection = { agentId, sessionId };
  const refreshAgents = useCallback(
    () => client.invalidateQueries({ queryKey: rpc.agents.list.key() }),
    [client],
  );
  const refreshSessions = useCallback(() => {
    if (agentId)
      return client.invalidateQueries({
        queryKey: rpc.sessions.list.key({ input: { agentId, archived } }),
      });
  }, [client, agentId, archived]);
  const create = useMutation(
    rpc.sessions.create.mutationOptions({
      mutationKey: [...rpc.sessions.create.mutationKey(), agentId, archived],
      onSuccess: (_next, input) =>
        client.invalidateQueries({
          queryKey: rpc.sessions.list.key({ input: { agentId: input.agentId } }),
        }),
    }),
  );
  const archive = useMutation(
    rpc.sessions.update.mutationOptions({
      mutationKey: [...rpc.sessions.update.mutationKey(), agentId, archived],
      onSuccess: (_next, input) =>
        client.invalidateQueries({
          queryKey: rpc.sessions.list.key({ input: { agentId: input.agentId } }),
        }),
    }),
  );
  useEffect(() => {
    const params = new URLSearchParams();
    if (agentId) params.set("agent", agentId);
    if (sessionId) params.set("session", sessionId);
    if (archived) params.set("archived", "1");
    history.replaceState(null, "", `${location.pathname}${params.size ? `?${params}` : ""}`);
  }, [agentId, sessionId, archived]);
  const selectAgent = (id: string) => {
    if (id !== agentId) {
      setArchived(false);
      setSelection({ agentId: id });
    }
  };
  const selectSession = (sessionId: string, isArchived = archived) => {
    if (!agentId) return;
    setArchived(isArchived);
    setSelection({ agentId, sessionId });
  };
  const newSession = (onCreated?: () => void) => {
    if (!agentId || create.isPending) return;
    create.mutate(
      { agentId },
      {
        onSuccess: (next) => {
          setArchived(false);
          setSelection({ agentId, sessionId: next.id });
          onCreated?.();
        },
      },
    );
  };
  const archiveSession = (session: SessionInfo) => {
    if (!agentId || archive.isPending) return;
    archive.mutate({ agentId, sessionId: session.id, archived: !session.archived });
  };
  const agentSaved = (next?: AgentInfo, sessionId?: string) => {
    if (next) {
      setArchived(false);
      setSelection({ agentId: next.id, sessionId });
    }
    void refreshAgents();
  };
  const sessionUpdated = (nextArchived?: boolean, target?: SessionInfo) => {
    if (
      nextArchived !== undefined &&
      nextArchived !== archived &&
      (!target || target.id === selectedSession?.id)
    )
      setArchived(nextArchived);
  };
  return {
    agents,
    agentsLoaded: agentsQuery.isSuccess,
    sessions,
    sessionsLoaded: sessionsQuery.isSuccess,
    selection,
    archived,
    agent,
    selectedSession,
    error:
      agentsQuery.error || sessionsQuery.error || create.error || archive.error
        ? COPY.requestFailed
        : undefined,
    creatingSession: create.isPending,
    archivingSessionId: archive.isPending ? archive.variables.sessionId : undefined,
    refreshAgents,
    refreshSessions,
    selectAgent,
    selectSession,
    newSession,
    archiveSession,
    agentSaved,
    sessionUpdated,
    toggleArchived: () => setArchived((value) => !value),
  };
}
