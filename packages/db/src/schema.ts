import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const agentDirectory = sqliteTable("agent_directory", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  createdAt: integer("created_at").notNull(),
});

export const ownerSessions = sqliteTable("owner_sessions", {
  tokenHash: text("token_hash").primaryKey(),
  expiresAt: integer("expires_at").notNull(),
});

export const computerRegistration = sqliteTable(
  "computer_registration",
  {
    codeHash: text("code_hash").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.codeHash] })],
);

export const computer = sqliteTable(
  "computer",
  {
    id: text("id").notNull(),
    name: text("name").notNull(),
    slug: text("slug").unique(),
    state: text("state", { enum: ["pending", "active", "revoked"] }).notNull(),
    confirmationExpiresAt: integer("confirmation_expires_at").notNull(),
    credentialHash: text("credential_hash").notNull().unique(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.id] })],
);

export type TelegramConnectionConfig = {
  username: string;
  name: string;
  token: string;
  secret: string;
  origin: string;
  chatId: string | null;
  topicsEnabled: boolean;
  webhookReady: boolean;
  error: string | null;
};

export const channelConnection = sqliteTable(
  "channel_connection",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    platform: text("platform", { enum: ["telegram"] }).notNull(),
    accountId: text("account_id").notNull(),
    status: text("status", {
      enum: ["pairing", "connected", "disconnected", "attention"],
    }).notNull(),
    config: text("config", { mode: "json" }).$type<TelegramConnectionConfig>().notNull(),
    pairing: text("pairing", { mode: "json" }).$type<{
      codeHash: string;
      expiresAt: number;
      updateId?: string;
    }>(),
  },
  (table) => [
    index("channel_connection_agent").on(table.agentId),
    uniqueIndex("channel_connection_active_account")
      .on(table.platform, table.accountId)
      .where(sql`${table.status} != 'disconnected'`),
  ],
);
