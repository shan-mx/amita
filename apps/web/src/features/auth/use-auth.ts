import { useCallback, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { authRpc, rpc } from "@/lib/query";
import { COPY } from "@/lib/copy";

export function useAuth() {
  const client = useQueryClient();
  const status = useQuery(authRpc.status.queryOptions({ staleTime: Infinity }));
  const [notice, setNotice] = useState<string>();
  const clearOwner = useCallback(() => {
    void client.cancelQueries({ queryKey: rpc.key() });
    client.removeQueries({ queryKey: rpc.key() });
  }, [client]);
  const expired = useCallback(() => {
    clearOwner();
    setNotice(COPY.expired);
    client.setQueryData(authRpc.status.queryKey(), (current) => ({
      configured: current?.configured ?? true,
      authenticated: false,
    }));
  }, [client, clearOwner]);
  useEffect(() => {
    window.addEventListener("amita:expired", expired);
    return () => window.removeEventListener("amita:expired", expired);
  }, [expired]);
  const logout = useMutation(
    authRpc.logout.mutationOptions({
      onSuccess: () => {
        clearOwner();
        setNotice(undefined);
        client.setQueryData(authRpc.status.queryKey(), (current) => ({
          configured: current?.configured ?? true,
          authenticated: false,
        }));
      },
    }),
  );
  const resetLogout = logout.reset;
  const signedIn = useCallback(() => {
    void client.cancelQueries({ queryKey: authRpc.status.key() });
    clearOwner();
    resetLogout();
    setNotice(undefined);
    client.setQueryData(authRpc.status.queryKey(), { configured: true, authenticated: true });
  }, [client, clearOwner, resetLogout]);
  return {
    status: status.data,
    notice,
    error: status.error || logout.error ? COPY.requestFailed : undefined,
    expired,
    signedIn,
    logout: () => logout.mutate(),
  };
}
