import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cwd = fileURLToPath(new URL("../apps/companion", import.meta.url));

function run(command: string, args: string[]) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

switch (process.argv[2]) {
  case "format":
    run("gofmt", ["-w", "."]);
    break;
  case "check":
    run("go", ["vet", "./..."]);
    break;
  case "test":
    run("go", ["test", "./..."]);
    break;
  case "build":
    run("go", ["build", "-o", "amita-companion", "./cmd/amita-companion"]);
    break;
  default:
    throw new Error("Expected a Companion task: format, check, test, or build.");
}
