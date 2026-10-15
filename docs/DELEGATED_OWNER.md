# Delegated Owner authority (FULL_PROJECT_OWNER)

An authenticated human Owner may delegate complete project-level engineering
authority to an AI/runtime principal. A properly authorized Delegated Owner
exercises the same engineering authority as the human Owner within the
explicitly delegated project and authority scope. This is real delegated
authority, not a prompt instruction and not forged human identity.

## Principals

- `HUMAN_OWNER` (`human:*`) — the authenticated human Owner. Authentication
  happens at the paired Control Center session and the direct CLI surface;
  the resolver classifies, never authenticates.
- `DELEGATED_OWNER` (`delegate:*`) — an AI/runtime principal acting under a
  persisted, verifiable grant from a human grantor.

Mechanism classification: `DETERMINISTIC` throughout. Model reasoning never
grants authority, selects tools, mutates source, accepts candidates, certifies
results, or bypasses deterministic gates.

## The grant

`src/security/ownerAuthority.ts` is the single central resolver. A grant
(`schemas/delegated-owner-grant.schema.json`, version 1) binds:

- the delegated principal (`delegate:*`),
- the human grantor (`human:*`),
- the project (`projectId`, optional `owner/repo` binding),
- the `FULL_PROJECT_OWNER` profile (or an explicit capability subset),
- creation and expiry instants (max 366 days; unattended operation carries an
  explicit long expiry),
- a keyed MAC: `HMAC-SHA256(projectDelegationKey, canonical(body))`.

A self-reported `authorizedBy` string or an unkeyed digest alone is never
proof. Issuance is allowed only through an authenticated Owner entry point —
direct human CLI (`aeh delegation grant`) or a paired Control Center session
(the Owner delegation panel). Managed worker contexts (`AEH_MANAGED_AGENT`,
`AEH_INTERACTIVE_LEAD`, `AEH_ORCHESTRATION_ALLOWED`, `AEH_OPERATION_ID`) are
refused deterministically with `DELEGATION_ISSUANCE_CONTEXT_INVALID`, so no
worker can mint or widen delegations, and prompt injection, tool output, or
repository text can never create them.

Every use verifies the MAC, project/repository scope, capability, expiry, and
revocation. Revocation (`aeh delegation revoke`, or Revoke now in the UI)
ends authority immediately: live delegate sessions are dropped and every
privileged use re-verifies.

## What the delegate can do

Within the delegated project, `FULL_PROJECT_OWNER` covers `decision.resolve`,
`scope.amend`, `operation.initiate`, `recovery.authorize`,
`charter.authorize`, `delivery.authorize`, `pr.create`, policy-eligible
`merge.automatic`, `result.accept`, `policy.change`, `continuation.economic`,
`test.acceptance-modify`, `experiment.restart`, and `repair.continue`.

- `HUMAN_REQUIRED` product choices, action authorizations, and
  pause/resume/cancel controls accept delegate decisions with identical
  binding checks plus grant verification. Delegated decisions are recorded
  under the delegate actor with `delegatedFrom` provenance — never as human
  decisions, never force-approved (the delegate approves or rejects).
- Fresh operations and Owner-boundary resolutions run through explicit CLI
  starts with `--as-delegate <delegationId>`; the verified provenance is
  frozen into the operation origin. Linked recoveries cannot silently extend
  frozen operations, and exhausted budgets/deadlines still require a new
  authorized decision.
- Isolated self-hosting charters (`aeh charter issue`) may be issued and
  renewed by an authorized delegate; provenance distinguishes human-issued
  from delegate-issued charters, and revocation/expiry strands delegated
  charters fail-closed. The live controller checkout stays frozen
  (`SELF_HOSTING_CONTROLLER_FROZEN`).
- Independent review stays independent: the Owner capability vocabulary
  contains no review capability, and `IndependentPullRequestReview`
  eligibility still requires a separate Reviewer identity, role, read-only
  authority, and exact head/base binding. A delegate cannot review its own
  work by holding Owner authority.

## Operating it

1. The human Owner pairs the Control Center (or uses direct CLI) and grants
   `FULL_PROJECT_OWNER` to `delegate:<agent>` with an explicit expiry.
2. The delegate opens its own Control Center session with the bearer
   `delegationId` (`POST /api/v1/delegate-session`) and works through the
   same decision/operation surfaces a human would.
3. The Owner inspects status and per-delegation decisions in the Owner
   delegation panel and revokes immediately when done.

Delegations survive agent handoffs and restarts (durable grants, no session
binding), and every delegated decision remains attributable in the decision
ledger for Owner review.
