import { ORPCError } from "@orpc/client";
import { apiErrorMessage } from "@/lib/api-error";
import { useState, type FormEvent } from "react";
import { CONFIG } from "@amita/backend/config";
import { COPY } from "@/lib/copy";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { rpc } from "@/lib/query";
import { Button } from "@/components/ui/button";
import { FormDialog } from "@/components/patterns/form-dialog";
import { AsyncButton } from "@/components/patterns/async-button";
import { InlineNotice } from "@/components/patterns/inline-notice";
import { Textarea } from "@/components/ui/textarea";
import { Field, FieldLabel } from "@/components/ui/field";

export function MemoryDialog({ agentId, onClose }: { agentId: string; onClose: () => void }) {
  const client = useQueryClient();
  const query = useQuery(rpc.agents.memory.queryOptions({ input: { agentId } }));
  const [draft, setMemory] = useState<string>();
  const memory = draft ?? query.data?.memory ?? "";
  const save = useMutation(
    rpc.agents.saveMemory.mutationOptions({
      onSuccess: (saved) =>
        client.setQueryData(
          rpc.agents.memory.queryKey({ input: { agentId } }),
          (current) => current && { ...current, ...saved },
        ),
    }),
  );
  const loaded = query.isSuccess;
  const loading = query.isFetching;
  const saving = save.isPending;
  const failure = save.error ?? query.error;
  const error =
    failure instanceof ORPCError && failure.code === "BAD_REQUEST"
      ? apiErrorMessage(failure)
      : failure
        ? COPY.requestFailed
        : undefined;
  const length = [...memory].length;
  const overLimit = length > CONFIG.memoryCodePointLimit;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!loaded || loading || saving || overLimit) return;
    save.mutate({ agentId, memory }, { onSuccess: onClose });
  };

  return (
    <FormDialog
      open
      onOpenChange={(value) => {
        if (!value && !saving) onClose();
      }}
      title={COPY.memory}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
            {COPY.cancel}
          </Button>
          <AsyncButton
            type="submit"
            form="agent-memory-form"
            pending={loading || saving}
            disabled={!loaded || overLimit}
          >
            {loading || saving ? COPY.loading : COPY.saveMemory}
          </AsyncButton>
        </>
      }
    >
      <form id="agent-memory-form" onSubmit={submit} className="space-y-5">
        <Field>
          <FieldLabel htmlFor="agent-memory" className="sr-only">
            {COPY.memory}
          </FieldLabel>
          <Textarea
            id="agent-memory"
            className="min-h-64 resize-y leading-relaxed"
            value={memory}
            onChange={(event) => setMemory(event.target.value)}
            disabled={loading || !loaded}
            aria-describedby="agent-memory-count"
          />
          <div className="flex justify-between gap-4 text-xs text-muted-foreground">
            <span id="agent-memory-count">
              {length.toLocaleString()} / {CONFIG.memoryCodePointLimit.toLocaleString()}
            </span>
          </div>
        </Field>
        <p className="text-sm leading-relaxed text-muted-foreground">{COPY.contextChanges}</p>
        {overLimit && <InlineNotice>{COPY.memoryTooLong}</InlineNotice>}
        {error && <InlineNotice>{error}</InlineNotice>}
      </form>
    </FormDialog>
  );
}
