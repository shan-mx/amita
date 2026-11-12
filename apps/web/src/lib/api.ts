import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ApiClient } from "@amita/backend/types";

export const api: ApiClient = createORPCClient(
  new RPCLink({
    url: `${window.location.origin}/api/rpc`,
    fetch: async (request, init) => {
      const response = await fetch(request, { ...init, credentials: "same-origin" });
      if (
        response.status === 401 &&
        !String(request instanceof Request ? request.url : request).includes("/auth/login")
      )
        window.dispatchEvent(new Event("amita:expired"));
      return response;
    },
  }),
);
