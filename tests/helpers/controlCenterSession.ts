import type { StartedControlCenterV1 } from "../../src/control-center/server.js";

export interface ControlCenterTestSession {
  cookie: string;
  csrfToken: string;
  origin: string;
  headers(mutate?: boolean): Record<string, string>;
}

export async function pairControlCenter(started: StartedControlCenterV1): Promise<ControlCenterTestSession> {
  const nonce = new URL(started.pairingUrl).hash.slice("#pair=".length);
  const origin = new URL(started.url).origin;
  const response = await fetch(`${started.url}api/v1/pair`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ nonce })
  });
  if (!response.ok) throw new Error(`Control Center test pairing failed: HTTP ${response.status}`);
  const value: unknown = await response.json();
  if (!value || typeof value !== "object" || !("csrfToken" in value) || typeof value.csrfToken !== "string") throw new Error("Control Center did not return a session CSRF token.");
  const cookieHeader = response.headers.get("set-cookie");
  if (!cookieHeader) throw new Error("Control Center did not set a session cookie.");
  const cookie = cookieHeader.split(";", 1)[0];
  return {
    cookie,
    csrfToken: value.csrfToken,
    origin,
    headers(mutate = false) {
      return {
        Cookie: cookie,
        ...(mutate ? { Origin: origin, "X-AEH-CSRF": value.csrfToken } : {})
      };
    }
  };
}
