import { basename, join } from "node:path";

export function deriveCodexCliBinaryPath(appPath: string): string {
  if (basename(appPath) === "codex") {
    return appPath;
  }
  return join(appPath, "Contents", "Resources", "codex");
}
