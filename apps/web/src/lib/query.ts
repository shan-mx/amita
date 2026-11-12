import { QueryClient } from "@tanstack/react-query";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { api } from "./api";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      networkMode: "always",
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    },
    mutations: { retry: false, networkMode: "always" },
  },
});

export const rpc = createTanstackQueryUtils(api, { path: ["owner"] });
export const authRpc = createTanstackQueryUtils(api.auth, { path: ["auth"] });
