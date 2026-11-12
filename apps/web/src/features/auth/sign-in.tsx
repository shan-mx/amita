import { ORPCError } from "@orpc/client";
import { apiErrorMessage } from "@/lib/api-error";
import { useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { authRpc } from "@/lib/query";
import { COPY } from "@/lib/copy";
import { Logo } from "@/components/brand/logo";
import { Input } from "@/components/ui/input";
import { FieldLabel } from "@/components/ui/field";
import { AsyncButton } from "@/components/patterns/async-button";
import { InlineNotice } from "@/components/patterns/inline-notice";

export function SignIn({
  configured,
  notice,
  onLogin,
}: {
  configured: boolean;
  notice?: string;
  onLogin: () => void;
}) {
  const [password, setPassword] = useState("");
  const login = useMutation(authRpc.login.mutationOptions());
  const busy = login.isPending;
  const failure = login.error;
  const code = failure instanceof ORPCError ? failure.code : undefined;
  const error = failure
    ? code === "UNAUTHORIZED" || code === "TOO_MANY_REQUESTS" || code === "SERVICE_UNAVAILABLE"
      ? apiErrorMessage(failure)
      : COPY.requestFailed
    : undefined;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    login.mutate(
      { password },
      {
        onSuccess: () => {
          setPassword("");
          onLogin();
        },
      },
    );
  };
  return (
    <main className="flex min-h-dvh items-center justify-center px-6 py-12">
      <div className="w-full max-w-sm">
        <h1 className="mb-8">
          <Logo />
        </h1>
        <form onSubmit={submit} className="space-y-5">
          <div className="space-y-2">
            <FieldLabel htmlFor="owner-password">Owner password</FieldLabel>
            <Input
              id="owner-password"
              type="password"
              autoComplete="current-password"
              autoFocus
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={!configured}
            />
          </div>
          {(!configured || error || notice) && (
            <InlineNotice>{!configured ? COPY.configuration : (error ?? notice)}</InlineNotice>
          )}
          <AsyncButton
            pending={busy}
            type="submit"
            className="w-full"
            disabled={busy || !configured || !password}
          >
            {busy ? "Signing in…" : "Sign in"}
          </AsyncButton>
        </form>
      </div>
    </main>
  );
}
