import { describe, expect, it } from "vitest";

import { getUnsupportedBridgeNotice } from "../src/lib/native-policy.js";

describe("native-policy", () => {
  it("blocks known native-only bridge messages", () => {
    expect(getUnsupportedBridgeNotice({ type: "desktop-notification-request" })).toBe(
      "Desktop notifications are not supported in Pocodex.",
    );
    expect(getUnsupportedBridgeNotice({ type: "window-mode-toggle" })).toBe(
      "Window mode controls are not supported in Pocodex.",
    );
  });

  it("allows ordinary host messages through", () => {
    expect(getUnsupportedBridgeNotice({ type: "fetch", requestId: "1" })).toBeNull();
  });
});
