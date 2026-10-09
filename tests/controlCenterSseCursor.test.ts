import { describe, expect, it } from "vitest";
import { LocalControlCenterV1 } from "../src/control-center/server.js";
import { pairControlCenter } from "./helpers/controlCenterSession.js";

/**
 * Track B2 (Track D GAP-1): the SSE cursor must fail closed. handle()
 * delegates to the async eventsStream(), whose decodeEventCursor throws
 * synchronously before its first await; without validation inside handle()'s
 * try/catch that rejection escaped as an unhandled rejection with a hung
 * response. These tests prove an invalid Last-Event-ID answers 400 promptly.
 */
describe("Control Center SSE cursor fail-closed", () => {
  it("rejects a malformed Last-Event-ID with 400 instead of hanging", async () => {
    const center = new LocalControlCenterV1();
    const started = await center.start();
    try {
      const session = await pairControlCenter(started);
      const response = await fetch(`${started.url}api/v1/events`, {
        headers: { ...session.headers(), "Last-Event-ID": "!!!not-a-cursor!!!" },
      });
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("cursor");
    } finally {
      await center.close();
    }
  }, 10_000);

  it("rejects a well-formed-encoding non-cursor payload with 400", async () => {
    const center = new LocalControlCenterV1();
    const started = await center.start();
    try {
      const session = await pairControlCenter(started);
      const forged = Buffer.from(JSON.stringify({ nope: 1 }), "utf8").toString("base64url");
      const response = await fetch(`${started.url}api/v1/events`, {
        headers: { ...session.headers(), "Last-Event-ID": forged },
      });
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("cursor");
    } finally {
      await center.close();
    }
  }, 10_000);
});
