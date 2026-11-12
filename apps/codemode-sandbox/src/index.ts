export { CodemodeSandboxDurableObject } from "@earendil-works/pi-codemode/cloudflare";

export default {
  fetch: () => new Response(null, { status: 404 }),
};
