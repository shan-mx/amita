import { ORPCError, os } from "@orpc/server";
import { z } from "zod";
import type { EntryQuery } from "@earendil-works/pi-durable";
import { CONFIG, COPY, MODEL_COPY, PROVIDER_COPY } from "../shared/config";
import { providerCatalog, providerModels } from "../models/providers";
import {
  providerWriteSchema,
  modelIdSchema,
  modelRefSchema,
  type ModelRef,
} from "../models/schema";
import { authenticate, configured, digest, loginCookie } from "./auth";
import { directory } from "../deployment/directory";
import { discoverModels } from "../models/discovery";
import type { Env } from "../env";
import { validComputerSlug } from "../shared/computer";
import type { HistoryPage } from "../shared/types";
import { listComputerStatus } from "../computer/computers";
import { ChannelError } from "../channels/adapter";
import {
  automationWriteSchema,
  automationPatchSchema,
  timezoneSchema,
  type AutomationReply,
} from "../automations/automation-rules";

type Context = { env: Env; request: Request; headers: Headers };
const base = os.$context<Context>();
const secured = base.use(async ({ context, next }) => {
  if (!configured(context.env))
    throw new ORPCError("SERVICE_UNAVAILABLE", { message: COPY.configuration });
  const login = await authenticate(context.request, context.env);
  if (!login) throw new ORPCError("UNAUTHORIZED", { message: COPY.expired });
  return next({ context: { login } });
});

const agentId = z.string().uuid();
const sessionId = z.string().regex(/^[1-9][0-9]{0,15}$/);
const agentInput = z.object({ agentId });
const sessionInput = z.object({ agentId, sessionId });
const agentName = z.string().trim().min(1).max(CONFIG.nameMaxLength);
const agentPersona = z.string().max(CONFIG.personaMaxLength);
const AGENT_SLUG_RESERVED = "This Agent Slug is already reserved.";
const settings = z.object({
  slug: z.string().trim().min(1).max(CONFIG.computerSlugMaxLength).optional(),
  name: agentName,
  persona: agentPersona,
});

async function getAgent(env: Env, id: string) {
  if (!(await directory(env).hasAgent(id))) throw new ORPCError("NOT_FOUND");
  return env.AGENTS.get(env.AGENTS.idFromName(id));
}

async function requireModel(env: Env, model: ModelRef) {
  const models = providerModels(await directory(env).providerConfigs());
  if (!models.some(({ provider, id }) => provider === model.provider && id === model.modelId))
    throw new ORPCError("BAD_REQUEST", { message: MODEL_COPY.invalidSelection });
}

const automationInput = agentInput.extend({ id: z.string().uuid() });
const channelInput = agentInput.extend({ id: z.string().uuid() });
const botToken = z
  .string()
  .trim()
  .max(128)
  .regex(/^\d+:[A-Za-z0-9_-]+$/);
async function channelAction<T>(action: () => Promise<T>) {
  try {
    return await action();
  } catch (error) {
    if (error instanceof Error && error.name === ChannelError.name)
      throw new ORPCError("BAD_REQUEST", { message: error.message });
    throw error;
  }
}
function automationReply<T>(result: AutomationReply<T>): T {
  if (result.ok) return result.value;
  const codes = {
    invalid: "BAD_REQUEST",
    conflict: "CONFLICT",
    not_found: "NOT_FOUND",
  } as const;
  throw new ORPCError(codes[result.error.code], { message: result.error.message });
}

async function providerAction<T>(action: () => Promise<T>) {
  try {
    return await action();
  } catch (error) {
    const message =
      error instanceof Error &&
      Object.values(PROVIDER_COPY).some((value) => value === error.message)
        ? error.message
        : PROVIDER_COPY.invalid;
    throw new ORPCError(
      message === PROVIDER_COPY.encryption || message === PROVIDER_COPY.decrypt
        ? "SERVICE_UNAVAILABLE"
        : "BAD_REQUEST",
      { message },
    );
  }
}

export const router = {
  providers: {
    catalog: secured.handler(() => providerCatalog()),
    list: secured.handler(({ context }) => directory(context.env).providersList()),
    models: secured.handler(async ({ context }) =>
      providerModels(await directory(context.env).providerConfigs()),
    ),
    save: secured
      .input(providerWriteSchema)
      .handler(({ context, input }) =>
        providerAction(() => directory(context.env).providerSave(input)),
      ),
    remove: secured
      .input(z.object({ id: modelIdSchema }))
      .handler(({ context, input }) => directory(context.env).providerRemove(input.id)),
    discover: secured.input(providerWriteSchema).handler(async ({ context, input }) => {
      if (
        input.config.kind !== "custom" ||
        !["openai-completions", "openai-responses"].includes(input.config.api)
      )
        throw new ORPCError("BAD_REQUEST", { message: MODEL_COPY.discoveryFailed });
      const id = input.config.id;
      const apiKey =
        input.apiKey ??
        (id
          ? (await providerAction(() => directory(context.env).providerCredential(id)))?.key
          : undefined);
      if (!apiKey) throw new ORPCError("BAD_REQUEST", { message: PROVIDER_COPY.invalid });
      try {
        return await discoverModels({ baseUrl: input.config.baseUrl, apiKey });
      } catch {
        throw new ORPCError("BAD_GATEWAY", { message: MODEL_COPY.discoveryFailed });
      }
    }),
  },
  channels: {
    list: secured.input(agentInput).handler(async ({ context, input }) => {
      await getAgent(context.env, input.agentId);
      return directory(context.env).channelsList(input.agentId);
    }),
    connect: secured
      .input(agentInput.extend({ token: botToken }))
      .handler(async ({ context, input }) => {
        await getAgent(context.env, input.agentId);
        const origin = new URL(context.request.url).origin;
        return channelAction(() =>
          directory(context.env).channelsConnect(input.agentId, input.token, origin),
        );
      }),
    pair: secured.input(channelInput).handler(async ({ context, input }) => {
      await getAgent(context.env, input.agentId);
      return channelAction(() => directory(context.env).channelsPairing(input.agentId, input.id));
    }),
    disconnect: secured.input(channelInput).handler(async ({ context, input }) => {
      await getAgent(context.env, input.agentId);
      return channelAction(() =>
        directory(context.env).channelsDisconnect(input.agentId, input.id),
      );
    }),
  },
  automations: {
    get: secured
      .input(automationInput)
      .handler(async ({ context, input }) =>
        automationReply(
          await (await getAgent(context.env, input.agentId)).automationsGet(input.id),
        ),
      ),
    list: secured
      .input(agentInput)
      .handler(async ({ context, input }) =>
        automationReply(await (await getAgent(context.env, input.agentId)).automationsList()),
      ),
    options: secured
      .input(agentInput)
      .handler(async ({ context, input }) =>
        automationReply(await (await getAgent(context.env, input.agentId)).automationsOptions()),
      ),
    create: secured
      .input(automationInput.extend({ definition: automationWriteSchema }))
      .handler(async ({ context, input }) =>
        automationReply(
          await (
            await getAgent(context.env, input.agentId)
          ).automationsCreate(input.id, input.definition),
        ),
      ),
    update: secured
      .input(automationInput.extend({ patch: automationPatchSchema }))
      .handler(async ({ context, input }) =>
        automationReply(
          await (
            await getAgent(context.env, input.agentId)
          ).automationsUpdate(input.id, input.patch),
        ),
      ),
    remove: secured
      .input(automationInput)
      .handler(async ({ context, input }) =>
        automationReply(
          await (await getAgent(context.env, input.agentId)).automationsRemove(input.id),
        ),
      ),
    stop: secured
      .input(automationInput)
      .handler(async ({ context, input }) =>
        automationReply(
          await (await getAgent(context.env, input.agentId)).automationsStop(input.id),
        ),
      ),
    history: secured
      .input(automationInput.extend({ cursor: z.string().max(2048).optional() }))
      .handler(async ({ context, input }) =>
        automationReply(
          await (
            await getAgent(context.env, input.agentId)
          ).automationsHistory(input.id, input.cursor),
        ),
      ),
  },
  computer: {
    status: secured
      .input(
        z
          .object({
            registrationId: z
              .string()
              .regex(/^[a-f0-9]{64}$/)
              .optional(),
          })
          .optional(),
      )
      .handler(async ({ context, input }) => {
        const computers = await listComputerStatus(context.env);
        return {
          computers,
          pending: await directory(context.env).listPendingComputers(),
          ...(input?.registrationId === undefined
            ? {}
            : {
                registrationActive: await directory(context.env).registrationActive(
                  input.registrationId,
                ),
              }),
        };
      }),
    registration: secured.handler(async ({ context }) => {
      return directory(context.env).createRegistration();
    }),
    confirm: secured
      .input(z.object({ deviceId: z.string().uuid(), slug: z.string() }))
      .handler(async ({ context, input }) => {
        const result = await directory(context.env).confirmComputer(input.deviceId, input.slug);
        if (!result.ok) {
          const codes = {
            not_found: "NOT_FOUND",
            forbidden: "FORBIDDEN",
            invalid: "BAD_REQUEST",
            conflict: "CONFLICT",
          } as const;
          throw new ORPCError(codes[result.error], { message: result.message });
        }
        return result.computer;
      }),
    revoke: secured
      .input(z.object({ deviceId: z.string().uuid() }))
      .handler(async ({ context, input }) => directory(context.env).revokeComputer(input.deviceId)),
  },
  auth: {
    status: base.handler(async ({ context }) => ({
      configured: configured(context.env),
      authenticated: Boolean(await authenticate(context.request, context.env)),
    })),
    login: base
      .input(z.object({ password: z.string().min(1).max(CONFIG.personaMaxLength) }))
      .handler(async ({ context, input }) => {
        if (!configured(context.env))
          throw new ORPCError("SERVICE_UNAVAILABLE", { message: COPY.configuration });
        const key = await digest(context.request.headers.get("CF-Connecting-IP") ?? "loopback");
        const { success } = await context.env.LOGIN_RATE_LIMITER.limit({ key });
        if (!success) throw new ORPCError("TOO_MANY_REQUESTS", { message: COPY.rateLimited });
        const result = await directory(context.env).login(input.password);
        if (result.status === "incorrect")
          throw new ORPCError("UNAUTHORIZED", { message: COPY.badPassword });
        context.headers.append(
          "Set-Cookie",
          loginCookie(context.request, result.token, CONFIG.loginLifetimeMs / 1000),
        );
        return { authenticated: true, expiresAt: result.expiresAt };
      }),
    logout: secured.handler(async ({ context }) => {
      await directory(context.env).logout(context.login.tokenHash);
      context.headers.append("Set-Cookie", loginCookie(context.request, "", 0));
      return { authenticated: false };
    }),
  },
  agents: {
    slugSuggestion: secured
      .input(z.object({ name: z.string().trim().min(1).max(CONFIG.nameMaxLength) }))
      .handler(({ context, input }) => directory(context.env).suggestAgentSlug(input.name)),
    memory: secured
      .input(agentInput)
      .handler(async ({ context, input }) =>
        (await getAgent(context.env, input.agentId)).getMemory(),
      ),
    saveMemory: secured
      .input(agentInput.extend({ memory: z.string() }))
      .handler(async ({ context, input }) => {
        const result = await (await getAgent(context.env, input.agentId)).saveMemory(input.memory);
        if (!result.ok) throw new ORPCError("BAD_REQUEST", { message: result.message });
        return { memory: result.memory };
      }),
    persona: secured
      .input(agentInput)
      .handler(async ({ context, input }) =>
        (await getAgent(context.env, input.agentId)).getPersona(),
      ),
    savePersona: secured
      .input(agentInput.extend({ persona: agentPersona, expectedVersion: z.string().min(1) }))
      .handler(async ({ context, input }) => {
        const result = await (
          await getAgent(context.env, input.agentId)
        ).savePersona(input.persona, input.expectedVersion);
        if (!result.ok) {
          if (result.code === "conflict")
            throw new ORPCError("CONFLICT", { message: COPY.personaConflict });
          throw new ORPCError("BAD_REQUEST", { message: result.message });
        }
        return { persona: result.persona, version: result.version };
      }),
    list: secured.handler(async ({ context }) => {
      const entries = await directory(context.env).listAgents();
      return Promise.all(
        entries.map(async (entry) => ({
          ...entry,
          ...(await context.env.AGENTS.get(context.env.AGENTS.idFromName(entry.id)).getConfig()),
        })),
      );
    }),
    create: secured
      .input(settings.extend({ model: modelRefSchema }))
      .handler(async ({ context, input }) => {
        await requireModel(context.env, input.model);
        const id = crypto.randomUUID();
        const slug = input.slug ?? (await directory(context.env).suggestAgentSlug(input.name));
        if (!validComputerSlug(slug))
          throw new ORPCError("BAD_REQUEST", { message: "Enter a valid Agent Slug." });
        if (!(await directory(context.env).isAgentSlugAvailable(slug)))
          throw new ORPCError("CONFLICT", { message: AGENT_SLUG_RESERVED });
        const config = await context.env.AGENTS.getByName(id).initialize({
          name: input.name,
          persona: input.persona,
          slug,
          model: input.model,
        });
        const entry = await directory(context.env).addAgent(id, slug);
        if (!entry) throw new ORPCError("CONFLICT", { message: AGENT_SLUG_RESERVED });
        return { agent: { ...entry, ...config }, sessionId: "1" };
      }),
    update: secured
      .input(agentInput.extend({ name: agentName }))
      .handler(async ({ context, input }) =>
        (await getAgent(context.env, input.agentId)).saveName(input.name),
      ),
    setModel: secured
      .input(agentInput.extend({ model: modelRefSchema }))
      .handler(async ({ context, input }) => {
        const agent = await getAgent(context.env, input.agentId);
        await requireModel(context.env, input.model);
        return agent.saveModel(input.model);
      }),
  },
  sessions: {
    setModel: secured
      .input(sessionInput.extend({ model: modelRefSchema }))
      .handler(async ({ context, input }) => {
        const result = await (
          await getAgent(context.env, input.agentId)
        ).setSessionModel(input.sessionId, input.model);
        if (result.status === "busy") throw new ORPCError("CONFLICT", { message: MODEL_COPY.busy });
        if (result.status === "readonly") throw new ORPCError("FORBIDDEN");
        if (result.status === "unavailable")
          throw new ORPCError("BAD_REQUEST", { message: MODEL_COPY.invalidSelection });
        return { updated: true };
      }),
    update: secured
      .input(
        sessionInput.extend({
          title: z.string().trim().min(1).max(CONFIG.sessionTitleMaxLength).optional(),
          archived: z.boolean().optional(),
        }),
      )
      .handler(async ({ context, input }) =>
        (await getAgent(context.env, input.agentId)).updateSession(input.sessionId, {
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.archived === undefined ? {} : { archived: input.archived }),
        }),
      ),
    search: secured
      .input(
        agentInput.extend({ query: z.string().trim().min(1).max(CONFIG.searchQueryMaxLength) }),
      )
      .handler(async ({ context, input }) =>
        (await getAgent(context.env, input.agentId)).search(input.query),
      ),
    rebuildIndex: secured
      .input(agentInput)
      .handler(async ({ context, input }) =>
        (await getAgent(context.env, input.agentId)).rebuildIndex(),
      ),
    list: secured
      .input(agentInput.extend({ archived: z.boolean().optional() }))
      .handler(async ({ context, input }) =>
        (await getAgent(context.env, input.agentId)).listSessions(input.archived),
      ),
    create: secured.input(agentInput).handler(async ({ context, input }) => {
      const result = await (await getAgent(context.env, input.agentId)).createSession();
      if ("modelError" in result)
        throw new ORPCError("PRECONDITION_FAILED", { message: result.modelError });
      return result;
    }),
    history: secured
      .input(
        sessionInput.extend({
          minEntryId: z.number().int().positive().optional(),
          maxEntryId: z.number().int().positive().optional(),
          order: z.enum(["ascending", "descending"]).optional(),
          limit: z
            .number()
            .int()
            .min(1)
            .max(CONFIG.historyPageSize)
            .default(CONFIG.historyPageSize),
        }),
      )
      .handler(
        async ({ context, input: { agentId, sessionId, limit, ...query } }): Promise<HistoryPage> =>
          JSON.parse(
            await (
              await getAgent(context.env, agentId)
            ).history(sessionId, query as Omit<EntryQuery, "conversationId">, limit),
          ),
      ),
    submit: secured
      .input(
        sessionInput.extend({
          text: z.string().trim().min(1).max(CONFIG.messageMaxLength),
          operationId: z.string().uuid(),
          timezone: timezoneSchema.optional(),
        }),
      )
      .handler(async ({ context, input }) => {
        const receipt = await (
          await getAgent(context.env, input.agentId)
        ).submit(input.sessionId, input.text, input.operationId, input.timezone);
        if ("modelError" in receipt)
          throw new ORPCError("PRECONDITION_FAILED", { message: receipt.modelError });
        return receipt;
      }),
    stop: secured
      .input(sessionInput)
      .handler(async ({ context, input }) =>
        (await getAgent(context.env, input.agentId)).stop(input.sessionId),
      ),
    retry: secured
      .input(sessionInput)
      .handler(async ({ context, input }) =>
        (await getAgent(context.env, input.agentId)).retry(input.sessionId),
      ),
  },
};

export type AppRouter = typeof router;
