# Tools and execution

The model can call `codemode`, `fs_read`, and `bash` directly. Other tools are called through Code Mode; scripts can also call `fs_read` and `bash`. [Pair a Companion](getting-started.md#pair-and-run-the-companion) before working with computer files or commands.

<a name="computer-and-workspace"></a>

## Computers and workspaces

`computer_list({})` returns paired Computer Slugs and online status. Use a Slug for shell commands and complete virtual paths for files:

| Operation                    | Example                                                     |
| ---------------------------- | ----------------------------------------------------------- |
| Run a command                | `await tools.bash({ computer: "macbook", command: "pwd" })` |
| Read Agent memory            | `/internal/MEMORY.md`                                       |
| Access an Agent workspace    | `/computers/macbook/workspace/notes.md`                     |
| Access an absolute host path | `/computers/macbook/fs/Users/USER/project/notes.md`         |

Each Agent's computer workspace is `~/.amita/workspaces/<agent-slug>/`, created on demand. Bash defaults to it; `cwd` selects another directory. Operations run with the Companion OS user's permissions. Workspace `..` paths cannot escape the mount root.

## File operations

`/internal` contains files shared by the Agent's sessions. The same tools also operate on computer mounts.

| Tool                             | Behavior                                                                       |
| -------------------------------- | ------------------------------------------------------------------------------ |
| `fs_read`, `fs_write`, `fs_edit` | Native Pi text/image reads, writes, and edits                                  |
| `fs_list`                        | Directory entries with pagination                                              |
| `fs_glob`, `fs_grep`             | Path matching and content search                                               |
| `fs_mkdir`, `fs_remove`          | Directory creation and removal; nonempty directories require `recursive: true` |

Removing a symlink removes the link. Search results with `truncated` are incomplete. Overlapping Companion filesystem mutations fail immediately with `conflict`, even on different paths; the rejected call writes nothing. Workspace initialization also counts as a mutation.

## Skills

Save skills under `/internal/skills/<name>/SKILL.md`, starting with YAML `name` and `description` fields, followed by Markdown instructions. Put referenced files beside the skill and use relative paths. Sessions receive an index; the model reads skills as needed. Set `disable-model-invocation: true` in the metadata to hide a skill from that index.

## Code Mode

`codemode` runs JavaScript in the Sandbox Worker's QuickJS runtime. Scripts call tools through `tools`; model calls inside scripts are disabled.

```js
// @options: {"timeout_ms": 60000, "max_output_tokens": 2000}
const paths = ["/computers/macbook/workspace/src/a.ts", "/computers/macbook/workspace/src/b.ts"];
const files = await Promise.all(paths.map((path) => tools.fs_read({ path })));
return files.map((text, index) => ({
  path: paths[index],
  todos: (text.match(/\bTODO\b/g) ?? []).length,
}));
```

Text `fs_read` returns a string; `fs_list` returns `{ entries, nextCursor? }`. Bash returns `{ output, exitCode }` and, for output saved to a file, `fullOutputPath`. Check `exitCode` even when the tool returns normally. Use `try/catch` for thrown errors, and `text()` or `return` for script output. `store()` / `load()` belong to the current conversation; write files with `fs_write` for persistent reports.

`bash.timeout` is optional and measured in seconds. Script `timeout_ms` covers the whole script in milliseconds; file transfers have their own request deadline. Tool cards retain scripts, calls, and bounded output through Pi history. [Limits](../packages/backend/src/shared/config.ts)

Offline calls return `computer_offline`. Interrupted reads can be repeated. A running Bash command can resume output on reconnection to the same Companion process. Pi reuses committed results during recovery. For `interrupted` or `unknown` side effects, inspect the actual file or process before retrying.

<a name="automations"></a>

## Automations

Open **Automations → New automation**. Choose a one-time trigger or a five-field cron expression and confirm the time zone. The form defaults to the browser's zone; the tool uses the session zone unless `job.timezone` is supplied.

Fill in **Message**, **JavaScript**, or both in one form. A message starts an Agent turn; JavaScript runs without a model when no message is present. When both are supplied, the script returns `{ runAgent: boolean, context?: JSON }` to decide whether the Agent runs and provide its context.

For a first run, leave **Message** empty, enter `return { ok: true };` in **JavaScript**, schedule it a few minutes ahead, and leave **Enabled** checked. Inspect **Run history** after the trigger. Conditional `runAgent: false` produces **Skipped**; a missing or malformed conditional result is an error. Plain JavaScript may return nothing.

Message tasks select a **Session**. **New session for each run** creates a separate visible conversation with the Agent model by default. Set `job.execution.model` to `{provider, modelId}` to select another model. The run keeps that model reference. Selecting an existing Session uses its history, baseline and ordinary model rules; it does not override the model or create another conversation. Archived Sessions remain selectable. A busy Session rejects the automation's input instead of queuing or steering existing work. **Stop** cancels the automation's active input and its native Agent turn, including any manual steer that joined that turn; it leaves later independent turns alone.

Results stay in the execution Session or, for script-only tasks, in run history. To send elsewhere, include destination IDs and instructions in the message or script and use tools such as `channel_send`.

Each run uses the configuration captured when accepted. Editing, pausing, or deleting affects future triggers. **Stop** cancels active work; deletion retains run history and the ability to stop by Automation ID. Resuming skips triggers missed while paused. After Worker downtime, only the latest missed trigger runs. Each Automation runs once at a time, with overlapping triggers coalesced into one pending run.

Scripts and prompts use the Agent's tools and authorized computers. Pi owns recovery and records native errors and output; failed work is rerun at the Owner's discretion. In script-only Automations, `store()` / `load()` last only for that run.

The `automation` tool uses `list`, `get`, `create`, `update`, `remove`, `stop`, and `history`. Create with `job`, update with `id` and `job`, and set `job.enabled` to pause or resume. Use `job.execution: { kind: "new_session" }` to start fresh each run, or `{ kind: "existing_session", sessionId }` to continue a conversation. The tool accepts `"current"` as the calling Session ID. Omitting execution uses a new Session for new message tasks and preserves the target on update. An update can replace the execution object or clear it with `null`. Script-only tasks omit execution. [Tool contract](../packages/backend/src/automations/automation-tools.ts)

## Memory, history, and session control

- Persona and Memory live in `/internal/PERSONA.md` and `/internal/MEMORY.md`. Edit them in the app or with file tools; empty content clears them.
- Sessions capture Persona, Memory, and Computer and Skills indexes at creation and after compaction. File tools and `computer_list` read current data.
- **Search sessions** and `session_search` search the Agent's user and assistant messages, including archived sessions. Archiving retains history; the search index can be rebuilt.
- **Stop** cancels the current run and queued input. Input during a run uses Pi steer. **Retry** resumes work paused by Pi's repeated-crash protection.

<a name="channels"></a>

## Channels

| Tool                                                       | Use                                                                                                                           |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `channel_list({ query?, offset? })`                        | Find authorized chats and Topics; `id` selects a destination and `canSend` reports availability                               |
| `channel_download({ attachmentId, computer })`             | Import a conversation attachment into `attachments/<attachmentId>/` in the selected Computer workspace; retain existing files |
| `channel_send({ text?, files?, target?, destinationId? })` | Send text, complete virtual file paths, or both                                                                               |

Use `target: "current"` only when all inputs admitted to the current turn share one channel target. From Web, select `destinationId`. Partial deliveries retain confirmed receipts; check Telegram before retrying an unknown send.

For Automation delivery, record the destination ID and instructions to call `channel_send` in the task's message or script. An isolated run uses its saved instructions rather than the conversation that created it. The sending tool returns the delivery outcome. [Channel behavior](channels.md) · [Connect Telegram](deployment.md#connect-telegram)
