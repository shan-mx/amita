import { and, eq, ne } from "drizzle-orm";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import { channelConnection } from "@amita/db/schema";
import { digest, randomToken } from "../http/auth";
import { CONFIG } from "../shared/config";
import { ChannelError } from "./adapter";
import {
  registerTelegramCommands,
  telegramApi,
  telegramSupportsThreads,
  telegramUser,
} from "./telegram/transport";

const OWNER_KEY = "channels.owner.telegram";
const INVALID_CONNECTION = "Telegram connection is no longer available.";

type Connection = typeof channelConnection.$inferSelect;

function view(connection: Connection) {
  const { id, agentId, platform, status, config } = connection;
  return {
    id,
    agentId,
    platform,
    status: status === "disconnected" ? status : readyStatus(config),
    username: config.username,
    name: config.name,
    topicsEnabled: config.topicsEnabled,
    webhookReady: config.webhookReady,
    error: config.error,
  };
}

function webhookUrl(connection: Connection) {
  return `${connection.config.origin}/webhooks/telegram/${connection.id}`;
}

function readyStatus(config: Connection["config"]): "attention" | "connected" | "pairing" {
  if (!config.webhookReady || config.error) return "attention";
  return config.chatId ? "connected" : "pairing";
}

function saveConnection<T>(write: () => T): T {
  try {
    return write();
  } catch {
    // Drizzle errors can include the credential-bearing JSON bound to the query.
    throw new Error("Could not save the Telegram connection.");
  }
}

export class ChannelConnections {
  private readonly webhookOperations = new Set<string>();

  constructor(
    private readonly db: DrizzleSqliteDODatabase,
    private readonly storage: DurableObjectStorage,
  ) {}

  get(id: string) {
    const connection = this.db
      .select()
      .from(channelConnection)
      .where(eq(channelConnection.id, id))
      .get();
    return (
      connection && {
        ...connection,
        status:
          connection.status === "disconnected"
            ? ("disconnected" as const)
            : readyStatus(connection.config),
      }
    );
  }

  list(agentId: string) {
    return {
      connections: this.db
        .select()
        .from(channelConnection)
        .where(eq(channelConnection.agentId, agentId))
        .all()
        .map(view),
      ownerLinked: Boolean(this.owner()),
    };
  }

  owner() {
    return this.storage.kv.get<string>(OWNER_KEY);
  }

  private getOwned(agentId: string, id: string) {
    const connection = this.get(id);
    if (connection?.agentId !== agentId || connection.status === "disconnected")
      throw new ChannelError(INVALID_CONNECTION);
    return connection;
  }

  private updateRow(id: string, values: Partial<typeof channelConnection.$inferInsert>) {
    return saveConnection(() =>
      this.db
        .update(channelConnection)
        .set(values)
        .where(eq(channelConnection.id, id))
        .returning()
        .get()!,
    );
  }

  private async withWebhook<T>(accountId: string, operation: () => Promise<T>) {
    if (this.webhookOperations.has(accountId))
      throw new ChannelError("A Telegram connection operation is already in progress.");
    this.webhookOperations.add(accountId);
    try {
      return await operation();
    } finally {
      this.webhookOperations.delete(accountId);
    }
  }

  async connect(agentId: string, token: string, origin: string) {
    const bot = telegramUser.parse(await telegramApi(token, "getMe"));
    const username = bot.username;
    if (!bot.is_bot || !username) throw new ChannelError("Use a Telegram Bot token.");
    const accountId = String(bot.id);
    return this.withWebhook(accountId, async () => {
      if (
        this.db
          .select({ id: channelConnection.id })
          .from(channelConnection)
          .where(
            and(
              eq(channelConnection.platform, "telegram"),
              eq(channelConnection.accountId, accountId),
              ne(channelConnection.status, "disconnected"),
            ),
          )
          .get()
      )
        throw new ChannelError("This Telegram Bot is already connected.");
      const connection = saveConnection(() =>
        this.db
          .insert(channelConnection)
          .values({
            id: crypto.randomUUID(),
            agentId,
            platform: "telegram",
            accountId,
            status: "pairing",
            config: {
              username,
              name: bot.first_name,
              token,
              secret: randomToken(),
              origin,
              chatId: null,
              topicsEnabled: telegramSupportsThreads(bot),
              webhookReady: false,
              error: null,
            },
          })
          .returning()
          .get()!,
      );
      return this.registerWebhook(connection);
    });
  }

  private async registerWebhook(connection: Connection) {
    const { config, id } = connection;
    const url = webhookUrl(connection);
    let problem: string | null = null;
    try {
      await telegramApi(config.token, "setWebhook", {
        url,
        secret_token: config.secret,
        allowed_updates: ["message"],
      });
    } catch (error) {
      problem = error instanceof ChannelError ? error.message : "Telegram webhook setup failed.";
    }
    const updated = {
      ...config,
      webhookReady: !problem,
      error: problem,
    };
    const saved = this.updateRow(id, {
      config: updated,
    });
    if (!problem) {
      try {
        await registerTelegramCommands(config.token);
      } catch {
        console.warn("Telegram command menu setup did not complete.");
      }
    }
    return view(saved);
  }

  async pairing(agentId: string, id: string) {
    const code = randomToken();
    const codeHash = await digest(code);
    const connection = this.getOwned(agentId, id);
    if (!connection.config.webhookReady) throw new ChannelError(INVALID_CONNECTION);
    const expiresAt = Date.now() + CONFIG.registrationLifetimeMs;
    this.updateRow(id, { pairing: { codeHash, expiresAt } });
    return { url: `https://t.me/${connection.config.username}?start=${code}`, expiresAt };
  }

  async pair(
    id: string,
    secret: string,
    code: string,
    userId: string,
    chatId: string,
    updateId: string,
  ) {
    const codeHash = await digest(code);
    return this.storage.transactionSync(() => {
      const connection = this.get(id);
      const owner = this.owner();
      if (
        !connection ||
        connection.status === "disconnected" ||
        connection.config.secret !== secret ||
        !connection.config.webhookReady ||
        (owner && owner !== userId)
      )
        return false;
      const pairing = connection.pairing;
      if (!pairing || pairing.expiresAt <= Date.now() || pairing.codeHash !== codeHash)
        return false;
      if (pairing.updateId !== undefined) return pairing.updateId === updateId && owner === userId;
      if (!owner) this.storage.kv.put(OWNER_KEY, userId);
      this.updateRow(id, {
        config: { ...connection.config, chatId },
        pairing: { ...pairing, updateId },
      });
      return true;
    });
  }

  async disconnect(agentId: string, id: string) {
    const connection = this.getOwned(agentId, id);
    return this.withWebhook(connection.accountId, async () =>
      view(await this.removeWebhook(this.revoke(connection))),
    );
  }

  private revoke(connection: Connection) {
    return this.updateRow(connection.id, {
      status: "disconnected",
      pairing: null,
      config: {
        ...connection.config,
        chatId: null,
        webhookReady: false,
      },
    });
  }

  private async removeWebhook(connection: Connection) {
    const { config } = connection;
    try {
      const installed = await telegramApi<{ url: string }>(config.token, "getWebhookInfo");
      if (installed.url === webhookUrl(connection))
        await telegramApi(config.token, "deleteWebhook");
      return this.updateRow(connection.id, {
        config: { ...config, token: "", secret: "", error: null },
      });
    } catch (error) {
      return this.updateRow(connection.id, {
        config: {
          ...config,
          token: "",
          secret: "",
          error: error instanceof ChannelError ? error.message : "Telegram webhook cleanup failed.",
        },
      });
    }
  }
}
