import { taskLog } from "@clack/prompts";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { type Readable } from "node:stream";
import { text } from "node:stream/consumers";

export const wranglerCommand = ["pnpm", "exec", "wrangler"];

export class CommandError extends Error {
  readonly exitCode: number;

  constructor(exitCode: number) {
    super(`Command failed with exit code ${exitCode}.`);
    this.exitCode = exitCode;
  }
}

function completion(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
}

export async function capture(args: string[]) {
  const child = spawn(args[0], args.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
  const [exitCode, stdout, stderr] = await Promise.all([
    completion(child),
    text(child.stdout),
    text(child.stderr),
  ]);
  return { stdout, stderr, exitCode };
}

export async function interactive(args: string[], env: Record<string, string> = {}) {
  const child = spawn(args[0], args.slice(1), {
    env: { ...process.env, ...env },
    stdio: "inherit",
  });
  const exitCode = await completion(child);
  if (exitCode !== 0) throw new CommandError(exitCode);
}

export async function task(title: string, args: string[]) {
  const progress = taskLog({ title });
  const child = spawn(args[0], args.slice(1), { stdio: ["inherit", "pipe", "pipe"] });
  async function stream(output: Readable) {
    const lines = createInterface({ input: output, crlfDelay: Infinity });
    for await (const line of lines) progress.message(line);
  }
  const [exitCode] = await Promise.all([
    completion(child),
    stream(child.stdout),
    stream(child.stderr),
  ]);
  if (exitCode !== 0) {
    progress.error(`${title} failed.`);
    throw new CommandError(exitCode);
  }
  progress.success(title);
}
