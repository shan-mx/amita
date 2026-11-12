import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { ProviderInfo } from "@amita/backend/types";
import { rpc } from "@/lib/query";
import { COPY } from "@/lib/copy";
import { apiErrorMessage } from "@/lib/api-error";
import { FormDialog } from "@/components/patterns/form-dialog";
import { InlineNotice } from "@/components/patterns/inline-notice";
import { Button } from "@/components/ui/button";
import { MODEL_COPY as C } from "./copy";
import { ProviderForm } from "./provider-form";
import { AsyncButton } from "@/components/patterns/async-button";

type Action =
  | { type: "edit"; provider?: ProviderInfo }
  | { type: "remove"; provider: ProviderInfo };

export function ProvidersDialog({
  providers,
  onClose,
  onSaved,
}: {
  providers: ProviderInfo[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [action, setAction] = useState<Action>();
  const catalog = useQuery(rpc.providers.catalog.queryOptions());
  const remove = useMutation(rpc.providers.remove.mutationOptions({ onSuccess: onSaved }));
  const providerName = (provider: ProviderInfo) =>
    provider.config.kind === "custom"
      ? provider.config.name
      : (catalog.data?.find(({ id }) => id === provider.config.id)?.name ?? provider.config.id);
  if (action?.type === "edit")
    return (
      <ProviderForm
        initial={action.provider}
        onClose={() => setAction(undefined)}
        onSaved={onSaved}
      />
    );
  if (action?.type === "remove")
    return (
      <FormDialog
        open
        title={C.removeProvider}
        onOpenChange={(open) => {
          if (!open && !remove.isPending) setAction(undefined);
        }}
        footer={
          <>
            <Button
              type="button"
              variant="ghost"
              disabled={remove.isPending}
              onClick={() => setAction(undefined)}
            >
              {COPY.cancel}
            </Button>
            <AsyncButton
              type="button"
              variant="destructive"
              pending={remove.isPending}
              onClick={() => remove.mutate({ id: action.provider.config.id })}
            >
              {C.removeProvider}
            </AsyncButton>
          </>
        }
      >
        <p className="text-sm">{C.removeConfirm(providerName(action.provider))}</p>
        {remove.error && (
          <InlineNotice className="mt-3">
            {apiErrorMessage(remove.error, COPY.requestFailed)}
          </InlineNotice>
        )}
      </FormDialog>
    );
  return (
    <FormDialog
      open
      title={C.settings}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button type="button" onClick={() => setAction({ type: "edit" })}>
            {C.connect}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {!providers.length && <p className="text-sm text-muted-foreground">{C.noProvider}</p>}
        {providers.map((provider) => {
          const name = providerName(provider);
          return (
            <div
              key={provider.config.id}
              className="flex items-center gap-3 rounded-lg border border-border p-3"
            >
              <button
                type="button"
                className="min-w-0 flex-1 text-left text-sm font-medium"
                onClick={() => setAction({ type: "edit", provider })}
              >
                {name}
              </button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={remove.isPending}
                onClick={() => setAction({ type: "remove", provider })}
              >
                {C.removeProvider}
              </Button>
            </div>
          );
        })}
        {remove.error && (
          <InlineNotice>{apiErrorMessage(remove.error, COPY.requestFailed)}</InlineNotice>
        )}
      </div>
    </FormDialog>
  );
}
