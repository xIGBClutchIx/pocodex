import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadCodexDesktopProjects } from "../src/lib/codex-desktop-projects.js";

describe("loadCodexDesktopProjects", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map(async (directory) => {
        await rm(directory, { recursive: true, force: true });
      }),
    );
  });

  it("parses roots, labels, and active flags from Codex desktop state", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "pocodex-desktop-state-"));
    tempDirs.push(tempDirectory);

    const projectA = join(tempDirectory, "project-a");
    const projectB = join(tempDirectory, "project-b");
    await mkdir(projectA, { recursive: true });
    await mkdir(projectB, { recursive: true });

    const statePath = join(tempDirectory, ".codex-global-state.json");
    await writeFile(
      statePath,
      JSON.stringify(
        {
          "electron-saved-workspace-roots": [projectA, projectB, projectA],
          "active-workspace-roots": [projectB],
          "electron-workspace-root-labels": {
            [projectA]: "Project Alpha",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = await loadCodexDesktopProjects(statePath);

    expect(result).toEqual({
      found: true,
      path: statePath,
      projects: [
        {
          root: projectA,
          label: "Project Alpha",
          active: false,
          available: true,
        },
        {
          root: projectB,
          label: "project-b",
          active: true,
          available: true,
        },
      ],
    });
  });

  it("returns an empty project list when the desktop state file is missing", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "pocodex-desktop-state-"));
    tempDirs.push(tempDirectory);
    const statePath = join(tempDirectory, ".codex-global-state.json");

    await expect(loadCodexDesktopProjects(statePath)).resolves.toEqual({
      found: false,
      path: statePath,
      projects: [],
    });
  });
});
