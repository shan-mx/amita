# Channels

Channels connect platform chats to Agent conversations. Pi owns model turns, tools, history, admission, queueing, cancellation, and recovery. Channels translate incoming messages and publish committed output. [Setup](deployment.md#connect-telegram) · [Tools](tools.md#channels)

## Connections and destinations

A **Connection** identifies a platform account, such as a Telegram bot. A **Destination** identifies a chat or Topic and holds its Pi Conversation binding. `/new` starts a Conversation at the same destination; `/stop` cancels the current run and queued input. The web app can continue the same Conversation. Quoted messages are included in incoming context.

The deployment pairs one Owner identity across its bots. Connections support connect, pair, and disconnect. Connecting installs the webhook; overlapping connection operations fail immediately. Channel sessions currently use UTC.

## Telegram conversations

Existing Topics have independent conversations. A message in the main private chat creates a Topic when the bot supports Topic creation; otherwise it stays in the main chat. Session naming also updates the linked Topic and destination label. The title is saved before the external rename, so a rename failure keeps the generated title.

Replies to incoming Channel messages publish completed assistant text and top-level tool names and inputs in transcript order as permanent messages. Code Mode shows its script rather than nested calls. Typing status is refreshed during processing. Independent Web and Automation turns in the same Session do not automatically publish to the Channel; use `channel_send` to send their results.

## Attachments

Incoming messages store attachment references. `channel_download` imports the selected attachment into a registered Computer's Agent workspace and returns its virtual path. Import removes temporary files on failure and publishes the completed file without overwriting an existing file. An interrupted result is reported as unknown.

`channel_send` sends text and file paths. Files keep their names and are read at send time, including metadata used for the upload. The Delivery Task owns the destination and selected paths. The Computer forwards Companion JSON frames, and the Agent validates their payloads.

## Delivery and retention

Automations use the ordinary sending tools. Record destination IDs and delivery instructions in the automation's message or script; `channel_send` returns the delivery outcome. The Automation runtime keeps results in the execution Session and run history.

Pi Tasks own prepared message parts, confirmed receipts, cancellation, and bounded Telegram rate-limit retries. An unknown send is not automatically repeated. Check Telegram before retrying; delivery failures do not create a separate notification task.

| Record                        | Lifetime                                                               |
| ----------------------------- | ---------------------------------------------------------------------- |
| Pending inbox payload         | Released after handoff to Pi                                           |
| Inbound deduplication receipt | 48 hours; expired receipts are pruned on new updates                   |
| Reply publication identity    | Retained while pending input or answer work can enqueue the same Entry |
| Attachment reference          | Follows its originating Conversation                                   |
| Delivery outcome              | Stored in its Pi Task                                                  |

## Telegram SDK boundary

[TelegramTextAdapter](../packages/backend/src/channels/telegram/format.ts) isolates the SDK's protected message-splitting method. It prepares AST parts for regular messages; Pi owns actual sends and receipts. Replace the bridge when the SDK exposes a public pure preparation API.

The splitter may consume a newline at a code-part boundary. This display behavior is accepted; the dependency is not patched. [Channel service](../packages/backend/src/channels/service.ts) · [Persistent state](../packages/backend/src/channels/state.ts)
