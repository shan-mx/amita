import { DurableObject } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { eq, lt } from "drizzle-orm";
import migrations from "@amita/db/migrations";
import { agentDirectory, ownerSessions, computer, computerRegistration } from "@amita/db/schema";
import { CONFIG, COPY } from "../shared/config";
import { digest, passwordMatches, randomToken } from "../http/auth";
import {
  encryptCredential,
  decryptCredential,
  type EncryptedCredential,
} from "../models/credentials";
import type { ProviderConfig, ProviderWrite } from "../models/schema";
import { validateProvider } from "../models/providers";
import { PROVIDER_COPY } from "../shared/config";
import type { Env } from "../env";
import { suggestSlug, validComputerSlug } from "../shared/computer";
import { ChannelConnections } from "../channels/connections";

const PROVIDER_PREFIX = "provider:";
type SavedProvider = { config: ProviderConfig; credential: EncryptedCredential };

export class Deployment extends DurableObject<Env> {
  private readonly db = drizzle(this.ctx.storage);
  private readonly channels = new ChannelConnections(this.db, this.ctx.storage);

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      migrate(this.db, migrations);
    });
  }

  channelConnection(id: string) {
    const connection = this.channels.get(id);
    return connection && this.hasAgent(connection.agentId) ? connection : undefined;
  }

  channelOwner() {
    return this.channels.owner();
  }

  channelsList(agentId: string) {
    return this.channels.list(agentId);
  }

  channelsConnect(...args: Parameters<ChannelConnections["connect"]>) {
    return this.channels.connect(...args);
  }

  channelsPairing(...args: Parameters<ChannelConnections["pairing"]>) {
    return this.channels.pairing(...args);
  }

  channelsPair(...args: Parameters<ChannelConnections["pair"]>) {
    return this.channels.pair(...args);
  }

  channelsDisconnect(...args: Parameters<ChannelConnections["disconnect"]>) {
    return this.channels.disconnect(...args);
  }

  providerConfigs() {
    return [...this.ctx.storage.kv.list<SavedProvider>({ prefix: PROVIDER_PREFIX })].map(
      ([, { config }]) => config,
    );
  }

  providersList() {
    return this.providerConfigs().map((config) => ({ config, hasApiKey: true }));
  }

  async providerSave(input: ProviderWrite) {
    if (
      input.config.kind === "custom" &&
      input.config.id &&
      !this.ctx.storage.kv.get<SavedProvider>(`${PROVIDER_PREFIX}${input.config.id}`)
    )
      throw new Error(PROVIDER_COPY.invalid);
    const config: ProviderConfig =
      input.config.kind === "custom"
        ? { ...input.config, id: input.config.id ?? `custom-${crypto.randomUUID()}` }
        : input.config;
    if (config.kind === "custom" && !config.id.startsWith("custom-"))
      throw new Error(PROVIDER_COPY.invalid);
    validateProvider(config);
    const encrypted =
      input.apiKey === undefined
        ? undefined
        : await encryptCredential(
            this.env.AMITA_CREDENTIAL_ENCRYPTION_KEY,
            config.id,
            input.apiKey,
          );
    const key = `${PROVIDER_PREFIX}${config.id}`;
    const previous = this.ctx.storage.kv.get<SavedProvider>(key);
    const credential = encrypted ?? previous?.credential;
    if (!credential) throw new Error(PROVIDER_COPY.invalid);
    this.ctx.storage.kv.put<SavedProvider>(key, { config, credential });
    return { config, hasApiKey: true };
  }

  providerRemove(id: string) {
    this.ctx.storage.kv.delete(`${PROVIDER_PREFIX}${id}`);
    return { removed: true };
  }

  async providerCredential(id: string) {
    const saved = this.ctx.storage.kv.get<SavedProvider>(`${PROVIDER_PREFIX}${id}`);
    if (!saved) return undefined;
    return {
      type: "api_key" as const,
      key: await decryptCredential(this.env.AMITA_CREDENTIAL_ENCRYPTION_KEY, id, saved.credential),
      ...(saved.config.kind === "builtin" ? { env: saved.config.options } : {}),
    };
  }

  getLogin(tokenHash: string) {
    const session = this.db
      .select()
      .from(ownerSessions)
      .where(eq(ownerSessions.tokenHash, tokenHash))
      .get();
    if (!session || session.expiresAt <= Date.now()) return undefined;
    return { expiresAt: session.expiresAt };
  }

  async login(password: string) {
    const now = Date.now();
    if (!(await passwordMatches(password, this.env.AMITA_OWNER_PASSWORD)))
      return { status: "incorrect" as const };
    const token = randomToken();
    const tokenHash = await digest(token);
    const expiresAt = now + CONFIG.loginLifetimeMs;
    this.db.delete(ownerSessions).where(lt(ownerSessions.expiresAt, now)).run();
    this.db.insert(ownerSessions).values({ tokenHash, expiresAt }).run();
    return { status: "ok" as const, token, expiresAt };
  }

  logout(tokenHash: string) {
    this.db.delete(ownerSessions).where(eq(ownerSessions.tokenHash, tokenHash)).run();
  }

  listAgents() {
    return this.db.select().from(agentDirectory).all();
  }
  hasAgent(id: string) {
    return Boolean(this.db.select().from(agentDirectory).where(eq(agentDirectory.id, id)).get());
  }
  addAgent(id: string, slug: string) {
    return (
      this.db
        .insert(agentDirectory)
        .values({ id, slug, createdAt: Date.now() })
        .onConflictDoNothing({ target: agentDirectory.slug })
        .returning()
        .all()[0] ?? null
    );
  }

  suggestAgentSlug(name: string) {
    const reserved = new Set(
      this.db
        .select({ slug: agentDirectory.slug })
        .from(agentDirectory)
        .all()
        .map(({ slug }) => slug),
    );
    return suggestSlug(name, reserved, "agent");
  }
  isAgentSlugAvailable(slug: string) {
    const row = this.db
      .select({ id: agentDirectory.id })
      .from(agentDirectory)
      .where(eq(agentDirectory.slug, slug))
      .get();
    return !row;
  }

  listComputers() {
    return this.db
      .select({
        id: computer.id,
        slug: computer.slug,
        name: computer.name,
        createdAt: computer.createdAt,
      })
      .from(computer)
      .where(eq(computer.state, "active"))
      .orderBy(computer.createdAt, computer.id)
      .all()
      .map((record) => ({ ...record, slug: record.slug! }));
  }
  listPendingComputers() {
    const reserved = new Set(
      this.db
        .select({ slug: computer.slug })
        .from(computer)
        .all()
        .flatMap(({ slug }) => (slug ? [slug] : [])),
    );
    return this.db
      .select()
      .from(computer)
      .where(eq(computer.state, "pending"))
      .all()
      .filter((record) => record.confirmationExpiresAt > Date.now())
      .map((record) => ({
        id: record.id,
        name: record.name,
        expiresAt: record.confirmationExpiresAt,
        suggestedSlug: suggestSlug(record.name, reserved, "computer"),
      }));
  }
  resolveComputer(slug: string) {
    if (!validComputerSlug(slug))
      return { ok: false, error: "invalid_computer", message: COPY.computerSlugInvalid } as const;
    const record = this.db.select().from(computer).where(eq(computer.slug, slug)).get();
    if (!record)
      return {
        ok: false as const,
        error: "not_found" as const,
        message: `Computer ${slug} is not registered.`,
      };
    if (record.state !== "active")
      return {
        ok: false as const,
        error: "revoked" as const,
        message: `Computer ${slug} has been revoked.`,
      };
    return {
      ok: true as const,
      computer: {
        id: record.id,
        slug: record.slug!,
        name: record.name,
        createdAt: record.createdAt,
      },
    };
  }
  confirmComputer(id: string, slug: string) {
    return this.db.transaction((tx) => {
      const record = tx.select().from(computer).where(eq(computer.id, id)).get();
      if (!record)
        return { ok: false as const, error: "not_found" as const, message: COPY.pairingCancelled };
      const result = (state: "active" | "revoked", confirmedSlug: string) => ({
        ok: true as const,
        computer: { id, slug: confirmedSlug, name: record.name, state },
      });
      if (record.slug !== null)
        return result(record.state === "revoked" ? "revoked" : "active", record.slug);
      if (record.state === "revoked")
        return { ok: false as const, error: "forbidden" as const, message: COPY.pairingCancelled };
      if (record.confirmationExpiresAt <= Date.now())
        return { ok: false as const, error: "forbidden" as const, message: COPY.pairingExpired };
      if (!validComputerSlug(slug))
        return { ok: false as const, error: "invalid" as const, message: COPY.computerSlugInvalid };
      // UNIQUE(slug) covers revoked identities and arbitrates competing confirmations.
      const updated = tx
        .update(computer)
        .set({ slug, state: "active" })
        .where(eq(computer.id, id))
        .returning({ id: computer.id });
      try {
        updated.get();
      } catch (error) {
        if (!tx.select({ id: computer.id }).from(computer).where(eq(computer.slug, slug)).get())
          throw error;
        return {
          ok: false as const,
          error: "conflict" as const,
          message: COPY.computerSlugReserved,
        };
      }
      return result("active", slug);
    });
  }
  registrationActive(id: string) {
    const record = this.db
      .select()
      .from(computerRegistration)
      .where(eq(computerRegistration.codeHash, id))
      .get();
    return Boolean(record && record.expiresAt > Date.now());
  }
  async createRegistration() {
    const code = randomToken().slice(0, 16);
    const codeHash = await digest(code);
    const expiresAt = Date.now() + CONFIG.registrationLifetimeMs;
    this.db
      .delete(computerRegistration)
      .where(lt(computerRegistration.expiresAt, Date.now()))
      .run();
    this.db.insert(computerRegistration).values({ codeHash, expiresAt }).run();
    return { id: codeHash, code, expiresAt };
  }
  async registerComputer(code: string, name: string) {
    const credential = randomToken();
    const [codeHash, credentialHash] = await Promise.all([digest(code), digest(credential)]);
    return this.db.transaction((tx) => {
      const registration = tx
        .select()
        .from(computerRegistration)
        .where(eq(computerRegistration.codeHash, codeHash))
        .get();
      if (!registration || registration.expiresAt <= Date.now()) return null;
      const deviceId = crypto.randomUUID();
      tx.delete(computerRegistration).where(eq(computerRegistration.codeHash, codeHash)).run();
      tx.insert(computer)
        .values({
          id: deviceId,
          name,
          credentialHash,
          createdAt: Date.now(),
          state: "pending",
          confirmationExpiresAt: Date.now() + CONFIG.pairingConfirmationMs,
        })
        .run();
      return { deviceId, credential, expiresAt: Date.now() + CONFIG.pairingConfirmationMs };
    });
  }
  async pairingStatus(credential: string) {
    const hash = await digest(credential);
    const record = this.db.select().from(computer).where(eq(computer.credentialHash, hash)).get();
    if (
      !record ||
      record.state === "revoked" ||
      (record.state === "pending" && record.confirmationExpiresAt <= Date.now())
    )
      return null;
    return {
      deviceId: record.id,
      name: record.name,
      slug: record.slug,
      state: record.state,
      expiresAt: record.confirmationExpiresAt,
    };
  }
  async authenticateComputer(credential: string) {
    const record = await this.pairingStatus(credential);
    return record?.state === "active" && record.slug && validComputerSlug(record.slug)
      ? { id: record.deviceId, name: record.name }
      : null;
  }
  async revokeComputer(id: string) {
    this.db.update(computer).set({ state: "revoked" }).where(eq(computer.id, id)).run();
    await this.env.COMPUTERS.get(this.env.COMPUTERS.idFromName(id)).revoke();
    return { revoked: true };
  }
}
