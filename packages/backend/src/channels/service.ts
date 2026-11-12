import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import {
  configure,
  defineDoc,
  defineTask,
  type Conversation,
  type ConversationId,
  type EntryId,
  type InputSubmissionDraft,
  type Harness,
  type RunningTask,
  type SubmissionId,
  type TaskId,
  type TaskRuntime,
  type SettledTask,
  type ToolExecutionApi,
  type Tx,
} from "@earendil-works/pi-durable";
import { SessionMetadata } from "../agent/session-metadata";
import { digest } from "../http/auth";
import { CONFIG } from "../shared/config";
import { ComputerError } from "../computer/computer-error";
import { FilesystemError } from "../filesystem/filesystem-error";
import { ChannelError, type ChannelEndpoint, type ChannelInput } from "./adapter";
import { AttachmentRef, attachmentInput } from "./attachments";
import { publicDestinationId } from "./destination-id";
import {
  currentChannelDestination,
  committedReplies,
  watchChannelTurn,
  type AnsweredInput,
} from "./pi-run";
import { downloadTool } from "./download";
import { Inbound, Replies, TaskDelivery, pruneReplies, type DeliveryResult } from "./state";
import type { FilesystemExport, FilesystemRouter, OpenExport } from "../filesystem/filesystem";

type DeliveryText = string | { tool: string };

type Destination = {
  id: string;
  connectionId: string;
  route: string;
  label: string;
  chatLabel: string;
  thread: boolean;
  conversationId: ConversationId | null;
  tail: TaskId | null;
  available: boolean;
};

function findDestination(
  destinations: Readonly<Record<string, Destination>> | undefined,
  id: string,
) {
  if (!destinations) return;
  if (Object.hasOwn(destinations, id)) return destinations[id];
  return Object.values(destinations).find((target) => publicDestinationId(target.id) === id);
}

const Catalog = defineDoc<{
  serviceId: ConversationId | null;
  destinations: Record<string, Destination>;
}>({
  kind: "amita.channels.directory",
  scope: "session",
  version: 1,
  initial: () => ({ serviceId: null, destinations: {} }),
  checkpointWhen: () => true,
});

type InboundTask = { id: string; connectionId: string; previous: TaskId | null };
type AnswerTask = {
  submissionId: SubmissionId;
  destinationId: string;
  conversationId: ConversationId;
  requestQuote?: string;
};
type RunCheckpoint = { phase: "run" };
type DeliveryInput = {
  label: string;
  destinationId: string;
  conversationId: ConversationId | null;
  parts: string[];
  files: { path: string }[];
  preparationError?: string;
};
type DeliveryCheckpoint = { phase: "run"; receipts: string[]; inFlight: boolean; retries: number };

export type ChannelSelection = { target?: "current"; destinationId?: string };

type SendDestination = {
  id: string;
  label: string;
  conversationId: ConversationId | null;
};

const done = <T>(result: T) => ({
  status: "terminal" as const,
  outcome: { status: "completed" as const, result },
});
const RETRY_LIMIT = 3;
const RETRY_DELAY_LIMIT_MS = 30_000;
const INBOUND_RECEIPT_MS = 48 * 60 * 60 * 1000;
const DESTINATION_PAGE_SIZE = 20;
const TYPING_START_DELAY_MS = 1_000;
// Telegram's typing status lasts at most five seconds.
const TYPING_REFRESH_MS = 4_000;

type Dependencies = {
  pi: () => Promise<Harness>;
  filesystem: () => FilesystemRouter;
  connection: (id: string) => Promise<ChannelEndpoint | undefined>;
  initializeConversation: (tx: Tx, id: ConversationId) => Promise<void>;
  admitInput: (
    conversation: Conversation,
    draft: InputSubmissionDraft & { requestId: string },
    context: Context,
  ) => Promise<{ submissionId: SubmissionId } | { modelError: string }>;
  busy: (id: ConversationId) => Promise<boolean>;
};

function canReceive(connection: ChannelEndpoint) {
  return connection.status === "connected";
}

export class Channels {
  constructor(private readonly deps: Dependencies) {}

  downloadTool(filesystem: FilesystemRouter) {
    return downloadTool(filesystem, this.deps.connection);
  }

  readonly inboundTask = defineTask<InboundTask, RunCheckpoint, null>({
    name: "amita.channel.inbound",
    version: 1,
    initial: () => ({ phase: "run" }),
    phases: { run: (task, runtime, context) => this.receive(task, runtime, context) },
    abort: (task, runtime, context) =>
      runtime.commit((tx) => this.finishInbound(tx, task.input), context),
  });

  readonly answerTask = defineTask<AnswerTask, RunCheckpoint, null>({
    name: "amita.channel.answer",
    version: 1,
    initial: () => ({ phase: "run" }),
    phases: { run: (task, runtime, context) => this.answer(task, runtime, context) },
    abort: (task, runtime, context) =>
      runtime.commit(async (tx) => {
        await this.releaseReplyPublisher(tx, task.input.conversationId, task.id);
        return done(null);
      }, context),
  });

  readonly deliveryTask = defineTask<DeliveryInput, DeliveryCheckpoint, DeliveryResult>({
    name: "amita.channel.delivery",
    version: 1,
    initial: () => ({ phase: "run", receipts: [], inFlight: false, retries: 0 }),
    phases: { run: (task, runtime, context) => this.deliver(task, runtime, context) },
    abort: (task, runtime, context) =>
      runtime.commit(
        () =>
          done<DeliveryResult>({
            status: task.state.checkpoint.inFlight ? "unknown" : "cancelled",
            receipts: task.state.checkpoint.receipts,
            error: task.state.checkpoint.inFlight
              ? "Delivery could not be confirmed."
              : "Delivery was cancelled.",
          }),
        context,
      ),
  });

  extension() {
    return {
      name: "amita.channels",
      tasks: [this.inboundTask, this.answerTask, this.deliveryTask],
    };
  }

  private async serviceId(tx: Tx) {
    const catalog = await tx.doc(Catalog);
    if (catalog.serviceId === null) {
      const service = await tx.createConversation({ ownership: { kind: "ownerless" } });
      catalog.serviceId = service.id;
      (await tx.doc(SessionMetadata, service.id)).hidden = true;
    }
    return catalog.serviceId;
  }

  async accept(connectionId: string, input: ChannelInput) {
    const connection = await this.deps.connection(connectionId);
    if (!connection || !canReceive(connection)) return;
    const pi = await this.deps.pi();
    const id = `${connectionId}:${input.key}`;
    await pi.commit(async (tx) => {
      const inbox = await tx.doc(Inbound, connectionId, null);
      const now = Date.now();
      for (const [key, expiresAt] of Object.entries(inbox.recent))
        if (expiresAt <= now) delete inbox.recent[key];
      for (const [key, pending] of Object.entries(inbox.pending)) {
        const task = await tx.task(pending.taskId);
        if (task?.state.status === "terminal") {
          await this.finishInbound(tx, { id: key, connectionId }, task.endedAt ?? now);
        }
      }
      if (inbox.pending[id] || inbox.recent[id] > now) return;
      const target = await this.destination(tx, connectionId, input);
      const destinationId = target.id;
      const taskId = await tx.createTask(
        this.inboundTask,
        { id, connectionId, previous: target.tail },
        {
          ownership: { kind: "conversation" },
          conversationId: await this.serviceId(tx),
          background: true,
        },
      );
      target.tail = taskId;
      inbox.pending[id] = {
        taskId,
        destinationId,
        input,
        conversationId: null,
        creatingThread: false,
      };
    }, BG);
    pi.resume();
  }

  private async finishInbound(
    tx: Tx,
    { id, connectionId }: Pick<InboundTask, "id" | "connectionId">,
    finishedAt = Date.now(),
  ) {
    const inbox = await tx.doc(Inbound, connectionId, null);
    const pending = inbox.pending[id];
    if (pending) {
      if (pending.conversationId !== null)
        await this.releaseReplyPublisher(tx, pending.conversationId, pending.taskId);
      const expiresAt = finishedAt + INBOUND_RECEIPT_MS;
      if (expiresAt > Date.now()) inbox.recent[id] = expiresAt;
      delete inbox.pending[id];
    }
    return done(null);
  }

  private async releaseReplyPublisher(tx: Tx, conversationId: ConversationId, taskId: TaskId) {
    const replies = await tx.doc(Replies, conversationId);
    delete replies.publishers[taskId];
    pruneReplies(replies);
  }

  async renameConversation(conversationId: ConversationId, title: string, context: Context) {
    const pi = await this.deps.pi();
    const targets = Object.values((await pi.snapshot(Catalog, context))?.destinations ?? {});
    for (const target of targets) {
      if (!target.thread || target.conversationId !== conversationId) continue;
      const connection = await this.deps.connection(target.connectionId);
      if (connection?.status !== "connected" || !connection.renameThread) continue;
      await connection.renameThread(target.route, title, context.abortSignal);
      await pi.commit(async (tx) => {
        const current = (await tx.doc(Catalog)).destinations[target.id];
        if (current?.conversationId === conversationId) current.label = title;
      }, context);
    }
  }

  async registerChat(connectionId: string, chat: { route: string; chatLabel: string }) {
    const endpoint = await this.deps.connection(connectionId);
    if (!endpoint?.paired || endpoint.status === "disconnected") return;
    await (
      await this.deps.pi()
    ).commit(async (tx) => {
      await this.destination(tx, connectionId, { ...chat, label: chat.chatLabel, thread: false });
    }, BG);
  }

  private async directory(context: Context) {
    const catalog = await (await this.deps.pi()).snapshot(Catalog, context);
    const targets = Object.values(catalog?.destinations ?? {});
    const connections = await Promise.all(
      [...new Set(targets.map(({ connectionId }) => connectionId))].map(
        async (id) => [id, await this.deps.connection(id)] as const,
      ),
    );
    const endpoints = new Map(connections);
    return targets.flatMap((target) => {
      const connection = endpoints.get(target.connectionId);
      if (!connection?.paired || connection.status === "disconnected") return [];
      const names = [connection.label, connection.name, target.chatLabel];
      if (target.thread) names.push(target.label);
      return [
        {
          names,
          destination: {
            id: publicDestinationId(target.id),
            platform: connection.platform,
            label: this.destinationLabel(connection, target),
            canSend: connection.status === "connected" && target.available,
          },
        },
      ];
    });
  }

  private destinationLabel(connection: ChannelEndpoint, target: Destination) {
    return [connection.label, target.chatLabel, ...(target.thread ? [target.label] : [])].join(
      " / ",
    );
  }

  async listDestinations(query: string | undefined, offset: number, context: Context) {
    const normalize = (value: string) => value.normalize("NFC").toLowerCase();
    const term = normalize(query?.trim() ?? "");
    const matches = (await this.directory(context)).flatMap(({ names, destination }) => {
      const normalized = names.map(normalize);
      return normalized.some((name) => name.includes(term))
        ? [{ exact: term !== "" && normalized.includes(term), destination }]
        : [];
    });
    matches.sort((left, right) => Number(right.exact) - Number(left.exact));
    const end = offset + DESTINATION_PAGE_SIZE;
    return {
      destinations: matches.slice(offset, end).map(({ destination }) => destination),
      nextOffset: end < matches.length ? end : null,
    };
  }

  async resolveDestination(
    selection: ChannelSelection,
    context: Context,
    source?: ConversationId,
  ): Promise<SendDestination> {
    const id = await this.selectDestination(selection, context, source);
    const pi = await this.deps.pi();
    const target = findDestination((await pi.snapshot(Catalog, context))?.destinations, id);
    return this.authorizedDestination(
      target,
      selection.target === "current" ? (source ?? null) : null,
    );
  }

  async selectDestination(selection: ChannelSelection, context: Context, source?: ConversationId) {
    if (Boolean(selection.target) === Boolean(selection.destinationId))
      throw new ChannelError("Choose a destination or send to the current chat or thread.");
    const id =
      selection.destinationId ??
      (source === undefined
        ? undefined
        : await currentChannelDestination(await this.deps.pi(), source, context));
    if (!id)
      throw new ChannelError(
        "The current channel destination could not be determined. Choose a destination explicitly.",
      );
    return id;
  }

  private async authorizedDestination(
    target: Destination | undefined,
    conversationId: ConversationId | null,
  ) {
    const connection = target && (await this.deps.connection(target.connectionId));
    if (
      !target?.available ||
      !connection?.paired ||
      connection.status !== "connected" ||
      (conversationId !== null && target.conversationId !== conversationId)
    )
      throw new ChannelError("The destination is currently unavailable.");
    return {
      id: target.id,
      label: this.destinationLabel(connection, target),
      conversationId,
    };
  }

  async send(
    text: string | undefined,
    files: { path: string }[] | undefined,
    selection: ChannelSelection,
    api: ToolExecutionApi,
    context: Context,
  ) {
    if (!text?.trim() && !files?.length) throw new ChannelError("Provide text or files to send.");
    const pi = await this.deps.pi();
    const existingId = (await pi.snapshot(TaskDelivery, api.taskId, context))?.taskId;
    let taskId = existingId;
    if (taskId == null) {
      const selected = await this.resolveDestination(selection, context, api.conversationId);
      taskId = await api.commit(async (tx) => {
        const ref = await tx.doc(TaskDelivery, api.taskId);
        ref.taskId ??= await this.createDelivery(
          tx,
          selected.id,
          text?.trim() ? text : "",
          selected.conversationId,
          api.taskId,
          files,
        );
        return ref.taskId;
      }, context);
    }
    if (taskId === null) throw new ChannelError("The destination is currently unavailable.");
    const settled = await api.waitForTask(taskId, context);
    if (!this.isDelivery(settled)) throw new Error("Unexpected channel delivery task kind.");
    const { state, input } = settled;
    if (state.outcome.status !== "completed") throw new ChannelError("Delivery did not finish.");
    const delivery = state.outcome.result;
    const start = input.parts.length;
    return {
      destination: { id: publicDestinationId(input.destinationId), label: input.label },
      ...delivery,
      ...(input.files.length
        ? {
            files: input.files
              .slice(0, Math.max(0, delivery.receipts.length - start))
              .map((file, index) => ({
                name: file.path.split("/").at(-1) ?? "attachment",
                receipt: delivery.receipts[start + index],
              })),
          }
        : {}),
    };
  }

  private isDelivery(
    task: SettledTask<DeliveryResult>,
  ): task is SettledTask<DeliveryResult> & { input: DeliveryInput } {
    return task.kind === this.deliveryTask.definition.name;
  }

  private async destination(
    tx: Tx,
    connectionId: string,
    {
      route,
      label,
      chatLabel,
      thread,
    }: Pick<ChannelInput, "route" | "label" | "chatLabel" | "thread">,
  ) {
    const catalog = await tx.doc(Catalog);
    const id = await digest(JSON.stringify([connectionId, route]));
    const destination = (catalog.destinations[id] ??= {
      id,
      connectionId,
      route,
      label,
      chatLabel,
      thread,
      conversationId: null,
      tail: null,
      available: true,
    });
    destination.chatLabel = chatLabel;
    return destination;
  }

  private async freshConversation(tx: Tx, target: Destination, timezone: string) {
    const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
    await this.deps.initializeConversation(tx, conversation.id);
    target.conversationId = conversation.id;
    await configure(tx, conversation.id, { thinkingLevel: CONFIG.thinkingLevel });
    (await tx.doc(SessionMetadata, conversation.id)).timezone = timezone;
    return conversation.id;
  }

  private async receive(
    task: RunningTask<InboundTask, RunCheckpoint, null>,
    runtime: TaskRuntime<InboundTask, RunCheckpoint, null, object>,
    context: Context,
  ) {
    if (task.input.previous) await runtime.waitForTask(task.input.previous, context);
    const { id, connectionId } = task.input;
    const record = (await runtime.snapshot(Inbound, connectionId, context))?.pending[id];
    if (!record) return runtime.commit(() => done(null), context);
    const { input } = record;
    let target = (await runtime.snapshot(Catalog, context))?.destinations[record.destinationId];
    const connection = target && (await this.deps.connection(target.connectionId));
    if (!target || !connection || !canReceive(connection) || (!target.available && !input.control))
      return runtime.commit((tx) => this.finishInbound(tx, task.input), context);
    if (input.control?.kind === "topic") {
      const event = input.control;
      return runtime.commit(async (tx) => {
        const destination = (await tx.doc(Catalog)).destinations[record.destinationId];
        if (event.title) destination.label = event.title;
        if (event.available !== undefined) destination.available = event.available;
        return this.finishInbound(tx, task.input);
      }, context);
    }

    const command = input.control?.kind === "command" ? input.control : undefined;
    if (connection.supportsThreads && !target.thread && (!command || command.name === "new")) {
      const topic = await this.startThread(
        task,
        runtime,
        context,
        connection,
        target,
        input,
        record.creatingThread,
      );
      if (!topic) return;
      target = topic;
    }
    if (command) return this.command(task, runtime, context, connection, target, command);
    const destinationId = target.id;
    const pi = await this.deps.pi();
    const { conversationId, attachments } = await pi.commit(async (tx) => {
      const state = (await tx.doc(Inbound, connectionId, null)).pending[id];
      const destination = (await tx.doc(Catalog)).destinations[destinationId];
      const existing = state.conversationId ?? destination.conversationId;
      const afterEntry = existing === null ? 0 : ((await tx.latestEntryId(existing)) ?? 0);
      state.conversationId =
        existing ?? (await this.freshConversation(tx, destination, connection.timezone));
      const replies = await tx.doc(Replies, state.conversationId);
      // Register before Pi admission so another answer cannot retire a shared receipt during the handoff.
      replies.publishers[task.id] ??= afterEntry;
      if (existing !== null) {
        for (const publisher of Object.keys(replies.publishers)) {
          const prior = await tx.task(Number(publisher) as TaskId);
          if (prior?.state.status === "terminal") delete replies.publishers[publisher];
        }
        pruneReplies(replies);
      }
      if (input.attachments?.length && !state.attachments) {
        state.attachments = [];
        for (const { locator, ...metadata } of input.attachments) {
          const attachment = { id: crypto.randomUUID(), ...metadata };
          const doc = await tx.doc(AttachmentRef, attachment.id, null);
          doc.value = {
            ...attachment,
            locator,
            destinationId,
            conversationId: state.conversationId,
            connectionId: connection.id,
          };
          state.attachments.push(attachment);
        }
      }
      return {
        conversationId: state.conversationId,
        attachments: state.attachments?.map((attachment) => ({ ...attachment })) ?? [],
      };
    }, context);
    const content = [
      input.replyTo?.text ? `Quoted message:\n${input.replyTo.text}` : "",
      input.text,
      ...attachments.map(attachmentInput),
    ]
      .filter(Boolean)
      .join("\n\n");
    const requestQuote = target.route !== input.route ? content : undefined;
    const conversation = await pi.conversation(conversationId, context);
    if (!conversation) return runtime.commit((tx) => this.finishInbound(tx, task.input), context);
    const admission = await this.deps.admitInput(
      conversation,
      {
        type: "input",
        requestId: task.input.id,
        whenBusy: "steer",
        content,
        entry: {
          kind: "amita.channel",
          data: {
            destinationId,
            connectionId: connection.id,
            messageId: input.messageId,
            ...(input.replyTo ? { replyTo: input.replyTo } : {}),
            ...(attachments.length ? { attachments } : {}),
          },
        },
      },
      context,
    );
    if ("modelError" in admission)
      return runtime.commit(async (tx) => {
        await this.createDelivery(
          tx,
          target.id,
          "Amita could not complete this request.",
          conversationId,
        );
        return this.finishInbound(tx, task.input);
      }, context);
    await runtime.commit(async (tx) => {
      const publisher = await tx.createTask(
        this.answerTask,
        {
          submissionId: admission.submissionId,
          destinationId,
          conversationId,
          ...(requestQuote ? { requestQuote } : {}),
        },
        {
          ownership: { kind: "conversation" },
          conversationId: await this.serviceId(tx),
          background: true,
        },
      );
      const replies = await tx.doc(Replies, conversationId);
      replies.publishers[publisher] = replies.publishers[task.id];
      return this.finishInbound(tx, task.input);
    }, context);
  }

  private async startThread(
    task: RunningTask<InboundTask, RunCheckpoint, null>,
    runtime: TaskRuntime<InboundTask, RunCheckpoint, null, object>,
    context: Context,
    connection: ChannelEndpoint,
    root: Destination,
    input: ChannelInput,
    alreadyStarted: boolean,
  ) {
    const fail = (unknown: boolean, reason?: string) =>
      runtime.commit(async (tx) => {
        const first = [connection.threadCreationFailure(unknown), reason].filter(Boolean).join(" ");
        await this.createDelivery(
          tx,
          root.id,
          `${first} Your request has not started. Check your topics and resend it where you want to continue.`,
          null,
        );
        return this.finishInbound(tx, task.input);
      }, context);
    if (alreadyStarted || !connection.createThread || !connection.supportsThreads) {
      await fail(alreadyStarted);
      return null;
    }
    await runtime.commit(async (tx) => {
      (await tx.doc(Inbound, task.input.connectionId, null)).pending[task.input.id].creatingThread =
        true;
      return { status: "running", checkpoint: { phase: "run" } };
    }, context);
    const title =
      Array.from((input.text.trim() || input.attachments?.[0]?.name || "").replace(/\s+/g, " "))
        .slice(0, CONFIG.titleMaxLength)
        .join("") || "New conversation";
    let location: { route: string; label: string };
    try {
      location = await connection.createThread(root.route, title, context.abortSignal);
    } catch (error) {
      context.abortSignal?.throwIfAborted();
      await fail(
        !(error instanceof ChannelError) || error.kind === "unknown",
        error instanceof ChannelError ? error.message : undefined,
      );
      return null;
    }
    return (await this.deps.pi()).commit(async (tx) => {
      const target = await this.destination(tx, connection.id, {
        ...location,
        chatLabel: root.chatLabel,
        thread: true,
      });
      target.label = location.label;
      target.tail ??= task.id;
      const inbound = (await tx.doc(Inbound, task.input.connectionId, null)).pending[task.input.id];
      inbound.destinationId = target.id;
      inbound.creatingThread = false;
      return { ...target };
    }, context);
  }

  private async command(
    task: RunningTask<InboundTask, RunCheckpoint, null>,
    runtime: TaskRuntime<InboundTask, RunCheckpoint, null, object>,
    context: Context,
    connection: ChannelEndpoint,
    target: Destination,
    command: { name: string; argument: string },
  ) {
    const id = target.conversationId;
    const respond = (text: string, create = false) =>
      runtime.commit(async (tx) => {
        const current = (await tx.doc(Catalog)).destinations[target.id];
        if (create) {
          await this.freshConversation(tx, current, connection.timezone);
        }
        await this.createDelivery(tx, target.id, text, null);
        return this.finishInbound(tx, task.input);
      }, context);
    switch (command.name) {
      case "new":
        return respond(
          `Started a new conversation in this ${target.thread ? "topic" : "chat"}. Previous history is available in Amita.`,
          true,
        );
      case "stop": {
        if (id === null || !(await this.deps.busy(id)))
          return respond("There is no running task or queued request in this conversation.");
        const conversation = await (await this.deps.pi()).conversation(id, context);
        await conversation?.abort(context);
        return respond("Stopped the conversation and cleared queued requests.");
      }
      default:
        return respond("Unknown command.");
    }
  }

  private async answer(
    task: RunningTask<AnswerTask, RunCheckpoint, null>,
    runtime: TaskRuntime<AnswerTask, RunCheckpoint, null, object>,
    context: Context,
  ) {
    const { submissionId, destinationId, conversationId } = task.input;
    const pi = await this.deps.pi();
    const submission = await pi.submission(submissionId, context);
    if (!submission)
      return runtime.commit(async (tx) => {
        await this.releaseReplyPublisher(tx, conversationId, task.id);
        return done(null);
      }, context);
    const conversation = await pi.conversation(conversationId, context);
    if (!conversation)
      return runtime.commit(async (tx) => {
        await this.releaseReplyPublisher(tx, conversationId, task.id);
        return done(null);
      }, context);

    const earlier = await pi.commit(async (tx) => {
      const replies = await tx.doc(Replies, conversationId);
      const candidates = Object.keys(replies.publishers)
        .map((id) => Number(id) as TaskId)
        .filter((id) => id < task.id)
        .sort((a, b) => b - a);
      for (const id of candidates) {
        const prior = await tx.task(id);
        if (prior?.kind === task.kind && prior.state.status !== "terminal") return id;
      }
    }, context);

    let publishedThrough: EntryId | undefined;
    const publish = async (after: EntryId, through: EntryId, settled?: AnsweredInput) => {
      const start = publishedThrough ?? after;
      if (through <= start) return;
      if (earlier !== undefined) await runtime.waitForTask(earlier, context);
      for await (const reply of committedReplies(conversation, start, through, context)) {
        let quote = reply.id === settled?.answer ? task.input.requestQuote : undefined;
        for (const item of reply.items) {
          let text = item.text;
          if (quote && item.kind === "text") {
            text = `Request\n${quote
              .split("\n")
              .map((line) => `> ${line}`)
              .join("\n")}\n\n${text}`;
            quote = undefined;
          }
          const delivery = await pi.commit(
            (tx) =>
              this.createReplyDelivery(
                tx,
                task.input,
                reply.id,
                item.position,
                item.kind === "tool" ? { tool: text } : text,
              ),
            context,
          );
          if (delivery !== null) await runtime.waitForTask(delivery, context);
        }
        publishedThrough = reply.id;
      }
      publishedThrough = through;
    };

    let pending = Promise.resolve();
    let queuedThrough: EntryId | undefined;
    let observing = true;
    const typing = new AbortController();
    const typingSignal = AbortSignal.any([runtime.signal, typing.signal]);
    let cancelTyping: (() => void) | undefined;
    const scheduleTyping = (delay: number) => {
      cancelTyping = runtime.setTimer(() => void refreshTyping().catch(() => {}), delay);
    };
    const refreshTyping = async () => {
      const target = (await runtime.snapshot(Catalog, context))?.destinations[destinationId];
      if (!target?.available || target.conversationId !== conversationId || typingSignal.aborted)
        return;
      const endpoint = await this.deps.connection(target.connectionId);
      if (endpoint?.status !== "connected" || !endpoint.sendTyping || typingSignal.aborted) return;
      await endpoint.sendTyping(target.route, typingSignal);
      if (!typingSignal.aborted) scheduleTyping(TYPING_REFRESH_MS);
    };
    const watch = await watchChannelTurn(
      conversation,
      submission,
      context,
      (after, through) => {
        if (!observing || (queuedThrough !== undefined && through <= queuedThrough)) return;
        queuedThrough = through;
        pending = pending.then(() => publish(after, through)).catch(() => {});
      },
      (first, active) => {
        if (!observing) return;
        if (first && active && !cancelTyping) scheduleTyping(TYPING_START_DELAY_MS);
      },
    ).catch(() => undefined);
    const outcome = await submission.wait(context).finally(async () => {
      // Stopping the watch does not join a callback that already started.
      observing = false;
      cancelTyping?.();
      typing.abort();
      await watch?.stop();
    });
    await pending;
    if (outcome.type === "input" && outcome.status === "done")
      await publish(outcome.entry, outcome.answer, outcome);
    await runtime.commit(async (tx) => {
      if (
        outcome.type === "input" &&
        outcome.status !== "done" &&
        (outcome.reason === "model_error" || outcome.reason === "no_model") &&
        (await tx.doc(Catalog)).destinations[destinationId]?.conversationId === conversationId
      ) {
        await this.createDelivery(
          tx,
          destinationId,
          "Amita could not complete this request.",
          conversationId,
        );
      }
      await this.releaseReplyPublisher(tx, conversationId, task.id);
      return done(null);
    }, context);
  }

  private async createReplyDelivery(
    tx: Tx,
    { conversationId, destinationId }: AnswerTask,
    entryId: EntryId,
    position: number,
    text: DeliveryText,
  ) {
    const replies = await tx.doc(Replies, conversationId);
    const key = `${entryId}:${position}:${destinationId}`;
    const existing = replies.deliveries[key];
    if (existing) return existing.taskId;
    const taskId = await this.createDelivery(tx, destinationId, text, conversationId);
    if (taskId !== null) replies.deliveries[key] = { entryId, taskId };
    return taskId;
  }

  async createDelivery(
    tx: Tx,
    destinationId: string,
    text: DeliveryText,
    conversationId: ConversationId | null = null,
    ownerTaskId?: TaskId,
    files: { path: string }[] = [],
  ) {
    const target = (await tx.doc(Catalog)).destinations[destinationId];
    if (!target) return null;
    const connection = await this.deps.connection(target.connectionId);
    if (!connection) return null;
    let parts: string[] = [];
    let preparationError: string | undefined;
    try {
      parts =
        typeof text === "string"
          ? connection.prepareText(text)
          : connection.prepareText(text.tool, "tool");
    } catch (error) {
      if (ownerTaskId || !(error instanceof ChannelError)) throw error;
      preparationError = error.message;
    }
    return tx.createTask(
      this.deliveryTask,
      {
        destinationId,
        conversationId,
        label: target.label,
        parts,
        files,
        ...(preparationError ? { preparationError } : {}),
      },
      ownerTaskId
        ? { ownership: { kind: "task", taskId: ownerTaskId } }
        : {
            ownership: { kind: "conversation" },
            conversationId: await this.serviceId(tx),
            background: true,
          },
    );
  }

  private async deliver(
    task: RunningTask<DeliveryInput, DeliveryCheckpoint, DeliveryResult>,
    runtime: TaskRuntime<DeliveryInput, DeliveryCheckpoint, DeliveryResult, object>,
    context: Context,
  ) {
    const state = task.state.checkpoint;
    const target = (await runtime.snapshot(Catalog, context))?.destinations[
      task.input.destinationId
    ];
    const connection = target && (await this.deps.connection(target.connectionId));
    const connectionStop = (endpoint: ChannelEndpoint | undefined) => {
      if (!endpoint || endpoint.status === "disconnected") return "The channel is disconnected.";
    };
    const finish = (status: DeliveryResult["status"], error?: string) =>
      runtime.commit(async () => {
        return done<DeliveryResult>({
          status,
          receipts: state.receipts,
          ...(error ? { error } : {}),
        });
      }, context);
    if (state.inFlight) return finish("unknown", "Delivery could not be confirmed.");
    if (task.input.preparationError) return finish("failed", task.input.preparationError);
    if (!target) return finish("cancelled", "The destination is currently unavailable.");
    const stopped = connectionStop(connection);
    if (stopped || !connection) return finish("cancelled", stopped);
    const rebound = "The conversation at this destination changed.";
    if (task.input.conversationId !== null && target.conversationId !== task.input.conversationId)
      return finish("cancelled", rebound);
    if (connection.status !== "connected" || !target.available)
      return finish("failed", "The destination is currently unavailable.");
    const index = state.receipts.length;
    const part = task.input.parts[index];
    const reference = task.input.files[index - task.input.parts.length];
    if (part === undefined && !reference) return finish("sent");
    let file: FilesystemExport | undefined;
    let opened: OpenExport | undefined;
    try {
      if (reference) {
        file = await this.deps.filesystem().inspectExport(reference.path, context);
        const sender = connection.attachmentSend;
        if (!sender) throw new ChannelError("This channel cannot send files.");
        if (file.size > sender.maxBytes(file))
          throw new ChannelError(`${file.name} exceeds the channel's file size limit.`);
        opened = await this.deps.filesystem().openExport(file, context);
      }
    } catch (error) {
      context.abortSignal?.throwIfAborted();
      if (
        (error instanceof FilesystemError || error instanceof ComputerError) &&
        error.code === "not_found"
      )
        return finish(
          "failed",
          "The source file changed or is no longer available. Start a new send with the file you want to share.",
        );
      return finish(
        "failed",
        error instanceof Error ? error.message : "The selected file could not be read.",
      );
    }

    try {
      const current = reference ? await this.deps.connection(target.connectionId) : connection;
      const stoppedBeforeSend = connectionStop(current);
      if (stoppedBeforeSend || !current) return finish("cancelled", stoppedBeforeSend);
      if (current.status !== "connected")
        return finish("cancelled", "The channel connection changed.");
      const sender = current.attachmentSend;
      if (file && !sender) return finish("failed", "This channel cannot send files.");
      let eligible = false;
      await runtime.commit(async (tx) => {
        const latest = (await tx.doc(Catalog)).destinations[task.input.destinationId];
        eligible = Boolean(
          latest?.available &&
          (task.input.conversationId === null ||
            latest.conversationId === task.input.conversationId),
        );
        return eligible
          ? { status: "running", checkpoint: { ...state, inFlight: true } }
          : done<DeliveryResult>({
              status: "cancelled",
              receipts: state.receipts,
              error: latest?.available ? rebound : "The destination is currently unavailable.",
            });
      }, context);
      if (!eligible) return;
      let receipt: string;
      try {
        receipt =
          file && opened && sender
            ? await sender.send(target.route, file, opened.stream, context.abortSignal)
            : await current.sendText(target.route, part, context.abortSignal);
      } catch (error) {
        context.abortSignal?.throwIfAborted();
        if (!(error instanceof ChannelError)) throw error;
        if (
          error.kind === "limited" &&
          state.retries < RETRY_LIMIT &&
          error.retryAfterMs <= RETRY_DELAY_LIMIT_MS
        ) {
          await runtime.commit(
            () => ({
              status: "sleeping",
              until: runtime.now() + error.retryAfterMs,
              checkpoint: { ...state, inFlight: false, retries: state.retries + 1 },
            }),
            context,
          );
          return;
        }
        return finish(error.kind === "unknown" ? "unknown" : "failed", error.message);
      }
      const receipts = [...state.receipts, receipt];
      await runtime.commit(
        () =>
          receipts.length === task.input.parts.length + task.input.files.length
            ? done<DeliveryResult>({ status: "sent", receipts })
            : {
                status: "running",
                checkpoint: { phase: "run", receipts, inFlight: false, retries: 0 },
              },
        context,
      );
    } finally {
      await opened?.close().catch(() => {});
    }
  }
}
