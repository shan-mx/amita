import { directory } from "../deployment/directory";
import type { Env } from "../env";

export async function listComputerStatus(env: Env) {
  const computers = await directory(env).listComputers();
  return Promise.all(
    computers.map(async (computer) => ({
      ...computer,
      ...(await env.COMPUTERS.getByName(computer.id).status()),
    })),
  );
}
