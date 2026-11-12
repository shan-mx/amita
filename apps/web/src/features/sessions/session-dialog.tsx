import { useState, type FormEvent } from "react";
import { match } from "ts-pattern";
import { CONFIG } from "@amita/backend/config";
import { COPY } from "@/lib/copy";
import type { SessionInfo } from "@amita/backend/types";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { rpc } from "@/lib/query";
import { Button } from "@/components/ui/button";
import { FormDialog } from "@/components/patterns/form-dialog";
import { AsyncButton } from "@/components/patterns/async-button";
import { InlineNotice } from "@/components/patterns/inline-notice";
import { Input } from "@/components/ui/input";
import { Field, FieldLabel } from "@/components/ui/field";

export function SessionDialog({
  agentId,
  session,
  onClose,
  onChanged,
}: {
  agentId: string;
  session?: SessionInfo;
  onClose: () => void;
  onChanged: (archived?: boolean) => void;
}) {
  const [title, setTitle] = useState(session?.title ?? "");
  const client = useQueryClient();
  const update = useMutation(
    rpc.sessions.update.mutationOptions({
      onSuccess: () =>
        client.invalidateQueries({ queryKey: rpc.sessions.list.key({ input: { agentId } }) }),
    }),
  );
  const busy = update.isPending;
  const error = update.error ? COPY.requestFailed : undefined;
  const rename = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!session || !title.trim() || title.length > CONFIG.sessionTitleMaxLength || busy) return;
    update.mutate(
      { agentId, sessionId: session.id, title: title.trim() },
      {
        onSuccess: () => {
          onChanged();
          onClose();
        },
      },
    );
  };
  const setArchived = () => {
    if (!session || busy) return;
    const archived = !session.archived;
    update.mutate(
      { agentId, sessionId: session.id, archived },
      {
        onSuccess: () => {
          onChanged(archived);
          onClose();
        },
      },
    );
  };

  const validTitle = Boolean(title.trim()) && title.length <= CONFIG.sessionTitleMaxLength;

  return (
    <FormDialog
      open
      onOpenChange={(value) => {
        if (!value && !busy) onClose();
      }}
      title="Rename session"
      onSubmit={rename}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            {COPY.cancel}
          </Button>
          <AsyncButton
            type="button"
            variant="outline"
            onClick={setArchived}
            pending={busy}
            disabled={!session}
          >
            {match({ busy: Boolean(busy), archived: session?.archived })
              .with({ busy: true }, () => COPY.loading)
              .with({ archived: true }, () => COPY.restore)
              .otherwise(() => COPY.archive)}
          </AsyncButton>
          <AsyncButton type="submit" pending={busy} disabled={!session || !validTitle}>
            {busy ? COPY.loading : COPY.rename}
          </AsyncButton>
        </>
      }
    >
      <div className="space-y-5">
        <Field>
          <FieldLabel htmlFor="session-title">Title</FieldLabel>
          <Input
            id="session-title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={CONFIG.sessionTitleMaxLength}
            disabled={!session || busy}
            autoFocus
          />
        </Field>
        {error && <InlineNotice>{error}</InlineNotice>}
      </div>
    </FormDialog>
  );
}
