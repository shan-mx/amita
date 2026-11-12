import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";

const repository = resolve(import.meta.dirname, "../..");
const cli = join(repository, "scripts/amita/cli.ts");
const fixtures: string[] = [];
const apiServers: Server[] = [];
const apiUrls = new Map<string, string>();

afterEach(async () => {
  for (const server of apiServers.splice(0)) {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
  apiUrls.clear();
  await Promise.all(fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(workerStatus = 404) {
  const root = await mkdtemp(join(tmpdir(), "amita-cli-test-"));
  fixtures.push(root);
  const server = createServer((_request, response) => {
    response.writeHead(workerStatus);
    response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture server address");
  apiServers.push(server);
  apiUrls.set(root, `http://127.0.0.1:${address.port}`);
  await mkdir(join(root, "apps/codemode-sandbox"), { recursive: true });
  await mkdir(join(root, "apps/web"), { recursive: true });
  await mkdir(join(root, "node_modules/.bin"), { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "cli-fixture", private: true, type: "module" }),
  );
  await writeFile(join(root, "wrangler.jsonc"), '{ "name": "fixture-main", }');
  await writeFile(
    join(root, "apps/codemode-sandbox/wrangler.jsonc"),
    '{ "name": "fixture-sandbox" }',
  );
  await writeFile(
    join(root, "apps/web/package.json"),
    JSON.stringify({ scripts: { build: `node ${JSON.stringify(join(root, "tool.ts"))} build` } }),
  );
  await writeFile(
    join(root, "tool.ts"),
    `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync, statSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
const root = process.env.AMITA_TEST_ROOT;
if (!root) throw new Error("Missing fixture directory");
const args = process.argv.slice(2);
const op = args[0];
const trace = (entry: object) => appendFileSync(join(root, "trace.jsonl"), JSON.stringify(entry) + "\\n");
if (op === "auth") { console.log(JSON.stringify({type:"oauth", token:"fixture-token"})); process.exit(0); }
if (op === "whoami") {
  if (process.env.AMITA_TEST_AUTH === "network-error") {
    console.error("Fixture network failure");
    process.exit(1);
  }
  const loggedIn = process.env.AMITA_TEST_AUTH !== "login" || existsSync(join(root, "logged-in"));
  trace({ op });
  console.log(JSON.stringify(loggedIn ? { loggedIn, accounts: [
    { id: "account-one", name: "First account" },
    { id: "account-two", name: "Second account" },
  ] } : { loggedIn }));
  process.exit(loggedIn ? 0 : 1);
}
if (op === "login") {
  trace({ op });
  writeFileSync(join(root, "logged-in"), "yes");
} else if (op === "build") {
  trace({ op });
  for (const [directory, name] of [["renamed_main", "fixture-main"], ["codemode", "fixture-sandbox"]]) {
    mkdirSync(join(root, "dist", directory), { recursive: true });
    writeFileSync(join(root, "dist", directory, "wrangler.json"), JSON.stringify({ name }));
  }
  mkdirSync(join(root, "apps/web/.wrangler/deploy"), { recursive: true });
  writeFileSync(join(root, "apps/web/.wrangler/deploy/config.json"), JSON.stringify({ configPath: "../../../../dist/renamed_main/wrangler.json" }));
} else if (op === "deploy") {
  const config = args[args.indexOf("--config") + 1];
  const { name } = JSON.parse(readFileSync(join(root, config), "utf8"));
  const secretsPath = args.includes("--secrets-file") ? args[args.indexOf("--secrets-file") + 1] : undefined;
  trace({ op, name, account: process.env.CLOUDFLARE_ACCOUNT_ID, args,
    secretsPath, secrets: secretsPath ? JSON.parse(readFileSync(secretsPath, "utf8")) : undefined,
    mode: secretsPath ? statSync(secretsPath).mode & 0o777 : undefined });
  if (name === "fixture-main" && process.env.AMITA_TEST_REGISTER_SUBDOMAIN === "true") {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      console.error("Registering a workers.dev subdomain requires an interactive terminal.");
      process.exit(1);
    }
    const input = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await input.question("Would you like to register a workers.dev subdomain now? ");
    input.close();
    if (answer.trim() !== "y") process.exit(1);
    trace({ op: "register-subdomain" });
  }
  if (name === process.env.AMITA_TEST_FAIL_DEPLOY) process.exit(1);
  console.log("https://" + name + ".example.workers.dev");
} else if (op === "delete") {
  const name = args[1];
  const input = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await input.question("Confirm deletion of " + name + "? ");
  input.close();
  if (answer.trim() === "y") trace({ op, name, account: process.env.CLOUDFLARE_ACCOUNT_ID, args });
} else {
  throw new Error("Unexpected fixture operation: " + args.join(" "));
}
`,
  );
  await chmod(join(root, "tool.ts"), 0o755);
  await symlink(join(root, "tool.ts"), join(root, "node_modules/.bin/wrangler"));
  await writeFile(
    join(root, "node_modules/.bin/pnpm"),
    `#!/bin/sh
if [ "$1" = exec ]; then
  shift 2
elif [ "$1" = --filter ]; then
  shift 2
fi
exec '${process.execPath}' '${join(root, "tool.ts")}' "$@"
`,
  );
  await chmod(join(root, "node_modules/.bin/pnpm"), 0o755);
  return root;
}

async function interact(
  root: string,
  command: string,
  replies: { prompt: string; value: string }[],
  environment: Record<string, string> = {},
) {
  return terminal(
    [process.execPath, cli, command],
    {
      cwd: root,
      env: {
        ...process.env,
        CI: "false",
        PATH: `${join(root, "node_modules/.bin")}:${process.env.PATH}`,
        CLOUDFLARE_API_BASE_URL: apiUrls.get(root),
        AMITA_TEST_ROOT: root,
        TERM: "xterm-256color",
        ...environment,
      },
    },
    replies,
  );
}

function terminal(
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
  replies: { prompt: string; value: string }[] = [],
): Promise<{ exitCode: number; output: string; replies: number }> {
  const terminalArgs = [
    "/bin/bash",
    "-c",
    'stty cols 160 rows 60; exec "$@"',
    "amita-terminal",
    ...args,
  ];
  const quoted = terminalArgs.map((arg) => "'" + arg.replaceAll("'", "'\\''") + "'").join(" ");
  // BSD script needs a pipe instead of Node's socket-backed stdin.
  const child =
    process.platform === "darwin"
      ? spawn(
          "/bin/bash",
          [
            "-c",
            'exec /usr/bin/script "$@" < <(cat 2>/dev/null)',
            "amita-terminal",
            "-q",
            "/dev/null",
            ...terminalArgs,
          ],
          options,
        )
      : spawn("/usr/bin/script", ["-qefc", quoted, "/dev/null"], options);
  let output = "";
  let next = 0;
  const collect = (chunk: string) => {
    output += chunk;
    const reply = replies[next];
    if (reply && stripVTControlCharacters(output).includes(reply.prompt)) {
      next += 1;
      child.stdin.write(reply.value);
    }
  };
  child.stdout.setEncoding("utf8").on("data", collect);
  child.stderr.setEncoding("utf8").on("data", collect);
  const timeout = setTimeout(() => child.kill(), 10_000);
  return new Promise((resolve, reject) => {
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      child.stdin.end();
      resolve({ exitCode: code ?? 1, output: stripVTControlCharacters(output), replies: next });
    });
  });
}

async function events(root: string): Promise<
  {
    op: string;
    name?: string;
    account?: string;
    args?: string[];
    secretsPath?: string;
    secrets?: Record<string, string>;
    mode?: number;
  }[]
> {
  const file = join(root, "trace.jsonl");
  return existsSync(file)
    ? (await readFile(file, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
    : [];
}

const chooseSecondAccount = { prompt: "Select a Cloudflare account", value: "\u001b[B\r" };

await test("the repository entry shows help without JavaScript tools or installed dependencies", async () => {
  const root = await mkdtemp(join(tmpdir(), "amita-entry-test-"));
  fixtures.push(root);
  const result = spawnSync("/bin/bash", [join(repository, "amita"), "--help"], {
    cwd: root,
    env: { PATH: "/usr/bin:/bin", VP_HOME: join(root, "vp") },
    encoding: "utf8",
  });
  assert.equal(result.status, 0);
  assert.ok(result.stdout.includes("setup|update|destroy"));
  assert.equal(existsSync(join(root, "vp")), false);
});

await test("setup deploys after password entry and keeps Secrets private", async () => {
  const root = await fixture();
  const result = await interact(
    root,
    "setup",
    [chooseSecondAccount, { prompt: "Owner password", value: "fixture-owner-secret\r" }],
    { AMITA_TEST_AUTH: "login" },
  );
  assert.ok(!result.output?.includes("fixture-owner-secret"));
  assert.ok(!result.output?.includes("fixture-model-secret"));
  assert.equal(result.exitCode, 0, result.output);
  const recorded = await events(root);
  assert.equal(
    recorded.some(({ op }) => op === "login"),
    true,
  );
  const deployments = recorded.filter(({ op }) => op === "deploy");
  assert.deepEqual(
    deployments.map(({ name, account }) => ({ name, account })),
    [
      { name: "fixture-sandbox", account: "account-two" },
      { name: "fixture-main", account: "account-two" },
    ],
  );
  const main = deployments.find(({ name }) => name === "fixture-main");
  assert.deepEqual(Object.keys(main?.secrets ?? {}).sort(), [
    "AMITA_CREDENTIAL_ENCRYPTION_KEY",
    "AMITA_OWNER_PASSWORD",
  ]);
  assert.equal(main?.secrets?.AMITA_OWNER_PASSWORD, "fixture-owner-secret");
  const encryptionKey = main?.secrets?.AMITA_CREDENTIAL_ENCRYPTION_KEY ?? "";
  assert.equal(Buffer.from(encryptionKey, "base64").length, 32);
  assert.ok(!result.output?.includes(encryptionKey));
  assert.ok(!result.output?.includes("Model API"));
  assert.equal(main?.mode, 0o600);
  assert.ok(!main?.args?.join(" ")?.includes("fixture-owner-secret"));
  assert.ok(!main?.args?.join(" ")?.includes("fixture-model-secret"));
  assert.equal(main?.secretsPath && existsSync(main.secretsPath), false);
  assert.ok(result.output?.includes("https://fixture-main.example.workers.dev"));
});

await test("update deploys both Workers without replacing the configured Secrets", async () => {
  const root = await fixture();
  const result = await interact(root, "update", [
    chooseSecondAccount,
    { prompt: "Update fixture-main", value: "y\r" },
  ]);
  assert.equal(result.exitCode, 0, result.output);
  const deployments = (await events(root)).filter(({ op }) => op === "deploy");
  assert.deepEqual(
    deployments.map(({ name }) => name),
    ["fixture-sandbox", "fixture-main"],
  );
  assert.equal(
    deployments.every(({ args }) => !args?.includes("--secrets-file")),
    true,
  );
  assert.ok(!result.output?.includes("Owner password"));
});

await test("setup allows native account configuration prompts during deployment", async () => {
  const root = await fixture();
  const result = await interact(
    root,
    "setup",
    [
      chooseSecondAccount,
      { prompt: "Owner password", value: "fixture-owner-secret\r" },
      { prompt: "Would you like to register a workers.dev subdomain now?", value: "y\r" },
    ],
    { AMITA_TEST_REGISTER_SUBDOMAIN: "true" },
  );
  assert.equal(result.exitCode, 0, result.output);
  assert.equal(
    (await events(root)).some(({ op }) => op === "register-subdomain"),
    true,
  );
  assert.ok(result.output?.includes("https://fixture-main.example.workers.dev"));
});

await test("destroy cancellation does not delete either Worker", async () => {
  const root = await fixture();
  const result = await interact(root, "destroy", [
    chooseSecondAccount,
    { prompt: "Delete these Workers and all their data?", value: "n\r" },
  ]);
  assert.equal(result.exitCode, 0, result.output);
  assert.deepEqual(
    (await events(root)).filter(({ op }) => op === "delete"),
    [],
  );
  assert.ok(result.output?.includes("conversations"));
  assert.ok(result.output?.includes("fixture-sandbox"));
});

await test("destroy deletes the main Worker before its Sandbox without forcing deletion", async () => {
  const root = await fixture();
  const result = await interact(root, "destroy", [
    chooseSecondAccount,
    { prompt: "Delete these Workers and all their data?", value: "y\r" },
    { prompt: "Confirm deletion of fixture-main?", value: "y\r" },
    { prompt: "Confirm deletion of fixture-sandbox?", value: "y\r" },
  ]);
  assert.equal(result.exitCode, 0, result.output);
  const deletions = (await events(root)).filter(({ op }) => op === "delete");
  assert.deepEqual(
    deletions.map(({ name }) => name),
    ["fixture-main", "fixture-sandbox"],
  );
  assert.equal(
    deletions.every(({ args }) => !args?.includes("--force")),
    true,
  );
});

await test("a failed Sandbox deployment stops before changing the main Worker", async () => {
  const root = await fixture();
  const result = await interact(
    root,
    "update",
    [chooseSecondAccount, { prompt: "Update fixture-main", value: "y\r" }],
    { AMITA_TEST_FAIL_DEPLOY: "fixture-sandbox" },
  );
  assert.notEqual(result.exitCode, 0);
  assert.deepEqual(
    (await events(root)).filter(({ op }) => op === "deploy").map(({ name }) => name),
    ["fixture-sandbox"],
  );
});

await test("an authentication service error is reported instead of starting a login flow", async () => {
  const root = await fixture();
  const result = await interact(root, "setup", [], { AMITA_TEST_AUTH: "network-error" });
  assert.notEqual(result.exitCode, 0);
  assert.ok(result.output?.includes("Fixture network failure"));
  assert.equal(
    (await events(root)).some(({ op }) => op === "login"),
    false,
  );
});

async function gitFixture() {
  const root = await mkdtemp(join(tmpdir(), "amita-update-test-"));
  fixtures.push(root);
  const remote = join(root, "origin.git");
  const seed = join(root, "seed");
  const checkout = join(root, "checkout");
  const bin = join(root, "bin");
  await mkdir(seed);
  await mkdir(bin);
  function git(cwd: string, ...args: string[]) {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.toString().trim();
  }
  git(root, "init", "--bare", remote);
  git(seed, "init", "--initial-branch=main");
  git(seed, "config", "user.name", "CLI Test");
  git(seed, "config", "user.email", "cli-test@example.invalid");
  await writeFile(join(seed, "amita"), await readFile(join(repository, "amita")));
  await writeFile(join(seed, "version.txt"), "initial");
  git(seed, "add", ".");
  git(seed, "commit", "-m", "Initial fixture");
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "--set-upstream", "origin", "main");
  git(root, "clone", "--branch", "main", remote, checkout);
  await writeFile(
    join(bin, "vp"),
    `#!/bin/sh
if [ "$3" = node ]; then
  cat "${join(checkout, "version.txt")}" > "${join(root, "node-started")}"
fi
`,
  );
  await chmod(join(bin, "vp"), 0o755);
  const run = () =>
    terminal(["/bin/bash", join(checkout, "amita"), "update"], {
      cwd: checkout,
      env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` },
    });
  await writeFile(join(seed, "version.txt"), "latest main");
  git(seed, "commit", "-am", "Update fixture");
  git(seed, "push", "origin", "main");
  return { root, seed, checkout, git, run };
}

await test("the update entry fast-forwards main before starting the updated CLI", async () => {
  const { root, seed, checkout, git, run } = await gitFixture();
  const result = await run();
  assert.ok(!result.output?.includes("error:"));
  assert.equal(result.exitCode, 0, result.output);
  assert.equal(git(checkout, "rev-parse", "HEAD"), git(seed, "rev-parse", "HEAD"));
  assert.equal(await readFile(join(checkout, "version.txt"), "utf8"), "latest main");
  assert.equal(await readFile(join(root, "node-started"), "utf8"), "latest main");
});

await test("update refuses tracked local changes before touching code or preparing dependencies", async () => {
  const { root, checkout, git, run } = await gitFixture();
  const before = git(checkout, "rev-parse", "HEAD");
  await writeFile(join(checkout, "version.txt"), "uncommitted user changes");
  const result = await run();
  assert.notEqual(result.exitCode, 0);
  assert.ok(result.output?.includes("local changes"));
  assert.equal(await readFile(join(checkout, "version.txt"), "utf8"), "uncommitted user changes");
  assert.equal(git(checkout, "rev-parse", "HEAD"), before);
  assert.equal(existsSync(join(root, "node-started")), false);
});

for (const status of [200, 503]) {
  await test(`setup refuses to replace Secrets when target preflight returns ${status}`, async () => {
    const root = await fixture(status);
    const result = await interact(root, "setup", [chooseSecondAccount]);
    assert.notEqual(result.exitCode, 0);
    assert.ok(result.output?.includes(status === 200 ? "Use ./amita update" : "HTTP 503"));
    assert.equal(
      (await events(root)).some(({ op }) => op === "deploy"),
      false,
    );
    assert.ok(!result.output?.includes("Owner password"));
  });
}
