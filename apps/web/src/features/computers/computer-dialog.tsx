import { apiErrorMessage } from "@/lib/api-error";
import { useEffect, useState } from "react";
import { CONFIG } from "@amita/backend/config";
import { COPY } from "@/lib/copy";
import { validComputerSlug } from "@amita/backend/computer";
import type { api } from "@/lib/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { rpc } from "@/lib/query";
import { Button } from "@/components/ui/button";
import { FormDialog } from "@/components/patterns/form-dialog";
import { AsyncButton } from "@/components/patterns/async-button";
import { InlineNotice } from "@/components/patterns/inline-notice";
import { Input } from "@/components/ui/input";
import { Field, FieldLabel } from "@/components/ui/field";

type PendingComputer = Awaited<ReturnType<typeof api.computer.status>>["pending"][number];
type Computer = Awaited<ReturnType<typeof api.computer.status>>["computers"][number];

export function ComputerDialog({ onClose }: { onClose: () => void }) {
  const client = useQueryClient();
  const [clipboardError, setError] = useState<string>();
  const [now, setNow] = useState(Date.now);
  const generate = useMutation(rpc.computer.registration.mutationOptions());
  const issuedRegistration = generate.data;
  const status = useQuery(
    rpc.computer.status.queryOptions({
      input: issuedRegistration ? { registrationId: issuedRegistration.id } : undefined,
      refetchInterval: CONFIG.pairingPollMs,
    }),
  );
  const revokeMutation = useMutation(
    rpc.computer.revoke.mutationOptions({
      onSuccess: () => client.invalidateQueries({ queryKey: rpc.computer.status.key() }),
    }),
  );
  const registrationInactive =
    status.data?.registrationActive === false && Boolean(issuedRegistration);
  const registration = registrationInactive ? undefined : issuedRegistration;
  const computers = status.data?.computers;
  const pending = status.data?.pending ?? [];
  const loading = status.isPending;
  const generating = generate.isPending;
  const revokingId = revokeMutation.isPending ? revokeMutation.variables.deviceId : undefined;
  const notice = revokeMutation.isSuccess ? "Connection revoked." : undefined;
  const error =
    clipboardError ??
    (generate.error || status.error || revokeMutation.error ? COPY.requestFailed : undefined);
  const command = registration
    ? `amita-companion pair --server ${window.location.origin} --code ${registration.code}`
    : undefined;
  const expired = Boolean(registration && now >= registration.expiresAt);
  useEffect(() => {
    if (!issuedRegistration) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [issuedRegistration]);
  const generateCode = () => {
    setError(undefined);
    revokeMutation.reset();
    generate.mutate(undefined, { onSuccess: () => setNow(Date.now()) });
  };
  const revoke = (computer: Computer) => {
    setError(undefined);
    revokeMutation.mutate({ deviceId: computer.id });
  };
  const copyText = async (value: string) => {
    setError(undefined);
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      setError(COPY.requestFailed);
    }
  };

  return (
    <FormDialog
      open
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
      title={COPY.computer}
    >
      <div className="space-y-5">
        <AsyncButton type="button" onClick={generateCode} pending={generating} disabled={loading}>
          {generating ? COPY.loading : "Generate registration code"}
        </AsyncButton>
        {loading && !computers && !registration && (
          <p className="text-sm text-muted-foreground">{COPY.loading}</p>
        )}
        {computers?.length === 0 && !registration && pending.length === 0 && (
          <p className="text-sm text-muted-foreground">No computers connected.</p>
        )}
        {pending.map((computer) => (
          <PairingConfirmation key={computer.id} computer={computer} />
        ))}
        {computers?.map((computer) => (
          <div
            key={computer.id}
            className="flex flex-wrap items-start justify-between gap-3 border-t border-border pt-4"
          >
            <div className="min-w-0 max-w-full space-y-1">
              <p className="break-words text-sm font-medium">{computer.name}</p>
              <p className="text-sm text-muted-foreground">
                {computer.online ? COPY.computerOnline : COPY.computerOffline}
              </p>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                <span>Computer Slug</span>
                <code className="break-all">{computer.slug}</code>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void copyText(computer.slug)}
                >
                  Copy Slug
                </Button>
              </div>
            </div>
            <AsyncButton
              type="button"
              variant="outline"
              className="self-start"
              onClick={() => revoke(computer)}
              pending={revokingId === computer.id}
              disabled={Boolean(revokingId)}
            >
              {revokingId === computer.id ? COPY.loading : "Revoke connection"}
            </AsyncButton>
          </div>
        ))}
        {registrationInactive && (
          <p className="text-sm text-muted-foreground">Registration code is no longer active.</p>
        )}
        {registration && (
          <div className="space-y-4 rounded-xl border border-border p-4">
            {expired ? (
              <>
                <InlineNotice>Registration code expired. Generate a new code.</InlineNotice>
                <time
                  className="text-xs text-muted-foreground"
                  dateTime={new Date(registration.expiresAt).toISOString()}
                >
                  Code expires at {new Date(registration.expiresAt).toLocaleTimeString()}.
                </time>
              </>
            ) : (
              <>
                <div className="space-y-1 text-sm">
                  <p className="font-medium">Run on the computer you’re pairing:</p>
                  <time
                    className="text-xs text-muted-foreground"
                    dateTime={new Date(registration.expiresAt).toISOString()}
                  >
                    Code expires at {new Date(registration.expiresAt).toLocaleTimeString()}.
                  </time>
                </div>
                <pre className="overflow-x-auto rounded-xl border border-border bg-muted/50 p-3 text-xs leading-relaxed break-all whitespace-pre-wrap">
                  {command}
                </pre>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void copyText(command ?? "")}
                >
                  Copy command
                </Button>
                <p className="text-sm text-muted-foreground">Waiting for Companion…</p>
              </>
            )}
          </div>
        )}
        {notice && <p className="text-sm text-muted-foreground">{notice}</p>}
        {error && <InlineNotice>{error}</InlineNotice>}
      </div>
    </FormDialog>
  );
}

function PairingConfirmation({ computer }: { computer: PendingComputer }) {
  const client = useQueryClient();
  const [slug, setSlug] = useState(computer.suggestedSlug);
  const [validationError, setError] = useState<string>();
  const refresh = () => client.invalidateQueries({ queryKey: rpc.computer.status.key() });
  const confirm = useMutation(rpc.computer.confirm.mutationOptions({ onSuccess: refresh }));
  const revoke = useMutation(rpc.computer.revoke.mutationOptions({ onSuccess: refresh }));
  const busy = confirm.isPending || revoke.isPending;
  const failure = confirm.error ?? revoke.error;
  const error = validationError ?? (failure ? apiErrorMessage(failure) : undefined);
  const submit = (cancel = false) => {
    if (busy) return;
    if (!cancel && !validComputerSlug(slug)) {
      setError(COPY.computerSlugInvalid);
      return;
    }
    setError(undefined);
    if (cancel) revoke.mutate({ deviceId: computer.id });
    else confirm.mutate({ deviceId: computer.id, slug });
  };
  return (
    <form
      className="space-y-3 rounded-xl border border-border p-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <h3 className="text-sm font-medium">Confirm this computer</h3>
      <p className="text-sm break-words">
        <span className="text-muted-foreground">Device name: </span>
        {computer.name}
      </p>
      <Field>
        <FieldLabel htmlFor={`computer-slug-${computer.id}`}>Computer Slug</FieldLabel>
        <Input
          id={`computer-slug-${computer.id}`}
          value={slug}
          onChange={(event) => setSlug(event.target.value)}
          maxLength={CONFIG.computerSlugMaxLength}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          disabled={busy}
          required
        />
      </Field>
      <p className="text-xs text-muted-foreground">
        Use 1–32 lowercase letters, numbers, or hyphens. Start and end with a letter or number.
      </p>
      <p className="text-xs text-muted-foreground">
        This Slug stays with this computer and cannot be reused after revocation.
      </p>
      <time
        className="block text-xs text-muted-foreground"
        dateTime={new Date(computer.expiresAt).toISOString()}
      >
        Confirm by {new Date(computer.expiresAt).toLocaleTimeString()}.
      </time>
      <div className="flex flex-wrap gap-2">
        <AsyncButton type="submit" pending={busy}>
          {busy ? COPY.loading : "Confirm pairing"}
        </AsyncButton>
        <AsyncButton type="button" variant="outline" pending={busy} onClick={() => submit(true)}>
          Cancel pairing
        </AsyncButton>
      </div>
      {error && <InlineNotice>{error}</InlineNotice>}
    </form>
  );
}
