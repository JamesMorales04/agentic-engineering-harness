import { describe, expect, it } from "vitest";
import { DELEGATION_EXPIRING_SOON_MS, describeDelegationExpiry, formatDelegationCountdown } from "../ui/control-center/src/api.js";

const HOUR = 3_600_000;
const DAY = 86_400_000;
const NOW = Date.parse("2026-10-16T00:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

describe("delegation expiry countdown (deterministic formatting)", () => {
  it("renders future expiries in days, hours, minutes", () => {
    expect(formatDelegationCountdown(iso(NOW + 30 * DAY), NOW)).toBe("expires in 30d");
    expect(formatDelegationCountdown(iso(NOW + 3 * HOUR), NOW)).toBe("expires in 3h");
    expect(formatDelegationCountdown(iso(NOW + 12 * 60_000), NOW)).toBe("expires in 12m");
    expect(formatDelegationCountdown(iso(NOW + 30_000), NOW)).toBe("expires in <1m");
  });

  it("rolls over exact unit boundaries downward", () => {
    expect(formatDelegationCountdown(iso(NOW + 60_000), NOW)).toBe("expires in 1m");
    expect(formatDelegationCountdown(iso(NOW + HOUR), NOW)).toBe("expires in 1h");
    expect(formatDelegationCountdown(iso(NOW + DAY), NOW)).toBe("expires in 1d");
    expect(formatDelegationCountdown(iso(NOW - 60_000), NOW)).toBe("expired 1m ago");
    expect(formatDelegationCountdown(iso(NOW - HOUR), NOW)).toBe("expired 1h ago");
    expect(formatDelegationCountdown(iso(NOW - DAY), NOW)).toBe("expired 1d ago");
  });

  it("renders past expiries as ago with a just-now edge", () => {
    expect(formatDelegationCountdown(iso(NOW - 30_000), NOW)).toBe("expired just now");
    expect(formatDelegationCountdown(iso(NOW - 5 * 60_000), NOW)).toBe("expired 5m ago");
    expect(formatDelegationCountdown(iso(NOW - 2 * HOUR), NOW)).toBe("expired 2h ago");
    expect(formatDelegationCountdown(iso(NOW - 3 * DAY), NOW)).toBe("expired 3d ago");
  });

  it("renders unknown for missing or unparseable input", () => {
    expect(formatDelegationCountdown(undefined, NOW)).toBe("expiry unknown");
    expect(formatDelegationCountdown("not-a-date", NOW)).toBe("expiry unknown");
  });

  it("classifies urgency tones with a 24h boundary", () => {
    expect(DELEGATION_EXPIRING_SOON_MS).toBe(24 * HOUR);
    const base = { expiresAt: iso(NOW + 30 * DAY), revoked: false, validNow: true };
    expect(describeDelegationExpiry(base, NOW)).toEqual({ text: "expires in 30d", tone: "normal" });
    expect(describeDelegationExpiry({ ...base, expiresAt: iso(NOW + 23 * HOUR) }, NOW).tone).toBe("expiring-soon");
    expect(describeDelegationExpiry({ ...base, expiresAt: iso(NOW + 24 * HOUR) }, NOW).tone).toBe("normal");
    expect(describeDelegationExpiry({ ...base, expiresAt: iso(NOW - HOUR) }, NOW)).toEqual({ text: "expired 1h ago", tone: "expired" });
    expect(describeDelegationExpiry({ ...base, revoked: true }, NOW)).toEqual({ text: "revoked", tone: "revoked" });
    expect(describeDelegationExpiry({ expiresAt: "bad", revoked: false, validNow: false }, NOW)).toEqual({ text: "expiry unknown", tone: "unknown" });
  });
});
