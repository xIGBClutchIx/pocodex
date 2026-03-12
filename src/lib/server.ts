import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { resolve, sep } from "node:path";
import { readFile } from "node:fs/promises";
import type { Duplex } from "node:stream";
import { randomUUID } from "node:crypto";

import mimeTypes from "mime-types";
import { WebSocket, WebSocketServer } from "ws";

import { debugLog } from "./debug.js";
import { getUnsupportedBridgeNotice } from "./native-policy.js";
import type {
  BrowserToServerEnvelope,
  PocodexServerOptions,
  ServerToBrowserEnvelope,
} from "./protocol.js";
import { routeHostMessage, rewriteRequestIdsForHost } from "./request-id.js";

interface BrowserSession {
  id: string;
  socket: WebSocket;
  subscribedWorkers: Set<string>;
  isFocused: boolean;
}

export class PocodexServer {
  private readonly httpServer: HttpServer;
  private readonly wsServer: WebSocketServer;
  private readonly pendingBySocket = new WeakMap<WebSocket, Promise<void>>();
  private activeSession?: BrowserSession;
  private indexHtmlPromise?: Promise<string>;

  constructor(private readonly options: PocodexServerOptions) {
    this.httpServer = createServer((request, response) => {
      void this.handleHttpRequest(request, response);
    });
    this.wsServer = new WebSocketServer({ noServer: true });

    this.httpServer.on("upgrade", (request, socket, head) => {
      this.handleUpgrade(request, socket, head);
    });
    this.wsServer.on("connection", (socket) => {
      this.handleConnection(socket);
    });

    this.options.relay.on("bridge_message", (message) => {
      this.handleRelayBridgeMessage(message);
    });
    this.options.relay.on("worker_message", (workerName, message) => {
      this.handleRelayWorkerMessage(workerName, message);
    });
    this.options.relay.on("error", (error) => {
      this.sendToActiveSession({
        type: "error",
        message: error.message,
      });
    });
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolvePromise, reject) => {
      this.httpServer.once("error", reject);
      this.httpServer.listen(this.options.listenPort, this.options.listenHost, () => {
        this.httpServer.off("error", reject);
        resolvePromise();
      });
    });
  }

  async close(): Promise<void> {
    if (this.activeSession) {
      this.activeSession.socket.close(1000, "shutdown");
      this.activeSession = undefined;
    }

    for (const client of this.wsServer.clients) {
      client.terminate();
    }

    await new Promise<void>((resolvePromise) => {
      this.wsServer.close(() => resolvePromise());
    });

    await new Promise<void>((resolvePromise, reject) => {
      this.httpServer.closeIdleConnections?.();
      this.httpServer.closeAllConnections?.();
      this.httpServer.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolvePromise();
      });
    });
  }

  getAddress(): AddressInfo {
    const address = this.httpServer.address();
    if (!address || typeof address === "string") {
      throw new Error("Pocodex server is not listening on a TCP address");
    }
    return address;
  }

  notifyStylesheetReload(versionTag: string): void {
    this.sendToActiveSession({
      type: "css_reload",
      href: `/pocodex.css?v=${encodeURIComponent(versionTag)}`,
    });
  }

  private async handleHttpRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const url = new URL(
      request.url ?? "/",
      `http://${this.options.listenHost}:${this.options.listenPort}`,
    );

    if (url.pathname === "/" || url.pathname === "/index.html") {
      response.statusCode = 200;
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(await this.getIndexHtml());
      return;
    }

    if (url.pathname === "/session-check") {
      const authorized = this.isAuthorized(url.searchParams.get("token"));
      response.statusCode = authorized ? 200 : 401;
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.end(JSON.stringify({ ok: authorized }));
      return;
    }

    if (url.pathname === "/pocodex.css") {
      try {
        response.statusCode = 200;
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("Content-Type", "text/css; charset=utf-8");
        response.end(await this.options.readPocodexStylesheet());
      } catch {
        response.statusCode = 500;
        response.end("Unable to load Pocodex stylesheet");
      }
      return;
    }

    if (url.pathname === "/healthz") {
      response.statusCode = 200;
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.end(JSON.stringify({ ok: true }));
      return;
    }

    if (url.pathname === "/ipc-request") {
      await this.handleIpcRequest(request, response);
      return;
    }

    const relativePath = url.pathname.replace(/^\/+/, "");
    const absolutePath = resolve(this.options.webviewRoot, relativePath);
    if (!absolutePath.startsWith(`${this.options.webviewRoot}${sep}`)) {
      response.statusCode = 404;
      response.end("Not found");
      return;
    }

    try {
      const fileBuffer = await readFile(absolutePath);
      response.statusCode = 200;
      response.setHeader("Cache-Control", "public, max-age=3600");
      response.setHeader(
        "Content-Type",
        mimeTypes.lookup(absolutePath) || "application/octet-stream",
      );
      response.end(fileBuffer);
    } catch {
      response.statusCode = 404;
      response.end("Not found");
    }
  }

  private handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(
      request.url ?? "/",
      `http://${this.options.listenHost}:${this.options.listenPort}`,
    );
    if (url.pathname !== "/session") {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }

    if (!this.isAuthorized(url.searchParams.get("token"))) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    this.wsServer.handleUpgrade(request, socket, head, (upgradedSocket) => {
      this.wsServer.emit("connection", upgradedSocket, request);
    });
  }

  private handleConnection(socket: WebSocket): void {
    const session: BrowserSession = {
      id: randomUUID(),
      socket,
      subscribedWorkers: new Set(),
      isFocused: true,
    };

    if (this.activeSession) {
      this.send(this.activeSession.socket, {
        type: "session_revoked",
        reason: "This Pocodex session was replaced by another browser.",
      });
      for (const workerName of this.activeSession.subscribedWorkers) {
        void this.options.relay.unsubscribeWorker(workerName);
      }
      this.activeSession.socket.close(4001, "replaced");
    }

    this.activeSession = session;
    debugLog("server", "browser connected", { sessionId: session.id });

    socket.on("message", (data) => {
      const previous = this.pendingBySocket.get(socket) ?? Promise.resolve();
      const next = previous
        .then(() => this.handleSocketMessage(session, String(data)))
        .catch((error) => {
          this.send(socket, {
            type: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        });
      this.pendingBySocket.set(socket, next);
    });

    socket.on("close", () => {
      debugLog("server", "browser disconnected", { sessionId: session.id });
      if (this.activeSession?.id !== session.id) {
        return;
      }

      for (const workerName of session.subscribedWorkers) {
        void this.options.relay.unsubscribeWorker(workerName);
      }
      this.activeSession = undefined;
    });
  }

  private isAuthorized(requestToken: string | null): boolean {
    return this.options.token.length === 0 || requestToken === this.options.token;
  }

  private async handleSocketMessage(session: BrowserSession, raw: string): Promise<void> {
    const envelope = JSON.parse(raw) as BrowserToServerEnvelope;
    debugLog("server", "browser message", envelope);

    if (this.activeSession?.id !== session.id) {
      this.send(session.socket, {
        type: "session_revoked",
        reason: "This Pocodex session is no longer active.",
      });
      session.socket.close(4001, "inactive");
      return;
    }

    switch (envelope.type) {
      case "bridge_message":
        await this.handleBridgeEnvelope(session, envelope.message);
        break;
      case "worker_subscribe":
        if (!session.subscribedWorkers.has(envelope.workerName)) {
          session.subscribedWorkers.add(envelope.workerName);
          await this.options.relay.subscribeWorker(envelope.workerName);
        }
        break;
      case "worker_unsubscribe":
        if (session.subscribedWorkers.delete(envelope.workerName)) {
          await this.options.relay.unsubscribeWorker(envelope.workerName);
        }
        break;
      case "worker_message":
        await this.options.relay.sendWorkerMessage(envelope.workerName, envelope.message);
        break;
      case "focus_state":
        session.isFocused = envelope.isFocused;
        this.send(session.socket, {
          type: "bridge_message",
          message: {
            type: "electron-window-focus-changed",
            isFocused: envelope.isFocused,
          },
        });
        break;
      default:
        this.send(session.socket, {
          type: "error",
          message: `Unknown Pocodex browser message ${(envelope as { type: string }).type}`,
        });
    }
  }

  private async handleBridgeEnvelope(session: BrowserSession, message: unknown): Promise<void> {
    if (
      typeof message === "object" &&
      message !== null &&
      "type" in message &&
      (message as { type?: unknown }).type === "electron-window-focus-request"
    ) {
      this.send(session.socket, {
        type: "bridge_message",
        message: {
          type: "electron-window-focus-changed",
          isFocused: session.isFocused,
        },
      });
      return;
    }

    const blockedNotice = getUnsupportedBridgeNotice(message);
    if (blockedNotice) {
      debugLog("server", "blocked browser bridge message", {
        message,
        blockedNotice,
      });
      // this.send(session.socket, {
      //   type: "client_notice",
      //   message: blockedNotice,
      // });
      return;
    }

    const rewrittenMessage = rewriteRequestIdsForHost(session.id, message);
    debugLog("server", "forwarding bridge message to relay", rewrittenMessage);
    await this.options.relay.forwardBridgeMessage(rewrittenMessage);
  }

  private async handleIpcRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const rawBody = await readRequestBody(request);
    let payload: unknown;
    try {
      payload = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      response.statusCode = 400;
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.end(
        JSON.stringify({
          requestId: "",
          type: "response",
          resultType: "error",
          error: "Invalid JSON body.",
        }),
      );
      return;
    }

    if (!this.options.relay.handleIpcRequest) {
      response.statusCode = 501;
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.end(
        JSON.stringify({
          requestId: extractRequestId(payload),
          type: "response",
          resultType: "error",
          error: "IPC requests are not supported by the active host bridge.",
        }),
      );
      return;
    }

    try {
      const result = await this.options.relay.handleIpcRequest(payload);
      response.statusCode = 200;
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.end(JSON.stringify(result));
    } catch (error) {
      response.statusCode = 500;
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.end(
        JSON.stringify({
          requestId: extractRequestId(payload),
          type: "response",
          resultType: "error",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  private handleRelayBridgeMessage(message: unknown): void {
    debugLog("server", "relay bridge message", message);
    const routed = routeHostMessage(message);
    if (!routed.deliver || !routed.message) {
      debugLog("server", "dropped relay bridge message", routed);
      return;
    }

    if (routed.sessionId && this.activeSession?.id !== routed.sessionId) {
      return;
    }

    this.sendToActiveSession({
      type: "bridge_message",
      message: routed.message,
    });
  }

  private handleRelayWorkerMessage(workerName: string, message: unknown): void {
    debugLog("server", "relay worker message", { workerName, message });
    if (!this.activeSession?.subscribedWorkers.has(workerName)) {
      return;
    }

    this.sendToActiveSession({
      type: "worker_message",
      workerName,
      message,
    });
  }

  private sendToActiveSession(envelope: ServerToBrowserEnvelope): void {
    if (!this.activeSession) {
      return;
    }
    this.send(this.activeSession.socket, envelope);
  }

  private send(socket: WebSocket, envelope: ServerToBrowserEnvelope): void {
    if (socket.readyState !== WebSocket.OPEN) {
      return;
    }
    socket.send(JSON.stringify(envelope));
  }

  private getIndexHtml(): Promise<string> {
    if (!this.indexHtmlPromise) {
      this.indexHtmlPromise = this.options.renderIndexHtml();
    }
    return this.indexHtmlPromise;
  }
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function extractRequestId(payload: unknown): string {
  return typeof payload === "object" &&
    payload !== null &&
    "requestId" in payload &&
    typeof payload.requestId === "string"
    ? payload.requestId
    : "";
}
