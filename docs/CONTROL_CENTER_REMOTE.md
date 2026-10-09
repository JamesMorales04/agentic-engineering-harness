# Control Center Remote Access (Mobile Home)

AEH Home / Control Center is loopback-only by default. Private mobile access
is an explicit opt-in via a trusted local proxy, preferably
**Tailscale Serve**. No public internet exposure (no Tailscale Funnel) is used
by default, and the server never listens on `0.0.0.0` for remote access.

Architecture:

```
Mobile browser
  → private Tailnet HTTPS endpoint (https://<machine>.<tailnet>.ts.net)
  → trusted local proxy (tailscale serve → http://127.0.0.1:<port>)
  → loopback AEH Control Center (still binds 127.0.0.1)
```

## Setup (Owner consent required)

Installing software, joining a Tailnet, and changing network-wide settings
require genuine Owner setup and consent. AEH never performs these steps
autonomously.

1. Install and authenticate Tailscale on the workstation (Owner step).
2. Start AEH with explicit remote allowlists:

```bash
aeh home \
  --remote-mode trusted-proxy \
  --allowed-origin https://myhost.mytailnet.ts.net \
  --allowed-host myhost.mytailnet.ts.net

# or per-project:
aeh control-center . \
  --remote-mode trusted-proxy \
  --allowed-origin https://myhost.mytailnet.ts.net \
  --allowed-host myhost.mytailnet.ts.net
```

Environment equivalents (used when flags are omitted):

```bash
export AEH_CONTROL_CENTER_REMOTE_MODE=trusted-proxy
export AEH_CONTROL_CENTER_ALLOWED_ORIGINS=https://myhost.mytailnet.ts.net
export AEH_CONTROL_CENTER_ALLOWED_HOSTS=myhost.mytailnet.ts.net
```

3. Expose the loopback port over the Tailnet only:

```bash
tailscale serve --bg http://127.0.0.1:<port>
```

Use `tailscale serve` (private Tailnet), not `tailscale funnel` (public).

4. On the phone, open `https://myhost.mytailnet.ts.net` and append the
single-use pairing fragment printed by AEH (`#pair=...`). The fragment is
cleared from the URL immediately after pairing. Never share pairing nonces
in logs, Git, screenshots, or campaign artifacts.

## Status

- `aeh home` / `aeh control-center` print `controlCenterRemote=disabled
  (loopback-only)` or `controlCenterRemote=trusted-proxy origins=...`.
- `GET /api/v1/overview` reports
  `security: { loopbackOnly, remoteMode, allowedHosts, authenticated,
  csrfForMutations }`.
- The UI Assurance card shows `Loopback only` or
  `Private remote access · <hosts>`.

## Security (preserved and strengthened)

- Default loopback-only mode is byte-identical when remote is not configured.
- Explicit opt-in with a fixed, validated HTTPS external origin (exact match,
  no suffix matching, no paths/queries/credentials).
- Origin and Host allowlisting (exact match).
- The TCP peer must be loopback, proving the request came via the trusted
  local proxy. Non-loopback peers are rejected.
- Only `X-Forwarded-For` / `X-Forwarded-Proto` from the loopback peer are
  tolerated (never used for auth). `Forwarded`, `X-Forwarded-Host`,
  `X-Real-IP` are always rejected. Multi-hop chains are rejected.
- A remote Host without a single-hop `X-Forwarded-Proto: https` marker fails
  closed (proxy misconfiguration).
- Authentication and session integrity are unchanged: single-use pairing
  nonce (timing-safe, bounded lifetime), `HttpOnly; SameSite=Strict`
  session cookie (`Secure` in remote mode), per-session CSRF token on every
  state-changing endpoint.
- No trust in arbitrary client-supplied forwarded or identity headers.
- No unauthorized access to local files or processes (static boundary, CSP,
  loopback-only health probes unchanged).
- Disabling remote access (restart without `--remote-mode`) revokes the
  external entry point; loopback remains.

## Mobile functionality

The responsive UI (viewport meta, 820px/520px breakpoints) supports:

- Viewing projects and ongoing operations.
- Viewing agents, current phase, progress, and blockers.
- Inspecting recent activity and evidence.
- Viewing CI/delivery status.
- Receiving and responding to legitimate Owner decisions (exact
  protected-path amendments with reason).
- Reading why an operation stopped or failed.

## Revoke

Restart `aeh home` / `aeh control-center` without `--remote-mode` (and unset
the `AEH_CONTROL_CENTER_REMOTE_*` environment), then `tailscale serve reset`
or `tailscale serve --bg off`. The external entry point is revoked;
loopback remains.
