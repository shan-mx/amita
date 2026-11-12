import { validComputerSlug } from "../shared/computer";
import { FilesystemError } from "./filesystem-error";

const COMPUTER_ROOT = "/computers/";
const MOUNT_PATH = /^\/computers\/([^/]+)\/(fs|workspace)(?:\/(.*))?$/is;

/** A filesystem namespace, not a URL: percent characters belong to filenames. */
export function computerPath(path: string) {
  if (path.includes("\0")) throw new FilesystemError("invalid_path", "Paths cannot contain NUL.");
  if (!path.startsWith(COMPUTER_ROOT)) return undefined;
  const match = MOUNT_PATH.exec(path);
  if (!match || !validComputerSlug(match[1]))
    throw new FilesystemError("invalid_path", "Use /computers/<slug>/fs/<absolute-host-path>.");
  const namespace: "fs" | "workspace" = match[2].toLowerCase() === "fs" ? "fs" : "workspace";
  const mountPath = `/${match[3] ?? ""}`;
  if (namespace === "workspace") {
    let depth = 0;
    for (const segment of mountPath.split("/")) {
      if (!segment || segment === ".") continue;
      if (segment === "..") {
        if (depth === 0)
          throw new FilesystemError(
            "invalid_path",
            "The path escapes its virtual workspace mount.",
          );
        depth--;
      } else {
        depth++;
      }
    }
  }
  return {
    computer: match[1],
    namespace,
    path: mountPath,
  };
}

export function virtualComputerPath(
  computer: string,
  path: string,
  namespace: "fs" | "workspace" = "fs",
) {
  const suffix = namespace === "workspace" ? "workspace" : "fs";
  return `${COMPUTER_ROOT}${computer}/${suffix}${path.startsWith("/") ? path : `/${path}`}`;
}
