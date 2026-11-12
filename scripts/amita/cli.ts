import {
  CANCEL_SYMBOL,
  cancel,
  confirm,
  intro,
  isCancel,
  log,
  note,
  outro,
  password,
  select,
} from "@clack/prompts";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import { capture, CommandError, interactive, task, wranglerCommand } from "./process.ts";

const configs = {
  main: { source: "wrangler.jsonc" },
  sandbox: { source: "apps/codemode-sandbox/wrangler.jsonc", built: "dist/codemode/wrangler.json" },
};
const workerSchema = z.object({ name: z.string().min(1) });
const identitySchema = z.discriminatedUnion("loggedIn", [
  z.object({ loggedIn: z.literal(false) }),
  z.object({
    loggedIn: z.literal(true),
    accounts: z.array(z.object({ id: z.string().min(1), name: z.string().min(1) })).min(1),
  }),
]);
const required = z.string().trim().min(1, "This value is required.");

class Cancelled extends Error {}

async function answer<T extends string | boolean>(
  prompt: Promise<T | typeof CANCEL_SYMBOL>,
): Promise<T> {
  const value = await prompt;
  if (isCancel(value)) throw new Cancelled();
  return value;
}

async function readWorker(path: string) {
  const errors: ParseError[] = [];
  const value: unknown = parse(await readFile(path, "utf8"), errors, { allowTrailingComma: true });
  if (errors.length) throw new Error(`Invalid ${path}: ${printParseErrorCode(errors[0].error)}`);
  return workerSchema.parse(value);
}

async function selectAccount() {
  async function whoami() {
    const result = await capture([...wranglerCommand, "whoami", "--json"]);
    let json: unknown;
    try {
      json = JSON.parse(result.stdout);
    } catch {
      throw new Error(
        result.stderr.trim() || result.stdout.trim() || "Wrangler returned no account information.",
      );
    }
    const identity = identitySchema.parse(json);
    if (identity.loggedIn && result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || "Cloudflare authentication failed.");
    }
    return identity;
  }
  let identity = await whoami();
  if (!identity.loggedIn) {
    log.info("Sign in to Cloudflare to continue.");
    await interactive([...wranglerCommand, "login"]);
    identity = await whoami();
    if (!identity.loggedIn) throw new Error("Cloudflare login did not complete.");
  }
  const id =
    identity.accounts.length === 1
      ? identity.accounts[0].id
      : await answer(
          select({
            message: "Select a Cloudflare account",
            options: identity.accounts.map((account) => ({
              value: account.id,
              label: account.name,
              hint: account.id,
            })),
          }),
        );
  const account = identity.accounts.find((item) => item.id === id);
  log.info(`Cloudflare account: ${account?.name} (${id})`);
  return { CLOUDFLARE_ACCOUNT_ID: id };
}

async function readSecrets() {
  const ownerPassword = await answer(
    password({
      message: "Owner password",
      validate: (value) => required.safeParse(value).error?.issues[0]?.message,
    }),
  );
  return {
    AMITA_OWNER_PASSWORD: ownerPassword,
    AMITA_CREDENTIAL_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  };
}

async function requireFreshStack(names: string[], accountId: string) {
  const result = await capture([...wranglerCommand, "auth", "token", "--json"]);
  if (result.exitCode !== 0)
    throw new Error(result.stderr.trim() || "Could not read Cloudflare credentials.");
  const credentials = z
    .union([
      z.object({ token: z.string().min(1) }),
      z.object({ key: z.string().min(1), email: z.string().min(1) }),
    ])
    .parse(JSON.parse(result.stdout));
  const headers: Record<string, string> =
    "token" in credentials
      ? { Authorization: `Bearer ${credentials.token}` }
      : { "X-Auth-Key": credentials.key, "X-Auth-Email": credentials.email };
  const api = process.env.CLOUDFLARE_API_BASE_URL ?? "https://api.cloudflare.com/client/v4";
  for (const name of names) {
    const response = await fetch(`${api}/accounts/${accountId}/workers/services/${name}`, {
      headers,
    });
    if (response.ok)
      throw new Error(
        "A target Worker already exists. Use ./amita update to preserve its Secrets and data.",
      );
    if (response.status !== 404)
      throw new Error(`Could not check ${name}: Cloudflare returned HTTP ${response.status}.`);
  }
}

async function deploy(command: "setup" | "update") {
  const env = await selectAccount();
  const mainWorker = await readWorker(configs.main.source);
  const sandbox = await readWorker(configs.sandbox.source);
  let secrets: Awaited<ReturnType<typeof readSecrets>> | undefined;
  if (command === "setup") {
    await requireFreshStack([mainWorker.name, sandbox.name], env.CLOUDFLARE_ACCOUNT_ID);
    secrets = await readSecrets();
  } else {
    const approved = await answer(
      confirm({
        message: `Update ${mainWorker.name} and ${sandbox.name} in this account?`,
        initialValue: false,
      }),
    );
    if (!approved) throw new Cancelled();
  }

  await task("Building Workers", ["pnpm", "--filter", "@amita/web", "build"]);
  log.info(`Deploying ${sandbox.name}`);
  await interactive([...wranglerCommand, "deploy", "--config", configs.sandbox.built], env);
  const deployDirectory = "apps/web/.wrangler/deploy";
  const deployment = z
    .object({ configPath: z.string().min(1) })
    .parse(JSON.parse(await readFile(join(deployDirectory, "config.json"), "utf8")));
  const args = [
    ...wranglerCommand,
    "deploy",
    "--config",
    join(deployDirectory, deployment.configPath),
  ];
  log.info(`Deploying ${mainWorker.name}`);
  if (secrets) {
    const directory = await mkdtemp(join(tmpdir(), "amita-secrets-"));
    try {
      const path = join(directory, "secrets.json");
      await writeFile(path, JSON.stringify(secrets), { mode: 0o600 });
      await interactive([...args, "--secrets-file", path], env);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  } else {
    await interactive(args, env);
  }
  outro(
    command === "setup"
      ? "Sign in at the URL above, connect a provider in Providers, and choose a model for your Agent."
      : "Deployment updated. The Worker URL is shown above.",
  );
}

async function destroy() {
  const env = await selectAccount();
  const mainWorker = await readWorker(configs.main.source);
  const sandbox = await readWorker(configs.sandbox.source);
  note(
    [
      `${mainWorker.name}: Web app, API, Secrets, and all owned Durable Object data.`,
      `${sandbox.name}: Code Mode Sandbox and all owned Durable Object data.`,
      "This includes conversations, settings, automations, and computer registrations.",
      "This action cannot be undone.",
    ].join("\n"),
    "The following cloud resources and their data will be deleted:",
  );
  if (
    !(await answer(
      confirm({ message: "Delete these Workers and all their data?", initialValue: false }),
    ))
  ) {
    throw new Cancelled();
  }
  for (const worker of [mainWorker, sandbox]) {
    await interactive([...wranglerCommand, "delete", worker.name], env);
  }
  outro("Finished processing deletion requests.");
}

export async function main(command: string) {
  try {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error("Run ./amita in an interactive terminal.");
    }
    intro(`Amita ${command}`);
    switch (command) {
      case "setup":
      case "update":
        await deploy(command);
        break;
      case "destroy":
        await destroy();
        break;
      default:
        throw new Error(`Unknown command: ${command}. Use setup, update, or destroy.`);
    }
  } catch (error) {
    if (error instanceof Cancelled) {
      cancel("Cancelled.");
      return;
    }
    log.error(error instanceof Error ? error.message : String(error));
    process.exitCode = error instanceof CommandError ? error.exitCode : 1;
  }
}

if (import.meta.main) await main(process.argv[2] ?? "");
