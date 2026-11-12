import { useState, type FormEvent } from "react";
import { CONFIG } from "@amita/backend/config";
import { COPY } from "@/lib/copy";
import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { rpc } from "@/lib/query";
import { FormDialog } from "@/components/patterns/form-dialog";
import { AsyncButton } from "@/components/patterns/async-button";
import { InlineNotice } from "@/components/patterns/inline-notice";
import { Input } from "@/components/ui/input";

export function SessionSearch({
  agentId,
  onClose,
  onSelect,
}: {
  agentId: string;
  onClose: () => void;
  onSelect: (sessionId: string, archived: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  const client = useQueryClient();
  const [submitted, setSubmitted] = useState<string>();
  const searchQuery = useQuery(
    rpc.sessions.search.queryOptions({
      input: submitted === undefined ? skipToken : { agentId, query: submitted },
    }),
  );
  const rebuildMutation = useMutation(
    rpc.sessions.rebuildIndex.mutationOptions({
      onSuccess: () =>
        client.invalidateQueries({
          queryKey: rpc.sessions.search.key({ input: { agentId } }),
          refetchType: "none",
        }),
    }),
  );
  const results = searchQuery.data ?? [];
  const loading = searchQuery.isFetching;
  const rebuilding = rebuildMutation.isPending;
  const searched = submitted !== undefined;
  const error = searchQuery.error || rebuildMutation.error ? COPY.requestFailed : undefined;
  const busy = loading || rebuilding;
  const validQuery = Boolean(query.trim()) && query.length <= CONFIG.searchQueryMaxLength;
  const search = () => {
    const value = query.trim();
    if (submitted === value) void searchQuery.refetch();
    else setSubmitted(value);
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (validQuery && !busy) search();
  };
  const rebuild = () => {
    if (validQuery && !busy) rebuildMutation.mutate({ agentId }, { onSuccess: search });
  };

  return (
    <FormDialog
      open
      onOpenChange={(value) => {
        if (!value && !busy) onClose();
      }}
      title={COPY.searchSessions}
      footer={
        <AsyncButton
          type="button"
          variant="outline"
          onClick={rebuild}
          pending={rebuilding}
          disabled={!validQuery || busy}
        >
          {rebuilding ? "Rebuilding…" : "Rebuild index"}
        </AsyncButton>
      }
    >
      <form onSubmit={submit} className="flex items-center gap-2">
        <Input
          type="search"
          aria-label="Query"
          placeholder="Search…"
          className="min-w-0 flex-1"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          maxLength={CONFIG.searchQueryMaxLength}
          autoFocus
        />
        <AsyncButton type="submit" pending={loading} disabled={!validQuery || busy}>
          {loading ? COPY.loading : "Search"}
        </AsyncButton>
      </form>
      {error && <InlineNotice className="mt-4">{error}</InlineNotice>}
      {searched && !loading && results.length === 0 && (
        <p className="mt-5 text-sm text-muted-foreground">No sessions found.</p>
      )}
      {results.length > 0 && (
        <ul className="mt-4 divide-y divide-border">
          {results.map((hit) => (
            <li key={`${hit.sessionId}:${hit.entryId}`}>
              <button
                type="button"
                disabled={busy}
                className="w-full rounded-md px-2 py-3 text-left transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => onSelect(hit.sessionId, hit.archived)}
              >
                <span className="flex items-center justify-between gap-3">
                  <span className="truncate text-sm font-medium">{hit.title}</span>
                  {hit.archived && (
                    <span className="shrink-0 text-xs text-muted-foreground">Archived</span>
                  )}
                </span>
                <span className="mt-1 block break-words text-sm leading-relaxed">
                  <span className="text-muted-foreground">
                    {hit.role === "user" ? "You" : "Assistant"}:{" "}
                  </span>
                  {hit.text}
                </span>
                {hit.context.length > 0 && (
                  <span className="mt-2 block space-y-1 break-words text-xs leading-relaxed text-muted-foreground">
                    {hit.context.map((message, index) => (
                      <span key={`${message.entryId}:${index}`} className="block">
                        {message.role === "user" ? "You" : "Assistant"}: {message.text}
                      </span>
                    ))}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </FormDialog>
  );
}
