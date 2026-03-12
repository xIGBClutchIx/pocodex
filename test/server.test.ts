import { EventEmitter } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { PocodexServer } from "../src/lib/server.js";

class StubRelay extends EventEmitter {
  forwardedMessages: unknown[] = [];
  subscribedWorkers: string[] = [];
  unsubscribedWorkers: string[] = [];
  workerMessages: Array<{ workerName: string; message: unknown }> = [];
  ipcPayloads: unknown[] = [];

  async forwardBridgeMessage(message: unknown): Promise<void> {
    this.forwardedMessages.push(message);
  }

  async subscribeWorker(workerName: string): Promise<void> {
    this.subscribedWorkers.push(workerName);
  }

  async unsubscribeWorker(workerName: string): Promise<void> {
    this.unsubscribedWorkers.push(workerName);
  }

  async sendWorkerMessage(workerName: string, message: unknown): Promise<void> {
    this.workerMessages.push({ workerName, message });
  }

  async handleIpcRequest(payload: unknown): Promise<unknown> {
    this.ipcPayloads.push(payload);
    return {
      requestId:
        typeof payload === "object" &&
        payload !== null &&
        "requestId" in payload &&
        typeof payload.requestId === "string"
          ? payload.requestId
          : "",
      type: "response",
      resultType: "success",
      result: {
        ok: true,
      },
    };
  }
}

describe("PocodexServer", () => {
  const servers: PocodexServer[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(async (server) => {
        await server.close();
      }),
    );
  });

  it("rewrites browser request IDs and strips them on the way back", async () => {
    const { server, relay, url } = await createTestServer();
    servers.push(server);

    const socket = await connect(url, "secret");
    const firstMessage = nextMessage(socket);

    socket.send(
      JSON.stringify({
        type: "bridge_message",
        message: {
          type: "fetch",
          requestId: "request-1",
          url: "vscode://codex/thread/list",
        },
      }),
    );

    await waitForCondition(() => relay.forwardedMessages.length === 1);

    expect(relay.forwardedMessages[0]).toEqual({
      type: "fetch",
      requestId: expect.stringMatching(/^pocodex:[^:]+:request-1$/),
      url: "vscode://codex/thread/list",
    });

    const prefixedRequestId = (relay.forwardedMessages[0] as { requestId: string }).requestId;
    relay.emit("bridge_message", {
      type: "fetch-response",
      requestId: prefixedRequestId,
      status: 200,
    });

    await expect(firstMessage).resolves.toEqual({
      type: "bridge_message",
      message: {
        type: "fetch-response",
        requestId: "request-1",
        status: 200,
      },
    });

    socket.close();
  });

  it("revokes the first browser session when a second client connects", async () => {
    const { server, relay, url } = await createTestServer();
    servers.push(server);

    const first = await connect(url, "secret");
    first.send(JSON.stringify({ type: "worker_subscribe", workerName: "git" }));
    await waitForCondition(() => relay.subscribedWorkers.includes("git"));

    const revoked = nextMessage(first);
    const second = await connect(url, "secret");

    await expect(revoked).resolves.toEqual({
      type: "session_revoked",
      reason: "This Pocodex session was replaced by another browser.",
    });

    await waitForCondition(() => relay.unsubscribedWorkers.includes("git"));

    first.close();
    second.close();
  });

  it("serves the Pocodex stylesheet from its dedicated route", async () => {
    const { server, url } = await createTestServer();
    servers.push(server);

    const response = await fetch(`${url}/pocodex.css`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/css");
    await expect(response.text()).resolves.toContain("[data-pocodex-toast]");
  });

  it("validates session tokens before websocket attach", async () => {
    const { server, url } = await createTestServer();
    servers.push(server);

    const okResponse = await fetch(`${url}/session-check?token=secret`);
    const unauthorizedResponse = await fetch(`${url}/session-check?token=wrong`);

    expect(okResponse.status).toBe(200);
    await expect(okResponse.json()).resolves.toEqual({ ok: true });

    expect(unauthorizedResponse.status).toBe(401);
    await expect(unauthorizedResponse.json()).resolves.toEqual({ ok: false });
  });

  it("allows unauthenticated session checks and websocket attach when no token is configured", async () => {
    const { server, url } = await createTestServer("");
    servers.push(server);

    const okResponse = await fetch(`${url}/session-check`);
    const tokenResponse = await fetch(`${url}/session-check?token=anything`);

    expect(okResponse.status).toBe(200);
    await expect(okResponse.json()).resolves.toEqual({ ok: true });

    expect(tokenResponse.status).toBe(200);
    await expect(tokenResponse.json()).resolves.toEqual({ ok: true });

    const socket = await connect(url);
    socket.close();
  });

  it("pushes css reload notifications to the active browser session", async () => {
    const { server, url } = await createTestServer();
    servers.push(server);

    const socket = await connect(url, "secret");
    const next = nextMessage(socket);

    server.notifyStylesheetReload("123");

    await expect(next).resolves.toEqual({
      type: "css_reload",
      href: "/pocodex.css?v=123",
    });

    socket.close();
  });

  it("routes vscode ipc requests through the relay", async () => {
    const { server, relay, url } = await createTestServer();
    servers.push(server);

    const response = await fetch(`${url}/ipc-request`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        requestId: "req-1",
        method: "thread-follower-start-turn",
        params: {
          conversationId: "thr_123",
        },
      }),
    });

    expect(response.status).toBe(200);
    expect(relay.ipcPayloads).toEqual([
      {
        requestId: "req-1",
        method: "thread-follower-start-turn",
        params: {
          conversationId: "thr_123",
        },
      },
    ]);
    await expect(response.json()).resolves.toEqual({
      requestId: "req-1",
      type: "response",
      resultType: "success",
      result: {
        ok: true,
      },
    });
  });
});

async function createTestServer(): Promise<{
  relay: StubRelay;
  server: PocodexServer;
  url: string;
}>;
async function createTestServer(token = "secret"): Promise<{
  relay: StubRelay;
  server: PocodexServer;
  url: string;
}> {
  const relay = new StubRelay();
  const webviewRoot = await mkdtemp(join(tmpdir(), "pocodex-webview-"));
  await writeFile(join(webviewRoot, "index.html"), "<!doctype html><html><body></body></html>");

  const server = new PocodexServer({
    listenHost: "127.0.0.1",
    listenPort: 0,
    token,
    relay: relay as never,
    webviewRoot,
    readPocodexStylesheet: async () => "#pocodex-toast-host [data-pocodex-toast] { color: red; }",
    renderIndexHtml: async () => "<!doctype html><html><body></body></html>",
  });

  await server.listen();
  const address = server.getAddress();

  return {
    relay,
    server,
    url: `http://${address.address}:${address.port}`,
  };
}

async function connect(baseUrl: string, token?: string): Promise<WebSocket> {
  const url = new URL(`${baseUrl.replace(/^http/, "ws")}/session`);
  if (token) {
    url.searchParams.set("token", token);
  }
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  return socket;
}

async function nextMessage(socket: WebSocket): Promise<unknown> {
  const data = await new Promise<string>((resolve, reject) => {
    socket.once("message", (buffer) => resolve(String(buffer)));
    socket.once("error", reject);
    socket.once("close", () => reject(new Error("socket closed before a message arrived")));
  });
  return JSON.parse(data);
}

async function waitForCondition(predicate: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > 2_000) {
      throw new Error("Condition did not become true in time");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
