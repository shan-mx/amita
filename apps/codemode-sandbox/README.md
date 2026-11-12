# Code Mode Sandbox Worker

This Worker hosts Pi's QuickJS Durable Object. The main Worker calls it through `CODEMODE_SANDBOX`; the Agent's Pi runtime owns tasks and history.

Run `pnpm dev` from the [repository root](../../README.md) to start both services. Worker tests use the built Sandbox. See [deployment](../../docs/deployment.md) for production setup.
