import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it } from "vitest";

import { DefaultCodexDesktopGitWorkerBridge } from "../src/lib/codex-desktop-git-worker.js";

class FakeWorker extends EventEmitter {
  static instances: FakeWorker[] = [];

  readonly workerPath: string;
  readonly options: unknown;
  readonly postedMessages: unknown[] = [];
  terminated = false;
  unrefCalled = false;

  constructor(workerPath: string, options: unknown) {
    super();
    this.workerPath = workerPath;
    this.options = options;
    FakeWorker.instances.push(this);
  }

  postMessage(message: unknown): void {
    this.postedMessages.push(message);
  }

  unref(): void {
    this.unrefCalled = true;
  }

  async terminate(): Promise<number> {
    this.terminated = true;
    return 0;
  }
}

describe("DefaultCodexDesktopGitWorkerBridge", () => {
  afterEach(() => {
    FakeWorker.instances = [];
  });

  it("spawns the desktop worker lazily and forwards git messages", async () => {
    const bridge = new DefaultCodexDesktopGitWorkerBridge({
      appPath: "/Applications/Codex.app",
      resolveWorkerScript: async () => ({
        workerPath: "/tmp/pocodex-worker.js",
        metadata: {
          appPath: "/Applications/Codex.app",
          buildFlavor: "stable",
          buildNumber: "123",
          version: "1.2.3",
        },
      }),
      WorkerClass: FakeWorker as never,
      codexAppSessionId: "session-1",
    });

    expect(FakeWorker.instances).toHaveLength(0);

    await bridge.send({
      type: "worker-request",
      workerId: "git",
      request: {
        id: "req-1",
        method: "status-summary",
      },
    });

    expect(FakeWorker.instances).toHaveLength(1);
    expect(FakeWorker.instances[0]?.workerPath).toBe("/tmp/pocodex-worker.js");
    expect(FakeWorker.instances[0]?.unrefCalled).toBe(true);
    expect(FakeWorker.instances[0]?.postedMessages).toEqual([
      {
        type: "worker-request",
        workerId: "git",
        request: {
          id: "req-1",
          method: "status-summary",
        },
      },
    ]);
    expect(FakeWorker.instances[0]?.options).toMatchObject({
      name: "git",
      workerData: {
        workerId: "git",
        maxLogLevel: "warning",
        sentryRewriteFramesRoot: "/Applications/Codex.app",
        spawnInsideWsl: false,
        sentryInitOptions: {
          buildFlavor: "stable",
          buildNumber: "123",
          appVersion: "1.2.3",
          codexAppSessionId: "session-1",
        },
      },
    });

    await bridge.close();
  });

  it("responds to worktree cleanup main RPC requests with a safe stub", async () => {
    const bridge = new DefaultCodexDesktopGitWorkerBridge({
      appPath: "/Applications/Codex.app",
      resolveWorkerScript: async () => ({
        workerPath: "/tmp/pocodex-worker.js",
        metadata: {
          appPath: "/Applications/Codex.app",
          buildFlavor: "stable",
          buildNumber: "123",
          version: "1.2.3",
        },
      }),
      WorkerClass: FakeWorker as never,
      codexAppSessionId: "session-1",
    });

    await bridge.subscribe();

    const worker = FakeWorker.instances[0];
    worker?.emit("message", {
      type: "worker-main-rpc-request",
      workerId: "git",
      requestId: "rpc-1",
      method: "worktree-cleanup-inputs",
      params: {
        hostKey: "local",
        threadIds: ["thr_1", "thr_2"],
      },
    });

    expect(worker?.postedMessages.at(-1)).toMatchObject({
      type: "worker-main-rpc-response",
      workerId: "git",
      requestId: "rpc-1",
      method: "worktree-cleanup-inputs",
      result: {
        type: "ok",
        value: {
          pinnedThreadIds: [],
          protectPreMigrationOwnerlessWorktrees: false,
          autoCleanupEnabled: false,
          keepCount: 0,
          threadMetadataById: {
            thr_1: {
              isInProgress: true,
            },
            thr_2: {
              isInProgress: true,
            },
          },
        },
      },
    });

    await bridge.close();
  });

  it("returns an explicit error for unknown main RPC methods", async () => {
    const bridge = new DefaultCodexDesktopGitWorkerBridge({
      appPath: "/Applications/Codex.app",
      resolveWorkerScript: async () => ({
        workerPath: "/tmp/pocodex-worker.js",
        metadata: {
          appPath: "/Applications/Codex.app",
          buildFlavor: "stable",
          buildNumber: "123",
          version: "1.2.3",
        },
      }),
      WorkerClass: FakeWorker as never,
    });

    await bridge.subscribe();

    const worker = FakeWorker.instances[0];
    worker?.emit("message", {
      type: "worker-main-rpc-request",
      workerId: "git",
      requestId: "rpc-2",
      method: "unknown-method",
    });

    expect(worker?.postedMessages.at(-1)).toEqual({
      type: "worker-main-rpc-response",
      workerId: "git",
      requestId: "rpc-2",
      method: "unknown-method",
      result: {
        type: "error",
        error: {
          message: 'Unsupported git worker main RPC method "unknown-method" in Pocodex.',
        },
      },
    });

    await bridge.close();
  });

  it("emits deterministic worker errors on unexpected exit and recreates the worker", async () => {
    const bridge = new DefaultCodexDesktopGitWorkerBridge({
      appPath: "/Applications/Codex.app",
      resolveWorkerScript: async () => ({
        workerPath: "/tmp/pocodex-worker.js",
        metadata: {
          appPath: "/Applications/Codex.app",
          buildFlavor: "stable",
          buildNumber: "123",
          version: "1.2.3",
        },
      }),
      WorkerClass: FakeWorker as never,
    });
    const messages: unknown[] = [];
    const errors: Error[] = [];
    bridge.on("message", (message) => {
      messages.push(message);
    });
    bridge.on("error", (error) => {
      errors.push(error);
    });

    await bridge.send({
      type: "worker-request",
      workerId: "git",
      request: {
        id: "req-9",
        method: "status-summary",
      },
    });

    const firstWorker = FakeWorker.instances[0];
    firstWorker?.emit("exit", 9);

    expect(messages).toEqual([
      {
        type: "worker-response",
        workerId: "git",
        response: {
          id: "req-9",
          method: "status-summary",
          result: {
            type: "error",
            error: {
              message: "Codex desktop git worker exited unexpectedly with code 9.",
            },
          },
        },
      },
    ]);
    expect(errors.at(-1)?.message).toBe(
      "Codex desktop git worker exited unexpectedly with code 9.",
    );

    await bridge.send({
      type: "worker-request",
      workerId: "git",
      request: {
        id: "req-10",
        method: "current-branch",
      },
    });

    expect(FakeWorker.instances).toHaveLength(2);
    expect(FakeWorker.instances[1]?.postedMessages).toEqual([
      {
        type: "worker-request",
        workerId: "git",
        request: {
          id: "req-10",
          method: "current-branch",
        },
      },
    ]);

    await bridge.close();
  });
});
