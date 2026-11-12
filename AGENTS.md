# Amita Engineering Principles

Amita is built on Pi Durable and the Cloudflare Agents SDK, **following Pi's native philosophy of agent behavior, storage, and execution**.

## Core Principles

1. **Minimal Runtime**

   Pi Durable owns the agent core, while the Cloudflare Agents SDK and platform provide runtime and infrastructure capabilities. Prefer upstream primitives and preserve their native behavior and defaults.

2. **Capability over Integration**

   Amita focuses on cloud persistence, device access, and composable capabilities such as Channels, Automations, and Code Mode. Extend peripheral agent capabilities through CLI and MCP rather than embedding them into the Amita runtime.

3. **Lightweight & Focused**

   Pursue an architecture with **minimal concepts, short execution paths, and clear ownership**. When designing new features, first consider the existing primitives of Pi Durable, the Cloudflare Agents SDK, the Cloudflare platform, and Amita itself. Favor reuse and composition.

For current architecture and tool contracts, see docs/architecture.md and docs/tools.md.
