import { ORPCError } from "@orpc/client";
import { useState, type FormEvent } from "react";
import { CONFIG } from "@amita/backend/config";
import { COPY } from "@/lib/copy";
import type { AgentInfo, ModelRef } from "@amita/backend/types";
import { ModelSelector } from "@/features/models/model-selector";
import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { rpc } from "@/lib/query";
import { Button } from "@/components/ui/button";
import { FormDialog } from "@/components/patterns/form-dialog";
import { AsyncButton } from "@/components/patterns/async-button";
import { InlineNotice } from "@/components/patterns/inline-notice";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field, FieldLabel } from "@/components/ui/field";

export function AgentForm({
  agent,
  onClose,
  onSaved,
}: {
  agent?: AgentInfo;
  onClose: () => void;
  onSaved: (agent?: AgentInfo, sessionId?: string) => void;
}) {
  const agentId = agent?.id;
  const client = useQueryClient();
  const [slugDraft, setSlug] = useState<string>();
  const [name, setName] = useState(agent?.name ?? "");
  const [model, setModel] = useState<ModelRef | null>(agent?.model ?? null);
  const models = useQuery(rpc.providers.models.queryOptions());
  const updateModel = useMutation(
    rpc.agents.setModel.mutationOptions({
      onSuccess: () => client.invalidateQueries({ queryKey: rpc.agents.list.key() }),
    }),
  );
  const [personaDraft, setPersona] = useState<string>();
  const personaQuery = useQuery(
    rpc.agents.persona.queryOptions({ input: agentId ? { agentId } : skipToken }),
  );
  const suggestion = useQuery(
    rpc.agents.slugSuggestion.queryOptions({
      input: !agentId && slugDraft === undefined && name.trim() ? { name: name.trim() } : skipToken,
    }),
  );
  const slug = slugDraft ?? agent?.slug ?? suggestion.data ?? "";
  const persona = personaDraft ?? personaQuery.data?.persona ?? "";
  const version = personaQuery.isSuccess ? personaQuery.data.version : undefined;
  const loadingPersona = personaQuery.isFetching;
  const create = useMutation(rpc.agents.create.mutationOptions());
  const updateName = useMutation(
    rpc.agents.update.mutationOptions({
      onSuccess: () => client.invalidateQueries({ queryKey: rpc.agents.list.key() }),
    }),
  );
  const updatePersona = useMutation(
    rpc.agents.savePersona.mutationOptions({
      onSuccess: (saved, input) =>
        client.setQueryData(
          rpc.agents.persona.queryKey({ input: { agentId: input.agentId } }),
          (current) => current && { ...current, ...saved },
        ),
    }),
  );
  const pending = updateModel.isPending
    ? "model"
    : create.isPending
      ? "create"
      : updateName.isPending
        ? "name"
        : updatePersona.isPending
          ? "persona"
          : undefined;
  const nameStatus = updateName.isError ? "error" : updateName.isSuccess ? "saved" : undefined;
  const personaStatus =
    updatePersona.error instanceof ORPCError && updatePersona.error.code === "CONFLICT"
      ? "conflict"
      : updatePersona.isError || personaQuery.isError
        ? "error"
        : updatePersona.isSuccess
          ? "saved"
          : undefined;
  const createFailed = create.isError;
  const reloadPersona = () => {
    setPersona(undefined);
    updatePersona.reset();
    void personaQuery.refetch();
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!model) return;
    create.mutate(
      { slug, name, persona, model },
      {
        onSuccess: (result) => {
          onSaved(result.agent, result.sessionId);
          onClose();
        },
      },
    );
  };
  const saveName = () => {
    if (agentId && !pending) updateName.mutate({ agentId, name });
  };
  const savePersona = () => {
    if (agentId && version && !pending && !loadingPersona)
      updatePersona.mutate(
        { agentId, persona, expectedVersion: version },
        { onSuccess: () => setPersona(undefined) },
      );
  };
  return (
    <FormDialog
      open
      onOpenChange={(value) => {
        if (!value && !pending) onClose();
      }}
      title={agent ? COPY.agentSettings : COPY.newAgent}
      onSubmit={agentId ? undefined : submit}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose} disabled={!!pending}>
            {agentId ? "Close" : COPY.cancel}
          </Button>
          {!agentId && (
            <AsyncButton
              type="submit"
              pending={pending === "create"}
              disabled={!name.trim() || !slug.trim() || !model}
            >
              {pending === "create" ? COPY.loading : "Create agent"}
            </AsyncButton>
          )}
        </>
      }
    >
      <div className="space-y-5">
        <Field>
          <FieldLabel htmlFor="agent-model">Model</FieldLabel>
          <ModelSelector
            id="agent-model"
            value={model}
            models={models.data ?? []}
            disabled={!!pending}
            onChange={(next) => {
              if (!next) return;
              setModel(next);
              if (agentId) updateModel.mutate({ agentId, model: next });
            }}
          />
          {(models.error || updateModel.error) && <InlineNotice>{COPY.requestFailed}</InlineNotice>}
        </Field>
        <Field>
          <FieldLabel htmlFor="agent-name">Name</FieldLabel>
          <Input
            id="agent-name"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              updateName.reset();
            }}
            disabled={!!pending}
            required
            maxLength={CONFIG.nameMaxLength}
            autoFocus
          />
          {agentId && (
            <div className="flex items-center gap-3">
              <AsyncButton
                type="button"
                size="sm"
                onClick={saveName}
                pending={pending === "name"}
                disabled={!!pending || !name.trim()}
              >
                Save name
              </AsyncButton>
              {nameStatus === "saved" && (
                <span role="status" className="text-sm">
                  Name saved.
                </span>
              )}
            </div>
          )}
          {nameStatus === "error" && <InlineNotice>{COPY.requestFailed}</InlineNotice>}
        </Field>
        {!agent && (
          <Field>
            <FieldLabel htmlFor="agent-slug">Agent Slug</FieldLabel>
            <Input
              id="agent-slug"
              value={slug}
              onChange={(event) => {
                setSlug(event.target.value);
              }}
              required
              maxLength={CONFIG.computerSlugMaxLength}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
            <p className="text-xs text-muted-foreground">
              Use lowercase letters, numbers, or hyphens. This Slug stays with the Agent.
            </p>
          </Field>
        )}
        <Field>
          <FieldLabel htmlFor="agent-persona">Persona</FieldLabel>
          <Textarea
            id="agent-persona"
            className="min-h-44 resize-y leading-relaxed"
            value={persona}
            onChange={(event) => {
              setPersona(event.target.value);
              if (updatePersona.isSuccess) updatePersona.reset();
            }}
            disabled={!!pending || (Boolean(agentId) && loadingPersona)}
            maxLength={CONFIG.personaMaxLength}
          />
          {agentId && (
            <>
              <p className="text-xs leading-relaxed text-muted-foreground">{COPY.contextChanges}</p>
              <div className="flex items-center gap-3">
                <AsyncButton
                  type="button"
                  size="sm"
                  onClick={savePersona}
                  pending={pending === "persona"}
                  disabled={!!pending || loadingPersona || !version || personaStatus === "conflict"}
                >
                  Save persona
                </AsyncButton>
                {personaStatus === "saved" && (
                  <span role="status" className="text-sm">
                    Persona saved.
                  </span>
                )}
              </div>
              {personaStatus === "conflict" && (
                <InlineNotice>
                  {COPY.personaConflict}
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={reloadPersona}
                    disabled={loadingPersona}
                  >
                    {COPY.reloadLatest}
                  </Button>
                </InlineNotice>
              )}
              {personaStatus === "error" && (
                <InlineNotice>
                  {COPY.requestFailed}
                  {!version && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={reloadPersona}
                      disabled={loadingPersona}
                    >
                      {COPY.reloadLatest}
                    </Button>
                  )}
                </InlineNotice>
              )}
            </>
          )}
        </Field>
        {createFailed && <InlineNotice>{COPY.requestFailed}</InlineNotice>}
      </div>
    </FormDialog>
  );
}
