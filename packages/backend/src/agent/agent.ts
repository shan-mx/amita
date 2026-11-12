import { DurableObject } from "cloudflare:workers";
import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import { DurableObjectSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { SessionMetadata } from "./session-metadata";
import { ChatConnections } from "./chat-connections";
import { firstUserText, createSessionTitleTask, userInputText } from "./session-title";
import {
  conversationSections,
  saveConversationBaseline,
  type ConversationBaseline,
} from "./conversation-context";
import { HistoryIndex } from "./history-index";
import { createSessionSearchTool } from "./session-search";
import { BASH_TOOL_NAME, computerTools } from "../computer/remote-env";
import { InternalFilesystem, MEMORY_PATH, PERSONA_PATH } from "../filesystem/internal-filesystem";
import { FilesystemError } from "../filesystem/filesystem-error";
import { FilesystemRouter } from "../filesystem/filesystem";
import { ComputerFilesystem } from "../computer/computer-filesystem";
import { listChannelTool, sendChannelTool } from "../channels/tools";
import { filesystemTools, FS_READ_TOOL_NAME } from "../filesystem/filesystem-tools";
import { createProgramExtension } from "./program";
import { Automations } from "../automations/automations";
import { automationTools } from "../automations/automation-tools";
import { automationReply } from "../automations/automation-rules";
import type { AutomationWrite } from "../shared/automations";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { RemoteCodemodeSandbox } from "@earendil-works/pi-codemode/portable";
import { createModels } from "@earendil-works/pi-ai/models";
import { configuredProviders } from "../models/providers";
import type { ModelRef } from "../models/schema";
import {
  configure,
  AgentDoc,
  LiveDoc,
  createRegistry,
  ConversationIdle,
  defineDoc,
  Harness,
  type Conversation,
  type ConversationId,
  type EntryId,
  type EntryQuery,
  type Cursor,
  type InputSubmissionDraft,
  type Extension,
  type Tx,
} from "@earendil-works/pi-durable";
import { PiHarness } from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";
import {
  CHAT_EXPIRES_AT_HEADER,
  CONFIG,
  COPY,
  MODEL_COPY,
  unavailableModelLabel,
} from "../shared/config";
import { directory } from "../deployment/directory";
import type { AgentConfig, HistoryPage, SessionInfo } from "../shared/types";
import type { Env } from "../env";
import { Channels } from "../channels/service";
import type { ChannelInput } from "../channels/adapter";
import { channelAdapters } from "../channels/adapters";

const DIRECT_AMITA_TOOLS = new Set([BASH_TOOL_NAME, FS_READ_TOOL_NAME]);

const AgentDocument = defineDoc<AgentConfig & { slug: string }>({
  kind: "amita.agent",
  version: 1,
  scope: "session",
  initial: () => ({
    name: "",
    slug: "",
    model: null,
    thinkingLevel: CONFIG.thinkingLevel,
  }),
  checkpointWhen: () => true,
});

export class Agent extends DurableObject<Env> {
  readonly registry = createRegistry();
  private readonly internalFiles = new InternalFilesystem(this.ctx.storage, this.ctx.id.toString());
  private readonly channels = new Channels({
    pi: () => this.harness.pi(),
    filesystem: () => this.filesystem,
    connection: async (id) => {
      const connection = await directory(this.env).channelConnection(id);
      return connection &&
        this.env.AGENTS.idFromName(connection.agentId).toString() === this.ctx.id.toString()
        ? channelAdapters[connection.platform](connection)
        : undefined;
    },
    initializeConversation: async (tx, id) => {
      const { model } = await tx.doc(AgentDocument);
      if (!model || !this.models.getModel(model.provider, model.modelId))
        throw new Error(MODEL_COPY.missingAgent);
      await configure(tx, id, { model });
      await saveConversationBaseline(tx, id, await this.captureConversationBaseline());
    },
    admitInput: (conversation, draft, context) => this.admitInput(conversation, draft, context),
    busy: (id) => this.harness.session(String(id)).busy(),
  });
  private filesystem!: FilesystemRouter;
  private automations!: Automations;
  private readonly models = createModels({
    authContext: { env: async () => undefined, fileExists: async () => false },
  });
  private providerConfigKey?: string;
  private readonly sessionTitle = createSessionTitleTask((id, title, context) =>
    this.channels.renameConversation(id, title, context),
  );
  readonly harness = new PiHarness({
    harness: async ({ storage, context, onWake }) => {
      await this.loadProviders();
      const computerAgent = {
        slug: () => this.agentSlug(),
      };
      const filesystem = new FilesystemRouter([
        this.internalFiles,
        new ComputerFilesystem(this.env, computerAgent),
      ]);
      this.filesystem = filesystem;
      this.automations = new Automations({
        pi: () => this.harness.pi(),
        models: () => this.modelConfig(),
        baseline: () => this.captureConversationBaseline(),
        prepareInput: (conversation, draft, context) =>
          this.prepareInput(conversation, draft, context),
      });
      const extension: Extension = {
        name: "amita",
        tasks: [this.sessionTitle],
        tools: [
          ...computerTools(this.env, computerAgent),
          ...filesystemTools(filesystem),
          this.channels.downloadTool(filesystem),
          listChannelTool(this.channels),
          sendChannelTool(this.channels),
          ...automationTools(this.automations),
          createSessionSearchTool((query, context) => this.searchHistory(query, context)),
        ].map((tool) =>
          DIRECT_AMITA_TOOLS.has(tool.name) ? tool : { ...tool, callers: ["tools"] },
        ),
        sections: conversationSections(
          () => this.harness.pi(),
          () => this.captureConversationBaseline(),
        ),
      };
      const sandbox = new RemoteCodemodeSandbox({
        remote: () => this.env.CODEMODE_SANDBOX.getByName(crypto.randomUUID()),
      });
      const codemode = createCodemodeExtension({ sandbox, models: false });
      const program = createProgramExtension(sandbox);
      this.registry.install(program);
      this.registry.install(this.automations.extension());
      this.registry.install(this.channels.extension());
      this.registry.install(extension);
      this.registry.install(codemode);
      return Harness.open(
        storage,
        {
          models: this.models,
          registry: this.registry,
          onWake,
          settings: { extensions: [extension, codemode] },
        },
        context,
      );
    },
    defaults: { thinkingLevel: CONFIG.thinkingLevel },
  });
  private readonly chat = new ChatConnections(
    this.ctx,
    () => this.harness.pi(),
    (session) => this.chatConversation(session),
  );
  readonly lifecycle = Lifecycle.install(this).use(this.harness);

  onStart() {
    return this.chat.restore();
  }

  webSocketClose(socket: WebSocket) {
    this.chat.disconnect(socket);
    socket.close(1000);
  }

  webSocketError(socket: WebSocket) {
    this.chat.disconnect(socket);
    socket.close(1011);
  }

  private readonly historyIndex = new HistoryIndex(
    new DurableObjectSqliteDatabase(this.ctx.storage),
  );

  private async loadProviders() {
    const configs = await directory(this.env).providerConfigs();
    const key = JSON.stringify(configs);
    if (key !== this.providerConfigKey) {
      this.models.clearProviders();
      for (const provider of configuredProviders(configs, (id) =>
        directory(this.env).providerCredential(id),
      ))
        this.models.setProvider(provider);
      this.providerConfigKey = key;
    }
    return this.models.getModels().map(({ id, name, provider }) => ({
      id,
      name,
      provider,
      providerName: this.models.getProvider(provider)?.name ?? provider,
    }));
  }

  private async modelConfig() {
    const models = await this.loadProviders();
    const pi = await this.harness.pi();
    const inheritedModel = (await pi.snapshot(AgentDocument, BG))?.model ?? null;
    return { inheritedModel, models };
  }

  async getConfig(): Promise<AgentConfig> {
    const pi = await this.harness.pi();
    const document = await pi.snapshot(AgentDocument, BG);
    if (!document) throw new Error("Agent not initialized");
    return {
      name: document.name,
      thinkingLevel: document.thinkingLevel,
      model: document.model,
    };
  }

  private async agentSlug() {
    const pi = await this.harness.pi();
    const document = await pi.snapshot(AgentDocument, BG);
    if (!document?.slug) throw new Error("Agent Slug is missing from the Agent configuration.");
    return document.slug;
  }

  async initialize(input: {
    name: string;
    persona: string;
    slug: string;
    model: ModelRef;
  }): Promise<AgentConfig> {
    await this.internalFiles.writeText(PERSONA_PATH, input.persona);
    await this.internalFiles.writeText(MEMORY_PATH, "");
    const pi = await this.harness.pi();
    const root = await pi.root(BG);
    const baseline = await this.captureConversationBaseline();
    await root.commit(async (tx) => {
      Object.assign(await tx.doc(AgentDocument), {
        name: input.name,
        slug: input.slug,
        model: input.model,
      });
      await configure(tx, root.id, { model: input.model });
      await saveConversationBaseline(tx, root.id, baseline);
    }, BG);
    return this.getConfig();
  }

  private async captureConversationBaseline(): Promise<ConversationBaseline> {
    const [files, computers] = await Promise.all([
      this.internalFiles.readContextFiles(),
      directory(this.env).listComputers(),
    ]);
    return {
      ...files,
      computers: computers
        .map(({ slug, name }) => ({ slug, name }))
        .sort((a, b) => a.slug.localeCompare(b.slug)),
    };
  }

  async saveName(name: string): Promise<AgentConfig> {
    const pi = await this.harness.pi();
    await pi.commit(async (tx) => {
      (await tx.doc(AgentDocument)).name = name;
    }, BG);
    return this.getConfig();
  }

  async saveModel(model: ModelRef): Promise<AgentConfig> {
    const pi = await this.harness.pi();
    await pi.commit(async (tx) => {
      (await tx.doc(AgentDocument)).model = model;
    }, BG);
    return this.getConfig();
  }

  async getPersona() {
    const { content, version } = await this.internalFiles.readVersionedText(PERSONA_PATH);
    return { persona: content, version };
  }

  async savePersona(persona: string, expectedVersion: string) {
    const failure = await this.saveInternalFile(PERSONA_PATH, persona, expectedVersion);
    return failure ?? { ok: true as const, ...(await this.getPersona()) };
  }

  async getMemory() {
    return { memory: await this.internalFiles.readText(MEMORY_PATH) };
  }

  async saveMemory(memory: string) {
    const failure = await this.saveInternalFile(MEMORY_PATH, memory);
    return failure ?? { ok: true as const, memory };
  }

  private async saveInternalFile(path: string, content: string, expectedVersion?: string) {
    try {
      await this.internalFiles.writeText(path, content, expectedVersion);
    } catch (error) {
      if (
        error instanceof FilesystemError &&
        (error.code === "invalid" || error.code === "conflict")
      )
        return { ok: false as const, code: error.code, message: error.message };
      throw error;
    }
  }

  private async allSessions(context: Context = BG): Promise<SessionInfo[]> {
    const pi = await this.harness.pi();
    const models = await this.loadProviders();
    const sessions: SessionInfo[] = [];
    let cursor: Cursor | undefined;
    do {
      const page = await pi.commit(
        (tx) => tx.scanConversations({}, CONFIG.historyPageSize, cursor),
        context,
      );
      for (const record of page.items) {
        if (record.owner) continue;
        const id = String(record.id);
        const metadata = await pi.snapshot(SessionMetadata, record.id, context);
        if (metadata?.hidden) continue;
        const handle = await this.harness.conversation(id);
        const busy = await this.harness.session(id).busy();
        const model = (await handle.agent(context)).model;
        const modelLabel =
          model &&
          (models.find((item) => item.provider === model.provider && item.id === model.modelId)
            ?.name ??
            unavailableModelLabel(`${model.provider} / ${model.modelId}`));
        let title = metadata?.title;
        if (!title) {
          const entries = await handle.entries(
            { order: "ascending" },
            CONFIG.historyPageSize,
            undefined,
            context,
          );
          title =
            firstUserText(entries.items)
              .trim()
              .replace(/\s+/g, " ")
              .slice(0, CONFIG.titleMaxLength) || COPY.newSession;
        }
        sessions.push({
          id,
          title,
          archived: metadata?.archived ?? false,
          busy,
          model: model ?? null,
          modelEditable: !metadata?.automationRunId,
          ...(modelLabel ? { modelLabel } : {}),
        });
      }
      cursor = page.next;
    } while (cursor);
    return sessions;
  }
  async listSessions(archived = false) {
    return (await this.allSessions()).filter((session) => session.archived === archived);
  }
  async updateSession(session: string, input: { title?: string; archived?: boolean }) {
    const conversation = await this.harness.conversation(session);
    await conversation.commit(async (tx) => {
      Object.assign(await tx.doc(SessionMetadata, conversation.id), input);
    }, BG);
    return { updated: true };
  }

  async setSessionModel(session: string, model: ModelRef) {
    await this.loadProviders();
    const conversation = await this.chatConversation(session);
    return conversation.commit(async (tx) => {
      if ((await tx.doc(SessionMetadata, conversation.id)).automationRunId)
        return { status: "readonly" as const };
      if ((await tx.doc(LiveDoc, conversation.id)).run) return { status: "busy" as const };
      if (!this.models.getModel(model.provider, model.modelId))
        return { status: "unavailable" as const };
      await configure(tx, conversation.id, { model });
      return { status: "updated" as const };
    }, BG);
  }
  private async searchHistory(query: string, context: Context = BG) {
    return this.historyIndex.search(
      query,
      await this.allSessions(context),
      (id) => this.harness.conversation(id),
      context,
    );
  }
  async search(query: string) {
    return this.searchHistory(query);
  }
  async rebuildIndex() {
    return this.historyIndex.rebuild(
      await this.allSessions(),
      (id) => this.harness.conversation(id),
      BG,
    );
  }

  private async chatConversation(session: string) {
    const id = Number(session);
    if (!Number.isSafeInteger(id) || id < 1) throw new Error(`Invalid pi session ${session}`);
    const pi = await this.harness.pi();
    const conversation = await pi.conversation(id as ConversationId, BG);
    if (!conversation) throw new Error(`Unknown pi session ${session}`);
    return conversation;
  }

  async createSession() {
    const pi = await this.harness.pi();
    const [{ inheritedModel, models }, baseline] = await Promise.all([
      this.modelConfig(),
      this.captureConversationBaseline(),
    ]);
    if (
      !inheritedModel ||
      !models.some(
        ({ provider, id }) => provider === inheritedModel.provider && id === inheritedModel.modelId,
      )
    )
      return { modelError: MODEL_COPY.missingAgent };
    const conversation = await pi.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: { model: inheritedModel, thinkingLevel: CONFIG.thinkingLevel },
        init: (tx, id) => saveConversationBaseline(tx, id, baseline),
      },
      BG,
    );
    return { id: String(conversation.id) };
  }
  acceptChannelInput(connectionId: string, input: ChannelInput) {
    return this.channels.accept(connectionId, input);
  }
  registerChannelChat(connectionId: string, chat: { route: string; chatLabel: string }) {
    return this.channels.registerChat(connectionId, chat);
  }
  private async admitInput(
    conversation: Conversation,
    draft: InputSubmissionDraft & { requestId: string },
    context: Context,
    timezone?: string,
  ) {
    return conversation.commit(
      await this.prepareInput(conversation, draft, context, timezone),
      context,
    );
  }
  private async prepareInput(
    conversation: Conversation,
    draft: InputSubmissionDraft & { requestId: string },
    context: Context,
    timezone?: string,
  ) {
    const models = await this.loadProviders();
    return async (tx: Tx) => {
      const metadata = await tx.doc(SessionMetadata, conversation.id);
      const existing = await tx.submissionByRequest(conversation.id, draft.requestId);
      if (existing) {
        if (timezone) metadata.timezone = timezone;
        return { submissionId: existing.id, accepted: false };
      }
      let titleText = "";
      if (!metadata.title && metadata.titleTaskId === null) {
        const entries = await tx.scanEntries(
          { conversationId: conversation.id, order: "ascending" },
          CONFIG.historyPageSize,
        );
        titleText = firstUserText(entries.items) || userInputText(draft.content);
      }
      let submissionId;
      try {
        submissionId = await conversation.submit(tx, { ...draft, whenIdle: "reject" });
      } catch (error) {
        if (!(error instanceof ConversationIdle)) throw error;
        const pinned = (await tx.doc(AgentDoc, conversation.id)).model;
        if (
          !pinned ||
          !models.some(({ provider, id }) => provider === pinned.provider && id === pinned.modelId)
        )
          return { modelError: MODEL_COPY.missingSession };
        submissionId = await conversation.submit(tx, draft);
      }
      if (timezone) metadata.timezone = timezone;
      if (titleText.trim())
        metadata.titleTaskId = await tx.createTask(
          this.sessionTitle,
          { text: Array.from(titleText).slice(0, CONFIG.sessionTitleInputChars).join("") },
          {
            ownership: { kind: "conversation" },
            conversationId: conversation.id,
            background: true,
          },
        );
      return { submissionId, accepted: true };
    };
  }

  async submit(session: string, text: string, operationId: string, timezone?: string) {
    const conversation = await this.chatConversation(session);
    const admission = await this.admitInput(
      conversation,
      { type: "input", requestId: operationId, whenBusy: "steer", content: text },
      BG,
      timezone,
    );
    if ("modelError" in admission) return admission;
    return { operationId, session, accepted: admission.accepted };
  }

  private async withAutomations<T>(action: (automations: Automations) => T | Promise<T>) {
    return automationReply(async () => {
      await this.harness.pi();
      return action(this.automations);
    });
  }
  automationsGet(id: string) {
    return this.withAutomations((automations) => automations.info(id));
  }
  automationsList() {
    return this.withAutomations((service) => service.list());
  }
  automationsOptions() {
    return this.withAutomations((service) => service.options());
  }
  automationsCreate(id: string, definition: AutomationWrite) {
    return this.withAutomations((service) => service.create(id, definition));
  }
  automationsUpdate(id: string, patch: Partial<AutomationWrite>) {
    return this.withAutomations((service) => service.update(id, patch));
  }
  automationsRemove(id: string) {
    return this.withAutomations((service) => service.remove(id));
  }
  automationsStop(id: string) {
    return this.withAutomations((service) => service.stop(id));
  }
  automationsHistory(id: string, cursor?: string) {
    return this.withAutomations((service) => service.history(id, cursor));
  }
  stop(session: string) {
    return this.harness.session(session).abort();
  }
  retry(session: string) {
    return this.harness.session(session).continue();
  }

  async history(session: string, query: Omit<EntryQuery, "conversationId">, limit: number) {
    const conversation = await this.chatConversation(session);
    const page = await conversation.entries(query, limit, undefined, BG);
    const entries = [...page.items];
    if (query.order === undefined) entries.reverse();
    const result: HistoryPage = { entries, next: page.next };
    return JSON.stringify(result);
  }

  async fetch(request: Request): Promise<Response> {
    const params = new URL(request.url).searchParams;
    const session = params.get("session");
    const from = params.get("from");
    const expiresAt = Number(request.headers.get(CHAT_EXPIRES_AT_HEADER));
    if (
      request.headers.get("Upgrade")?.toLowerCase() !== "websocket" ||
      !session ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= 0
    )
      return new Response(null, { status: 400 });
    await this.lifecycle.start();
    return this.chat.connect(
      { session, from: from === null ? undefined : (Number(from) as EntryId) },
      expiresAt,
    );
  }
}
