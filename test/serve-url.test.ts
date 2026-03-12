import type { NetworkInterfaceInfo } from "node:os";

import { describe, expect, it } from "vitest";

import { getServeUrls } from "../src/lib/serve-url.js";

describe("getServeUrls", () => {
  it("uses loopback for the local URL and prints a LAN URL for wildcard hosts", () => {
    const urls = getServeUrls({
      listenHost: "0.0.0.0",
      listenPort: 8787,
      token: "secret token",
      interfacesByName: {
        en0: [ipv4("192.168.1.24")],
      },
    });

    expect(urls).toEqual({
      localUrl: "http://127.0.0.1:8787/",
      localOpenUrl: "http://127.0.0.1:8787/?token=secret+token",
      networkUrl: "http://192.168.1.24:8787/",
      networkOpenUrl: "http://192.168.1.24:8787/?token=secret+token",
    });
  });

  it("does not invent a LAN URL for loopback-only listening", () => {
    const urls = getServeUrls({
      listenHost: "127.0.0.1",
      listenPort: 8787,
      token: "secret",
      interfacesByName: {
        en0: [ipv4("192.168.1.24")],
      },
    });

    expect(urls).toEqual({
      localUrl: "http://127.0.0.1:8787/",
      localOpenUrl: "http://127.0.0.1:8787/?token=secret",
      networkUrl: undefined,
      networkOpenUrl: undefined,
    });
  });

  it("prefers a LAN interface over a VPN interface when both are present", () => {
    const urls = getServeUrls({
      listenHost: "0.0.0.0",
      listenPort: 8787,
      token: "secret",
      interfacesByName: {
        utun4: [ipv4("10.0.8.15")],
        en0: [ipv4("192.168.1.24")],
      },
    });

    expect(urls.networkUrl).toBe("http://192.168.1.24:8787/");
    expect(urls.networkOpenUrl).toBe("http://192.168.1.24:8787/?token=secret");
  });

  it("omits the token query when no token is configured", () => {
    const urls = getServeUrls({
      listenHost: "0.0.0.0",
      listenPort: 8787,
      token: "",
      interfacesByName: {
        en0: [ipv4("192.168.1.24")],
      },
    });

    expect(urls).toEqual({
      localUrl: "http://127.0.0.1:8787/",
      localOpenUrl: "http://127.0.0.1:8787/",
      networkUrl: "http://192.168.1.24:8787/",
      networkOpenUrl: "http://192.168.1.24:8787/",
    });
  });
});

function ipv4(address: string): NetworkInterfaceInfo {
  return {
    address,
    netmask: "255.255.255.0",
    family: "IPv4",
    mac: "00:00:00:00:00:00",
    internal: false,
    cidr: `${address}/24`,
  };
}
