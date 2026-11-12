import { useState } from "react";
import {
  skipToken,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { apiErrorMessage } from "@/lib/api-error";
import { rpc } from "@/lib/query";
import type { FormState } from "./form-state";

const LIST_POLL_MS = 15_000;
const HISTORY_POLL_MS = 5_000;

export function useAutomations(agentId: string) {
  const client = useQueryClient();
  const list = useQuery(
    rpc.automations.list.queryOptions({ input: { agentId }, refetchInterval: LIST_POLL_MS }),
  );
  const options = useQuery(rpc.automations.options.queryOptions({ input: { agentId } }));
  const [requestedId, setSelectedId] = useState<string>();
  const [editing, setEditing] = useState<FormState>();
  const items = list.data ?? [];
  const current = items.find((item) => item.id === requestedId) ?? items[0];
  const selectedId = current?.id;
  const history = useInfiniteQuery(
    rpc.automations.history.infiniteOptions({
      input:
        !selectedId || editing
          ? skipToken
          : (cursor: string | undefined) => ({ agentId, id: selectedId, cursor }),
      initialPageParam: undefined,
      getNextPageParam: (page) => page.cursor,
      refetchInterval: HISTORY_POLL_MS,
    }),
  );
  const refresh = () =>
    client.invalidateQueries({ queryKey: rpc.automations.key({ input: { agentId } }) });
  const update = useMutation(
    rpc.automations.update.mutationOptions({
      mutationKey: [...rpc.automations.update.mutationKey(), selectedId],
      onSuccess: refresh,
    }),
  );
  const remove = useMutation(
    rpc.automations.remove.mutationOptions({
      mutationKey: [...rpc.automations.remove.mutationKey(), selectedId],
      onSuccess: refresh,
    }),
  );
  const stop = useMutation(
    rpc.automations.stop.mutationOptions({
      mutationKey: [...rpc.automations.stop.mutationKey(), selectedId],
      onSuccess: refresh,
    }),
  );
  const selectedRuns = history.data?.pages.flatMap((page) => page.runs) ?? [];
  const failure =
    list.error ??
    options.error ??
    (editing ? undefined : (history.error ?? update.error ?? remove.error ?? stop.error));
  return {
    items,
    options: options.data ?? { models: [] },
    selectedId,
    setSelectedId,
    editing,
    setEditing,
    current,
    selectedRuns,
    now: list.dataUpdatedAt,
    error: failure ? apiErrorMessage(failure) : undefined,
    busy: update.isPending || remove.isPending || stop.isPending,
    loading: list.isPending,
    cursor: history.hasNextPage,
    loadingMore: history.isFetching,
    activeRunEnded: current?.activeRun
      ? selectedRuns.some((run) => run.id === current.activeRun && run.status !== "running")
      : false,
    toggle: () => {
      if (current)
        update.mutate({ agentId, id: current.id, patch: { enabled: !current.definition.enabled } });
    },
    remove: () => {
      if (current) remove.mutate({ agentId, id: current.id });
    },
    stop: () => {
      if (current) stop.mutate({ agentId, id: current.id });
    },
    loadMore: () => history.fetchNextPage(),
  };
}
