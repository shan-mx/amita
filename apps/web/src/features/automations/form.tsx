import { ModelSelector } from "@/features/models/model-selector";
import { useId, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { NativeSelect } from "@/components/ui/native-select";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldLabel } from "@/components/ui/field";
import { AsyncButton } from "@/components/patterns/async-button";
import { CONFIG, AUTOMATION_LIMITS as L } from "@amita/backend/config";
import { COPY } from "@/lib/copy";
import { AUTOMATION_COPY as C } from "@/features/automations/copy";
import { useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import { match } from "ts-pattern";
import { rpc } from "@/lib/query";
import { apiErrorMessage } from "@/lib/api-error";
import { InlineNotice } from "@/components/patterns/inline-notice";
import type { AutomationInfo, AutomationWrite, AutomationOptions } from "@amita/backend/types";
import { validTimezone, type FormState } from "./form-state";
export function AutomationForm({
  initial,
  agentId,
  options,
  onSaved,
  onCancel,
}: {
  initial: FormState;
  agentId: string;
  options: AutomationOptions;
  onSaved: (saved: AutomationInfo) => void;
  onCancel: () => void;
}) {
  const [editing, setEditing] = useState(initial);
  const [validationError, setError] = useState<string>();
  const client = useQueryClient();
  const refresh = () =>
    client.invalidateQueries({ queryKey: rpc.automations.list.key({ input: { agentId } }) });
  const create = useMutation(rpc.automations.create.mutationOptions({ onSuccess: refresh }));
  const update = useMutation(rpc.automations.update.mutationOptions({ onSuccess: refresh }));
  const busy = create.isPending || update.isPending;
  const hasMessage = Boolean(editing.prompt.trim());
  const sessionQueries = useQueries({
    queries: [false, true].map((archived) => ({
      ...rpc.sessions.list.queryOptions({ input: { agentId, archived } }),
      enabled: hasMessage,
    })),
  });
  const sessions = sessionQueries.flatMap((query) => query.data ?? []);
  const sessionsLoading = sessionQueries.some((query) => query.isPending);
  const failure =
    create.error ??
    update.error ??
    (hasMessage ? sessionQueries.find((query) => query.error)?.error : undefined);
  const error = validationError ?? (failure ? apiErrorMessage(failure) : undefined);
  const formId = useId();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError(undefined);
    if (!validTimezone(editing.timezone)) {
      setError(C.invalidTimezone);
      return;
    }
    if (editing.triggerType === "cron" && editing.expression.trim().split(/\s+/).length !== 5) {
      setError(C.invalidCron);
      return;
    }
    if (!hasMessage && !editing.script.trim()) {
      setError(C.missingProgram);
      return;
    }
    const originalOnce = editing.originalOnce;
    const unchangedOnce =
      originalOnce &&
      editing.runAt === originalOnce.runAt &&
      editing.timezone.trim() === originalOnce.timezone;
    const trigger = match(editing.triggerType)
      .returnType<AutomationWrite["trigger"]>()
      .with("once", () => ({
        type: "once",
        runAt: unchangedOnce ? new Date(originalOnce.at).toISOString() : editing.runAt,
      }))
      .with("cron", () => ({ type: "cron", expression: editing.expression.trim() }))
      .exhaustive();
    const definition: AutomationWrite = {
      name: editing.name.trim(),
      trigger,
      timezone: editing.timezone.trim(),
      script: editing.script,
      prompt: editing.prompt,
      execution: hasMessage
        ? editing.sessionId
          ? { kind: "existing_session", sessionId: editing.sessionId }
          : { kind: "new_session", ...(editing.model ? { model: editing.model } : {}) }
        : null,
      enabled: editing.enabled,
    };
    if (editing.isExisting)
      update.mutate({ agentId, id: editing.id, patch: definition }, { onSuccess: onSaved });
    else create.mutate({ agentId, id: editing.id, definition }, { onSuccess: onSaved });
  };
  return (
    <form className="space-y-4" onSubmit={submit} onChange={() => setError(undefined)}>
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium">{editing.isExisting ? C.edit : C.create}</h2>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            onCancel();
          }}
        >
          Cancel
        </Button>
      </div>
      <fieldset disabled={busy} className="min-w-0 space-y-4">
        <Field>
          <FieldLabel htmlFor={`${formId}-name`}>{C.name}</FieldLabel>
          <Input
            required
            maxLength={CONFIG.nameMaxLength}
            value={editing.name}
            onChange={(e) =>
              setEditing({
                ...editing,
                name: e.target.value,
              })
            }
            id={`${formId}-name`}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${formId}-trigger`}>{C.trigger}</FieldLabel>
          <NativeSelect
            value={editing.triggerType}
            onChange={(e) =>
              setEditing({
                ...editing,
                triggerType: e.target.value as FormState["triggerType"],
              })
            }
            id={`${formId}-trigger`}
          >
            <option value="once">{C.once}</option>
            <option value="cron">{C.cron}</option>
          </NativeSelect>
        </Field>
        <div className="grid gap-3 lg:grid-cols-2">
          {editing.triggerType === "once" ? (
            <Field>
              <FieldLabel htmlFor={`${formId}-run-at`}>{C.runAt}</FieldLabel>
              <Input
                type="datetime-local"
                step="1"
                required
                value={editing.runAt}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    runAt: e.target.value,
                  })
                }
                id={`${formId}-run-at`}
              />
            </Field>
          ) : (
            <Field>
              <FieldLabel htmlFor={`${formId}-expression`}>{C.expression}</FieldLabel>
              <Input
                required
                value={editing.expression}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    expression: e.target.value,
                  })
                }
                id={`${formId}-expression`}
              />
            </Field>
          )}
          <Field>
            <FieldLabel htmlFor={`${formId}-timezone`}>{C.timezone}</FieldLabel>
            <Input
              required
              value={editing.timezone}
              onChange={(e) =>
                setEditing({
                  ...editing,
                  timezone: e.target.value,
                })
              }
              id={`${formId}-timezone`}
            />
          </Field>
        </div>
        <Field>
          <FieldLabel htmlFor={`${formId}-prompt`}>{C.prompt}</FieldLabel>
          <Textarea
            rows={4}
            maxLength={L.sourceMaxLength}
            value={editing.prompt}
            onChange={(e) => setEditing({ ...editing, prompt: e.target.value })}
            id={`${formId}-prompt`}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${formId}-script`}>{C.script}</FieldLabel>
          <Textarea
            rows={5}
            maxLength={L.sourceMaxLength}
            value={editing.script}
            onChange={(e) => setEditing({ ...editing, script: e.target.value })}
            id={`${formId}-script`}
          />
          {hasMessage && editing.script.trim() && (
            <p className="text-xs text-muted-foreground">{C.guardContract}</p>
          )}
        </Field>
        {hasMessage && (
          <>
            <Field>
              <FieldLabel htmlFor={`${formId}-session`}>{C.session}</FieldLabel>
              <NativeSelect
                id={`${formId}-session`}
                value={editing.sessionId}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    sessionId: e.target.value,
                    model: e.target.value ? null : editing.model,
                  })
                }
              >
                <option value="">{C.newSession}</option>
                {editing.sessionId &&
                  !sessions.some((session) => session.id === editing.sessionId) && (
                    <option value={editing.sessionId} disabled>
                      {sessionsLoading ? COPY.loading : C.unavailableSession(editing.sessionId)}
                    </option>
                  )}
                {sessions.map((session) => (
                  <option key={session.id} value={session.id}>
                    {session.archived ? C.archivedSession(session.title) : session.title}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            {!editing.sessionId && (
              <Field>
                <FieldLabel htmlFor={`${formId}-model`}>{C.model}</FieldLabel>
                <ModelSelector
                  id={`${formId}-model`}
                  value={editing.model}
                  models={options.models}
                  inheritLabel={C.inheritModel}
                  disabled={busy}
                  onChange={(model) => setEditing({ ...editing, model })}
                />
              </Field>
            )}
          </>
        )}
      </fieldset>
      {error && <InlineNotice>{error}</InlineNotice>}
      <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <Checkbox
            disabled={busy}
            checked={editing.enabled}
            onCheckedChange={(checked) =>
              setEditing({
                ...editing,
                enabled: checked,
              })
            }
          />
          {C.enabled}
        </label>
        <div className="ml-auto flex gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              onCancel();
            }}
          >
            {COPY.cancel}
          </Button>
          <AsyncButton type="submit" pending={busy}>
            {busy ? COPY.loading : C.save}
          </AsyncButton>
        </div>
      </div>
    </form>
  );
}
