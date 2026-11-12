import { useState, type FormEvent } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { ModelCandidate, ProviderInfo, ProviderWrite } from "@amita/backend/types";
import { MODEL_APIS, modelProfileSchema } from "@amita/backend/models";
import { MODEL_COPY as C } from "./copy";
import { COPY } from "@/lib/copy";
import { rpc } from "@/lib/query";
import { apiErrorMessage } from "@/lib/api-error";
import { FormDialog } from "@/components/patterns/form-dialog";
import { AsyncButton } from "@/components/patterns/async-button";
import { InlineNotice } from "@/components/patterns/inline-notice";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { ModelProfileEditor } from "./model-profile-editor";

const API_NAMES = [
  "OpenAI Chat Completions",
  "OpenAI Responses",
  "Anthropic Messages",
  "Google Gemini",
];
type Candidate = ModelCandidate & { maxTokensField?: "max_tokens" | "max_completion_tokens" };

export function ProviderForm({
  initial,
  onClose,
  onSaved,
}: {
  initial?: ProviderInfo;
  onClose: () => void;
  onSaved: () => void;
}) {
  const custom = initial?.config.kind === "custom" ? initial.config : undefined;
  const [source, setSource] = useState(custom ? "custom" : (initial?.config.id ?? ""));
  const [name, setName] = useState(custom?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(custom?.baseUrl ?? "");
  const [api, setApi] = useState(custom?.api ?? MODEL_APIS[0]);
  const [apiKey, setApiKey] = useState("");
  const [options, setOptions] = useState(
    initial?.config.kind === "builtin" ? initial.config.options : {},
  );
  const [models, setModels] = useState<Candidate[]>(custom?.models ?? []);
  const [manualId, setManualId] = useState("");
  const [error, setError] = useState<string>();
  const catalog = useQuery(rpc.providers.catalog.queryOptions());
  const save = useMutation(rpc.providers.save.mutationOptions());
  const discover = useMutation(rpc.providers.discover.mutationOptions());
  const selected = catalog.data?.find(({ id }) => id === source);
  const draft = (profiles: Candidate[] = []): ProviderWrite => ({
    config:
      source === "custom"
        ? {
            kind: "custom",
            ...(custom ? { id: custom.id } : {}),
            name,
            baseUrl,
            api,
            models: profiles.map((model) =>
              modelProfileSchema.parse({ ...model, name: model.name.trim() || model.id }),
            ),
          }
        : { kind: "builtin", id: source, options },
    ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    try {
      const input = draft(models);
      setError(undefined);
      save.mutate(input, {
        onSuccess: () => {
          setApiKey("");
          onSaved();
        },
      });
    } catch {
      setError(C.invalidLimits);
    }
  };
  const refresh = () => {
    setError(undefined);
    discover.mutate(draft(), {
      onSuccess: (candidates) =>
        setModels((current) => [
          ...new Map([...candidates, ...current].map((model) => [model.id, model])).values(),
        ]),
    });
  };
  const failure =
    error ??
    (save.error
      ? apiErrorMessage(save.error)
      : discover.error
        ? apiErrorMessage(discover.error)
        : catalog.error
          ? apiErrorMessage(catalog.error)
          : undefined);
  return (
    <FormDialog
      open
      title={C.connect}
      onOpenChange={(open) => {
        if (!open && !save.isPending) onClose();
      }}
      onSubmit={submit}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose} disabled={save.isPending}>
            {COPY.cancel}
          </Button>
          <AsyncButton
            type="submit"
            pending={save.isPending}
            disabled={!source || (!initial && !apiKey.trim())}
          >
            {C.saveProvider}
          </AsyncButton>
        </>
      }
    >
      <div className="space-y-5">
        <Field>
          <FieldLabel htmlFor="provider-source">{C.provider}</FieldLabel>
          <NativeSelect
            id="provider-source"
            disabled={!!initial}
            value={source}
            onChange={(event) => {
              setSource(event.target.value);
              setOptions({});
            }}
          >
            <option value="" disabled>
              {C.provider}
            </option>
            {catalog.data?.map(({ id, name }) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
            <option value="custom">{C.custom}</option>
          </NativeSelect>
        </Field>
        {source === "custom" && (
          <>
            <Field>
              <FieldLabel htmlFor="provider-name">Name</FieldLabel>
              <Input
                id="provider-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={256}
                required
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="provider-api">{C.protocol}</FieldLabel>
              <NativeSelect
                id="provider-api"
                value={api}
                onChange={(event) => {
                  const value = MODEL_APIS.find((item) => item === event.target.value);
                  if (value) setApi(value);
                }}
              >
                {MODEL_APIS.map((value, index) => (
                  <option key={value} value={value}>
                    {API_NAMES[index]}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field>
              <FieldLabel htmlFor="provider-url">{C.baseUrl}</FieldLabel>
              <Input
                id="provider-url"
                type="url"
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                required
              />
            </Field>
          </>
        )}
        {selected?.fields.map((field) => (
          <Field key={field.name}>
            <FieldLabel htmlFor={field.name}>{field.label}</FieldLabel>
            <Input
              id={field.name}
              value={options[field.name] ?? ""}
              required={field.required}
              placeholder={field.placeholder}
              onChange={(event) =>
                setOptions((current) => ({ ...current, [field.name]: event.target.value }))
              }
            />
          </Field>
        ))}
        {source && (
          <Field>
            <FieldLabel htmlFor="provider-key">{C.apiKey}</FieldLabel>
            <Input
              id="provider-key"
              type="password"
              autoComplete="off"
              value={apiKey}
              placeholder={initial?.hasApiKey ? C.keepKey : undefined}
              required={!initial?.hasApiKey}
              onChange={(event) => setApiKey(event.target.value)}
            />
            {initial?.hasApiKey && (
              <span className="text-xs text-muted-foreground">{C.keySaved}</span>
            )}
          </Field>
        )}
        {source === "custom" && (
          <div className="space-y-4">
            {api.startsWith("openai-") && (
              <AsyncButton
                type="button"
                variant="outline"
                pending={discover.isPending}
                disabled={!name || !baseUrl || (!apiKey && !initial)}
                onClick={refresh}
              >
                {C.refresh}
              </AsyncButton>
            )}
            <Field>
              <FieldLabel htmlFor="manual-model-id">{C.id}</FieldLabel>
              <div className="flex gap-2">
                <Input
                  id="manual-model-id"
                  value={manualId}
                  onChange={(event) => setManualId(event.target.value)}
                  maxLength={256}
                />
                <Button
                  type="button"
                  variant="outline"
                  disabled={!manualId.trim()}
                  onClick={() => {
                    const id = manualId.trim();
                    if (!models.some((model) => model.id === id))
                      setModels((current) => [...current, { id, name: id }]);
                    setManualId("");
                  }}
                >
                  {C.manual}
                </Button>
              </div>
            </Field>
            {models.map((model) => (
              <div key={model.id} className="rounded-lg border border-border p-3">
                <ModelProfileEditor
                  model={model}
                  onChange={(next) =>
                    setModels((current) =>
                      current.map((item) => (item.id === next.id ? next : item)),
                    )
                  }
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="mt-2"
                  onClick={() =>
                    setModels((current) => current.filter((item) => item.id !== model.id))
                  }
                >
                  Remove model
                </Button>
              </div>
            ))}
          </div>
        )}
        {failure && <InlineNotice>{failure}</InlineNotice>}
      </div>
    </FormDialog>
  );
}
