import vm from "node:vm";

import { describe, expect, it } from "vitest";

import { renderBootstrapScript } from "../src/lib/bootstrap-script.js";

describe("renderBootstrapScript tokenless auth", () => {
  it("validates without appending a token when the page URL has no token", () => {
    const script = renderBootstrapScript({
      sentryOptions: {
        buildFlavor: "stable",
        appVersion: "1",
        buildNumber: "123",
        codexAppSessionId: "session-id",
      },
      stylesheetHref: "/pocodex.css",
      importIconSvg: '<svg viewBox="0 0 1 1"></svg>',
    });

    class Element {
      dataset: Record<string, string> = {};
      parentElement: Element | null = null;
      hidden = false;
      id = "";
      rel = "";
      href = "";
      textContent = "";

      appendChild<T extends Element>(child: T): T {
        child.parentElement = this;
        return child;
      }

      append(..._nodes: Element[]): void {}

      contains(_node: Element): boolean {
        return false;
      }

      replaceChildren(..._nodes: Element[]): void {}

      remove(): void {}

      after(_node: Element): void {}

      querySelector(_selector: string): Element | null {
        return null;
      }

      querySelectorAll(_selector: string): {
        length: number;
        item(index: number): Element | null;
        forEach(callback: (value: Element, key: number, parent: unknown) => void): void;
      } {
        return {
          length: 0,
          item: () => null,
          forEach: () => {},
        };
      }

      addEventListener(
        _type: string,
        _listener: (...args: unknown[]) => void,
        _options?: unknown,
      ): void {}

      getAttribute(_name: string): string | null {
        return null;
      }
    }

    class HTMLDivElement extends Element {}
    class HTMLLinkElement extends Element {}

    class Document extends Element {
      readyState = "complete";
      visibilityState = "visible";
      documentElement = new Element();
      head = new Element();
      body = new Element();

      createElement(tagName: string): Element {
        if (tagName === "div") {
          return new HTMLDivElement();
        }
        if (tagName === "link") {
          return new HTMLLinkElement();
        }
        return new Element();
      }

      getElementsByTagName(tagName: string): Element[] {
        return tagName === "head" ? [this.head] : [];
      }

      getElementById(_id: string): Element | null {
        return null;
      }

      hasFocus(): boolean {
        return true;
      }
    }

    class MutationObserver {
      constructor(_callback: (...args: unknown[]) => void) {}

      observe(_target: Element, _options: unknown): void {}
    }

    class Request {
      method = "GET";

      constructor(readonly url: string) {}
    }

    class Response {
      constructor(
        readonly body: string,
        readonly init: {
          status: number;
          headers: Record<string, string>;
        },
      ) {}
    }

    class MessageEvent {
      constructor(
        readonly type: string,
        readonly init: { data: unknown },
      ) {}
    }

    class WebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;

      readyState = WebSocket.CONNECTING;

      constructor(readonly url: string) {}

      addEventListener(_type: string, _listener: (...args: unknown[]) => void): void {}

      send(_message: string): void {}

      close(_code?: number, _reason?: string): void {
        this.readyState = WebSocket.CLOSED;
      }
    }

    const storage = new Map<string, string>();
    const document = new Document();
    const fetchCalls: Array<{ input: unknown; init: unknown }> = [];
    const windowObject = {
      location: {
        href: "http://127.0.0.1:8787/",
        protocol: "http:",
        host: "127.0.0.1:8787",
        origin: "http://127.0.0.1:8787",
      },
      history: {
        pushState: (_data: unknown, _unused: string, _url?: string | URL | null) => {},
        replaceState: (_data: unknown, _unused: string, _url?: string | URL | null) => {},
      },
      fetch: async (input: unknown, init?: unknown) => {
        fetchCalls.push({ input, init });
        return { ok: true, status: 200 };
      },
      setTimeout: (_callback: () => void, _delay: number) => 0,
      clearTimeout: (_id: number) => {},
      addEventListener: (
        _type: string,
        _listener: (...args: unknown[]) => void,
        _options?: unknown,
      ) => {},
      dispatchEvent: (_event: unknown) => true,
      locationReloaded: false,
    };

    Object.assign(windowObject.location, {
      reload: () => {
        windowObject.locationReloaded = true;
      },
    });

    const context = vm.createContext({
      window: windowObject,
      document,
      URL,
      HTMLDivElement,
      HTMLLinkElement,
      MutationObserver,
      MessageEvent,
      Request,
      Response,
      WebSocket,
      sessionStorage: {
        setItem: (key: string, value: string) => {
          storage.set(key, value);
        },
        getItem: (key: string) => storage.get(key) ?? null,
      },
      Element,
      Object,
      Array,
      Map,
      Set,
      Math,
      JSON,
      Promise,
      String,
      Number,
      Boolean,
      encodeURIComponent,
    });

    expect(() => vm.runInContext(script, context)).not.toThrow();
    expect(fetchCalls).toContainEqual({
      input: "/session-check",
      init: {
        cache: "no-store",
        credentials: "same-origin",
      },
    });
  });
});
