# Frontend maintenance

The web app in `apps/web` uses React, assistant-ui, TanStack Query, Tailwind CSS, and shadcn components built on Base UI.

## Code layout

| Location under `src/`   | Responsibility                                                             |
| ----------------------- | -------------------------------------------------------------------------- |
| `app/`                  | Composition, layout, navigation, sidebar, and overlays                     |
| `features/`             | Auth, Agents, chat, Sessions, Computers, Memory, Automations, and Channels |
| `components/ui/`        | shadcn / Base UI primitives                                                |
| `components/patterns/`  | FormDialog, AsyncButton, IconButton, and InlineNotice                      |
| `components/brand/`     | Logo                                                                       |
| `lib/`                  | Typed API, query client, and shared utilities                              |
| `styles/`, `styles.css` | Tokens, global styles, navigation, and branding                            |
| `main.tsx`              | React and providers                                                        |

Dependencies flow from `app` through features to shared patterns and primitives. Features use props and callbacks to communicate with the app. The web owns interface copy; the backend owns API validation messages and tool diagnostics. Extract components or hooks at distinct state boundaries or shared use sites.

## State ownership

| State                                             | Owner                                                                     |
| ------------------------------------------------- | ------------------------------------------------------------------------- |
| Sign-in, expiration, and Owner cache lifetime     | `features/auth/use-auth`                                                  |
| Lists, selection, archive filter, and URL         | `app/use-navigation`                                                      |
| Open editors and their resource identity          | `app/use-overlays`                                                        |
| Dialog layout and focus                           | `app/app-shell`, `components/patterns/form-dialog`                        |
| Chat connection, history, and reconnection        | `features/chat/use-session`                                               |
| Native Pi event state                             | `features/chat/session-state`                                             |
| assistant-ui projection                           | `features/chat/runtime-adapter`                                           |
| Draft, IME, sending, and resize                   | `features/chat/composer`                                                  |
| Message and tool rendering                        | `features/chat/messages`, `features/chat/tool-card`                       |
| Automation drafts, time zones, and run pagination | `features/automations/use-automations`, `features/automations/form-state` |

Server data uses the official oRPC TanStack adapter in `lib/query`: `queryOptions`, `infiniteOptions`, and `mutationOptions`. Keys include resource identity. Pass cancellation through the adapter, then update or invalidate affected caches after writes. React owns drafts, selection, and dialog state.

Auth has a separate cache namespace. Logout or expiration removes Owner queries and unmounts the authenticated page; login starts a fresh cache. Requests fail without automatic retries or offline mutation replay. Computer and Automation polling belongs to open dialogs; the chat does not poll devices.

Chat history belongs to Pi's ConversationTranscript and `use-session`. Failed drafts retain their operation ID for unchanged manual retries. Late callbacks invalidate the captured Agent and archive-filter key. Native snapshots and `session_changed` refresh Session lists; navigation updates URL parameters with `replaceState`.

## Add or update components

Use the existing [component configuration](../apps/web/components.json), then review generated source and dependency changes:

```sh
pnpm --filter @amita/web exec shadcn add badge
```

Use `Button` for actions, `AsyncButton` for pending actions, `IconButton` for labeled icon controls, and `Field` with an explicitly associated label for inputs. `InlineNotice` presents errors. Checkbox drafts, including Automation's **Enabled**, save with their form.

`FormDialog` provides a fixed title, one scrolling body, and an optional fixed footer, with `sm`, `default`, or `wide` sizing. With `onSubmit`, its root is a form; for a separate body form, link the footer button using the native `form` attribute. The feature controls whether a pending save permits closing.

Base UI triggers use `render={<Button />}` to avoid nested buttons; assistant-ui Copy uses `asChild`. Preserve local adaptations when updating generated source. Use Lucide icons and `gap-2` (8px) between icons and labels. Keep the [shadcn MIT notice](../apps/web/src/components/ui/LICENSE.md); Geist fonts from `@fontsource-variable` use SIL OFL 1.1.

## Visual styling

Use semantic colors from `styles/tokens.css` and `--font-sans` / `--font-mono`. Light and dark modes follow the system. Global styles own resets, fonts, focus, and reduced motion; chat Markdown lives in `features/chat/markdown.css`.

Minimum sizes: 13px supporting text, 14px controls and lists, 16px chat text, 40px controls, and 44px touch targets and primary menu actions. Check normal-text contrast against the background at 4.5:1 or better. Provide visible focus and pending states, transition only changing properties, and respect `prefers-reduced-motion`. Keep the mobile composer within the safe area and long dialog actions reachable by scrolling.

## Verification

See [development checks](getting-started.md#development-checks). For browser regressions:

```sh
pnpm exec playwright install chromium
pnpm test:web
```

Tests start a server on port 5190. Set `AMITA_TEST_ORIGIN` to reuse a test server. Artifacts go to `.scratch/playwright-results`; controlled-response tests reproduce timing and navigation cases.

For visual changes, check the affected flows in the live app at 1440×1000 and 390×844, in both themes: keyboard and touch navigation, nested dialog focus and Escape handling, long forms and pending states, chat reconnection and IME, or Automation modes and time zones as applicable. Use isolated state and temporary data. Record revision, viewport, theme, and data source with screenshots; distinguish controlled fixtures from live-service evidence.
