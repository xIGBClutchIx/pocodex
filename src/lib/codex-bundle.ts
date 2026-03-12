import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { mkdtemp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";

import * as asar from "@electron/asar";
import plist from "plist";

interface CodexDesktopPackageJson {
  version?: string;
  codexBuildFlavor?: string;
  codexBuildNumber?: string;
}

interface CodexInfoPlist {
  CFBundleShortVersionString?: string;
}

export interface CodexBundle {
  appPath: string;
  version: string;
  buildFlavor: string;
  buildNumber: string;
  webviewRoot: string;
  readIndexHtml: () => Promise<string>;
}

export interface CodexDesktopMetadata {
  appPath: string;
  appAsarPath: string;
  version: string;
  buildFlavor: string;
  buildNumber: string;
}

export interface CodexDesktopWorkerScript {
  metadata: CodexDesktopMetadata;
  workerPath: string;
}

export async function loadCodexBundle(appPath: string): Promise<CodexBundle> {
  const metadata = await loadCodexDesktopMetadata(appPath);
  const webviewRoot = await ensureWebviewCache(metadata.appAsarPath, metadata.version);

  return {
    appPath: metadata.appPath,
    version: metadata.version,
    buildFlavor: metadata.buildFlavor,
    buildNumber: metadata.buildNumber,
    webviewRoot,
    readIndexHtml: async () => readFile(join(webviewRoot, "index.html"), "utf8"),
  };
}

export async function loadCodexDesktopMetadata(appPath: string): Promise<CodexDesktopMetadata> {
  const resolvedAppPath = resolve(appPath);
  const infoPlistPath = join(resolvedAppPath, "Contents", "Info.plist");
  const appAsarPath = join(resolvedAppPath, "Contents", "Resources", "app.asar");

  await stat(infoPlistPath).catch(() => {
    throw new Error(`Codex Info.plist not found at ${infoPlistPath}`);
  });
  await stat(appAsarPath).catch(() => {
    throw new Error(`Codex app.asar not found at ${appAsarPath}`);
  });

  const infoPlist = plist.parse(await readFile(infoPlistPath, "utf8")) as CodexInfoPlist;
  const desktopPackage = JSON.parse(
    await extractAsarText(appAsarPath, "package.json"),
  ) as CodexDesktopPackageJson;

  return {
    appPath: resolvedAppPath,
    appAsarPath,
    version: desktopPackage.version ?? infoPlist.CFBundleShortVersionString ?? "unknown",
    buildFlavor: desktopPackage.codexBuildFlavor ?? "prod",
    buildNumber: desktopPackage.codexBuildNumber ?? "0",
  };
}

export async function ensureCodexDesktopWorkerScript(
  appPath: string,
): Promise<CodexDesktopWorkerScript> {
  const metadata = await loadCodexDesktopMetadata(appPath);
  const workerPath = await ensureDesktopWorkerCache(metadata.appAsarPath, metadata.version);
  return {
    metadata,
    workerPath,
  };
}

async function ensureWebviewCache(appAsarPath: string, version: string): Promise<string> {
  const cacheRoot = cacheRootForVersion(version);
  const markerPath = join(cacheRoot, ".complete");

  try {
    await stat(markerPath);
    return cacheRoot;
  } catch {
    // continue and build the cache
  }

  const parentDirectory = dirname(cacheRoot);
  await mkdir(parentDirectory, { recursive: true });

  const tempDirectory = await mkdtemp(join(parentDirectory, `${version}-`));

  try {
    const archiveEntries = asar.listPackage(appAsarPath, { isPack: false });
    for (const archiveEntry of archiveEntries) {
      if (!archiveEntry.startsWith("/webview/")) {
        continue;
      }

      const relativePath = archiveEntry.slice("/webview/".length);
      if (!relativePath) {
        continue;
      }

      const entry = asar.statFile(appAsarPath, archiveEntry.slice(1), false);
      if ("files" in entry || "link" in entry) {
        continue;
      }

      const destinationPath = join(tempDirectory, relativePath);
      await mkdir(dirname(destinationPath), { recursive: true });
      const buffer = asar.extractFile(appAsarPath, archiveEntry.slice(1));
      await writeFile(destinationPath, buffer);
    }

    await writeFile(markerPathFor(tempDirectory), "ok");

    try {
      await rename(tempDirectory, cacheRoot);
    } catch (error) {
      await rm(tempDirectory, { recursive: true, force: true });
      await stat(markerPath).catch(() => {
        throw error;
      });
    }
  } catch (error) {
    await rm(tempDirectory, { recursive: true, force: true });
    throw error;
  }

  return cacheRoot;
}

async function ensureDesktopWorkerCache(appAsarPath: string, version: string): Promise<string> {
  const cacheRoot = cacheRootForVersion(version);
  const workerDirectory = join(cacheRoot, "__desktop-worker");
  const markerPath = join(workerDirectory, ".complete");
  const workerPath = join(workerDirectory, "worker.js");
  const tslibPath = join(workerDirectory, "node_modules", "tslib", "tslib.js");

  try {
    await stat(markerPath);
    await stat(workerPath);
    await stat(tslibPath);
    return workerPath;
  } catch {
    // continue and build the cache
  }

  const parentDirectory = dirname(workerDirectory);
  await mkdir(parentDirectory, { recursive: true });
  await rm(workerDirectory, { recursive: true, force: true });

  const tempDirectory = await mkdtemp(join(parentDirectory, "worker-"));

  try {
    const buffer = asar.extractFile(appAsarPath, ".vite/build/worker.js");
    await writeFile(join(tempDirectory, "worker.js"), buffer);
    await extractAsarDirectory(
      appAsarPath,
      "/node_modules/tslib/",
      join(tempDirectory, "node_modules", "tslib"),
    );
    await writeFile(markerPathFor(tempDirectory), "ok");

    try {
      await rename(tempDirectory, workerDirectory);
    } catch (error) {
      await rm(tempDirectory, { recursive: true, force: true });
      await stat(markerPath).catch(() => {
        throw error;
      });
    }
  } catch (error) {
    await rm(tempDirectory, { recursive: true, force: true });
    throw new Error("Failed to extract Codex desktop worker.js.", {
      cause: error instanceof Error ? error : undefined,
    });
  }

  return workerPath;
}

function cacheRootForVersion(version: string): string {
  return join(homedir(), ".cache", "pocodex", version);
}

function markerPathFor(directory: string): string {
  return join(directory, ".complete");
}

async function extractAsarText(appAsarPath: string, filename: string): Promise<string> {
  const buffer = asar.extractFile(appAsarPath, filename);
  return buffer.toString("utf8");
}

async function extractAsarDirectory(
  appAsarPath: string,
  archivePrefix: string,
  destinationDirectory: string,
): Promise<void> {
  const archiveEntries = asar.listPackage(appAsarPath, { isPack: false });

  for (const archiveEntry of archiveEntries) {
    if (!archiveEntry.startsWith(archivePrefix)) {
      continue;
    }

    const relativePath = archiveEntry.slice(archivePrefix.length);
    if (!relativePath) {
      continue;
    }

    const entry = asar.statFile(appAsarPath, archiveEntry.slice(1), false);
    if ("files" in entry || "link" in entry) {
      continue;
    }

    const destinationPath = join(destinationDirectory, relativePath);
    await mkdir(dirname(destinationPath), { recursive: true });
    const buffer = asar.extractFile(appAsarPath, archiveEntry.slice(1));
    await writeFile(destinationPath, buffer);
  }
}
