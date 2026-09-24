import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { canonicalSerialize, sha256Canonical } from "../core/digest.js";
import { candidateRevisionsEqual, assertCandidateRevisionV1, type CandidateRevisionV1 } from "../operations/v2Contracts.js";
import { TOOL_ACTION_KINDS_V1, type ToolActionKindV1 } from "./actionKinds.js";

export const humanDecisionKindValues = ["APPROVE", "REJECT", "CHOOSE", "CANCEL", "RETRY", "ACKNOWLEDGE"] as const;
export type HumanDecisionKindV2 = (typeof humanDecisionKindValues)[number];

export type HumanDecisionPurposeV2 =
  | { kind: "PRODUCT_CHOICE"; requestId: string; choiceId: string }
  | { kind: "ACTION_AUTHORIZATION"; action: ToolActionKindV1; effectDigest: string }
  | { kind: "OPERATION_CONTROL"; command: "CANCEL" | "RETRY" | "ACKNOWLEDGE" };

export interface HumanDecisionV2 {
  version: 2;
  decisionId: string;
  operationId: string;
  candidate: CandidateRevisionV1;
  operationExecutionRevision: number;
  policyDigest: string;
  controllerEpoch: number;
  purpose: HumanDecisionPurposeV2;
  kind: HumanDecisionKindV2;
  actorId: string;
  reason: string;
  createdAt: string;
  expiresAt?: string;
}

export interface HumanDecisionInputV2 extends Omit<HumanDecisionV2, "version" | "decisionId" | "createdAt" | "expiresAt"> {
  createdAt?: string | Date;
  expiresAt?: string | Date;
}

export interface HumanDecisionBindingV2 {
  operationId: string;
  candidate: CandidateRevisionV1;
  operationExecutionRevision: number;
  policyDigest: string;
  controllerEpoch: number;
}

export interface DecisionEvidenceReferenceV1 {
  artifact: string;
  sha256: string;
  description: string;
}

export interface DecisionChoiceV1 {
  choiceId: string;
  label: string;
  description: string;
  consequences: string[];
}

export interface DecisionRequestV1 extends HumanDecisionBindingV2 {
  version: 1;
  requestId: string;
  issue: string;
  authoritativeEvidence: DecisionEvidenceReferenceV1[];
  whatTried: string[];
  whyUnresolvable: string;
  choices: DecisionChoiceV1[];
  workThatCanContinue: string[];
  resumeTarget: "SPEC_AUTHORING";
  createdAt: string;
  expiresAt: string;
}

export const continuationRevalidationValuesV1 = [
  "candidate-current",
  "operation-revision-current",
  "policy-current",
  "controller-epoch-current",
  "checkpoint-current"
] as const;
export type ContinuationRevalidationV1 = (typeof continuationRevalidationValuesV1)[number];

export interface ContinuationRecordV1 extends HumanDecisionBindingV2 {
  version: 1;
  continuationId: string;
  resumeTarget: "SPEC_AUTHORING";
  reason: "PRODUCT_CHOICE";
  requestId: string;
  checkpointArtifact: string;
  checkpointDigest: string;
  requiredRevalidation: ContinuationRevalidationV1[];
  state: "WAITING" | "CHOICE_CONSUMED" | "RESUMING";
  suspendedAt: string;
  updatedAt: string;
  selectedDecisionId?: string;
  selectedChoiceId?: string;
  selectedDecisionBinding?: HumanDecisionBindingV2;
  appliedRequirementDigest?: string;
}

export class HumanDecisionError extends Error {
  constructor(message: string) { super(message); this.name = "HumanDecisionError"; }
}

export function assertDecisionRequestV1(value: unknown): DecisionRequestV1 {
  const request = assertExactObject<DecisionRequestV1>(value, [
    "version", "requestId", "operationId", "candidate", "operationExecutionRevision", "policyDigest", "controllerEpoch",
    "issue", "authoritativeEvidence", "whatTried", "whyUnresolvable", "choices", "workThatCanContinue", "resumeTarget", "createdAt", "expiresAt"
  ], "DecisionRequestV1");
  if (request.version !== 1) throw new HumanDecisionError("UNSUPPORTED_DECISION_REQUEST_VERSION: expected version 1.");
  assertBinding(request);
  required(request.requestId, "requestId");
  boundedText(request.issue, "issue", 4_000);
  boundedText(request.whyUnresolvable, "whyUnresolvable", 4_000);
  if (request.resumeTarget !== "SPEC_AUTHORING") throw new HumanDecisionError("unsupported DecisionRequest resumeTarget.");
  if (!Array.isArray(request.authoritativeEvidence) || request.authoritativeEvidence.length < 1 || request.authoritativeEvidence.length > 32) throw new HumanDecisionError("DecisionRequest authoritativeEvidence must contain 1 to 32 references.");
  const evidencePaths = new Set<string>();
  for (const item of request.authoritativeEvidence) {
    const evidence = assertExactObject<DecisionEvidenceReferenceV1>(item, ["artifact", "sha256", "description"], "DecisionEvidenceReferenceV1");
    const artifact = required(evidence.artifact, "authoritativeEvidence.artifact");
    if (!artifact.startsWith(".harness/") || artifact.includes("\\") || artifact.split("/").some((part) => part === ".." || part === "." || !part)) throw new HumanDecisionError("authoritative evidence must be an in-root .harness artifact reference.");
    if (!/^[a-f0-9]{64}$/.test(evidence.sha256)) throw new HumanDecisionError("authoritative evidence sha256 must be a lowercase SHA-256 digest.");
    boundedText(evidence.description, "authoritativeEvidence.description", 500);
    if (evidencePaths.has(artifact)) throw new HumanDecisionError("DecisionRequest authoritative evidence references must be unique.");
    evidencePaths.add(artifact);
  }
  assertTextList(request.whatTried, "whatTried", 1, 16, 1_000);
  assertTextList(request.workThatCanContinue, "workThatCanContinue", 0, 32, 1_000);
  if (!Array.isArray(request.choices) || request.choices.length < 1 || request.choices.length > 12) throw new HumanDecisionError("DecisionRequest choices must contain 1 to 12 bounded options.");
  const choiceIds = new Set<string>();
  for (const item of request.choices) {
    const choice = assertExactObject<DecisionChoiceV1>(item, ["choiceId", "label", "description", "consequences"], "DecisionChoiceV1");
    const choiceId = required(choice.choiceId, "choices.choiceId");
    boundedText(choice.label, "choices.label", 200);
    boundedText(choice.description, "choices.description", 2_000);
    assertTextList(choice.consequences, "choices.consequences", 1, 8, 1_000);
    if (choiceIds.has(choiceId)) throw new HumanDecisionError("DecisionRequest choice IDs must be unique.");
    choiceIds.add(choiceId);
  }
  const createdAt = instant(request.createdAt, "createdAt");
  const expiresAt = instant(request.expiresAt, "expiresAt");
  if (new Date(expiresAt).getTime() <= new Date(createdAt).getTime()) throw new HumanDecisionError("DecisionRequest expiry must be after creation.");
  return request;
}

export function assertContinuationRecordV1(value: unknown): ContinuationRecordV1 {
  const continuation = assertExactObject<ContinuationRecordV1>(value, [
    "version", "continuationId", "operationId", "candidate", "operationExecutionRevision", "policyDigest", "controllerEpoch",
    "resumeTarget", "reason", "requestId", "checkpointArtifact", "checkpointDigest", "requiredRevalidation", "state",
    "suspendedAt", "updatedAt", "selectedDecisionId", "selectedChoiceId", "selectedDecisionBinding", "appliedRequirementDigest"
  ], "ContinuationRecordV1");
  if (continuation.version !== 1) throw new HumanDecisionError("UNSUPPORTED_CONTINUATION_VERSION: expected version 1.");
  assertBinding(continuation);
  required(continuation.continuationId, "continuationId");
  required(continuation.requestId, "requestId");
  if (continuation.resumeTarget !== "SPEC_AUTHORING" || continuation.reason !== "PRODUCT_CHOICE") throw new HumanDecisionError("unsupported operation continuation target or reason.");
  const artifact = required(continuation.checkpointArtifact, "checkpointArtifact");
  if (!artifact.startsWith(".harness/operations/") || artifact.includes("\\") || artifact.split("/").some((part) => part === ".." || part === "." || !part)) throw new HumanDecisionError("continuation checkpoint must be an in-root operation artifact.");
  if (!/^[a-f0-9]{64}$/.test(continuation.checkpointDigest)) throw new HumanDecisionError("continuation checkpointDigest must be a lowercase SHA-256 digest.");
  if (!Array.isArray(continuation.requiredRevalidation) || continuation.requiredRevalidation.length !== continuationRevalidationValuesV1.length
    || new Set(continuation.requiredRevalidation).size !== continuationRevalidationValuesV1.length
    || continuationRevalidationValuesV1.some((item) => !continuation.requiredRevalidation.includes(item))) {
    throw new HumanDecisionError("continuation requiredRevalidation must contain every S3 identity and checkpoint check exactly once.");
  }
  if (!(continuation.state === "WAITING" || continuation.state === "CHOICE_CONSUMED" || continuation.state === "RESUMING")) throw new HumanDecisionError("continuation state is invalid.");
  const hasDecision = typeof continuation.selectedDecisionId === "string" && typeof continuation.selectedChoiceId === "string";
  if ((continuation.state === "WAITING" && (continuation.selectedDecisionId !== undefined || continuation.selectedChoiceId !== undefined || continuation.selectedDecisionBinding !== undefined))
    || (continuation.state !== "WAITING" && (!hasDecision || continuation.selectedDecisionBinding === undefined))) throw new HumanDecisionError("continuation decision state is incomplete or inconsistent.");
  if (hasDecision) {
    required(continuation.selectedDecisionId!, "selectedDecisionId");
    required(continuation.selectedChoiceId!, "selectedChoiceId");
    const selectedBinding = assertExactBinding(continuation.selectedDecisionBinding);
    if (selectedBinding.operationId !== continuation.operationId || !candidateRevisionsEqual(selectedBinding.candidate, continuation.candidate)
      || selectedBinding.controllerEpoch !== continuation.controllerEpoch) throw new HumanDecisionError("continuation selected decision binding does not match the saved operation, candidate, or controller epoch.");
    if (continuation.operationExecutionRevision === selectedBinding.operationExecutionRevision) {
      if (continuation.policyDigest !== selectedBinding.policyDigest) throw new HumanDecisionError("continuation policy binding changed without the authorized product-choice execution revision.");
    } else if (continuation.appliedRequirementDigest === undefined
      || continuation.operationExecutionRevision !== selectedBinding.operationExecutionRevision + 1) {
      throw new HumanDecisionError("continuation execution revision is not the single authorized product-choice revision.");
    }
  }
  if (continuation.appliedRequirementDigest !== undefined && !/^[a-f0-9]{64}$/.test(continuation.appliedRequirementDigest)) throw new HumanDecisionError("continuation appliedRequirementDigest must be a lowercase SHA-256 digest.");
  instant(continuation.suspendedAt, "suspendedAt");
  instant(continuation.updatedAt, "updatedAt");
  return continuation;
}

export function assertDecisionBindingMatchesRequest(request: DecisionRequestV1, binding: HumanDecisionBindingV2): void {
  const validatedRequest = assertDecisionRequestV1(request);
  const validatedBinding = assertBinding(binding);
  if (!sameBinding(validatedRequest, validatedBinding)) throw new HumanDecisionError("DecisionRequest is stale for the current operation, candidate, policy, execution revision, or controller epoch.");
}

function required(value: string, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new HumanDecisionError(`${name} must not be empty.`);
  return value.trim();
}

function boundedText(value: unknown, name: string, maxLength: number): string {
  const text = required(value as string, name);
  if (text.length > maxLength) throw new HumanDecisionError(`${name} exceeds ${maxLength} characters.`);
  return text;
}

function assertTextList(value: unknown, name: string, minLength: number, maxLength: number, itemMaxLength: number): asserts value is string[] {
  if (!Array.isArray(value) || value.length < minLength || value.length > maxLength) throw new HumanDecisionError(`${name} must contain ${minLength} to ${maxLength} items.`);
  for (const item of value) boundedText(item, `${name} item`, itemMaxLength);
}

function assertExactObject<T>(value: unknown, allowedKeys: string[], name: string): T {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HumanDecisionError(`${name} must be an object.`);
  const record = value as Record<string, unknown>;
  const extras = Object.keys(record).filter((key) => !allowedKeys.includes(key));
  const missing = allowedKeys.filter((key) => !(key in record) && !["selectedDecisionId", "selectedChoiceId", "selectedDecisionBinding", "appliedRequirementDigest"].includes(key));
  if (extras.length) throw new HumanDecisionError(`${name} contains unsupported fields: ${extras.join(", ")}.`);
  if (missing.length) throw new HumanDecisionError(`${name} is missing required fields: ${missing.join(", ")}.`);
  return record as T;
}

function externalHumanActor(value: string): string {
  const actorId = required(value, "actorId");
  if (!actorId.startsWith("human:")) throw new HumanDecisionError("only a paired or direct human authority may record this decision.");
  return actorId;
}

function instant(value: string, name: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new HumanDecisionError(`${name} must be a valid instant.`);
  return date.toISOString();
}

function validatePurpose(kind: HumanDecisionKindV2, purpose: HumanDecisionPurposeV2): HumanDecisionPurposeV2 {
  if (!purpose || typeof purpose !== "object") throw new HumanDecisionError("HumanDecision purpose is required.");
  if (purpose.kind === "PRODUCT_CHOICE") {
    if (kind !== "CHOOSE") throw new HumanDecisionError("product choices require a CHOOSE decision.");
    return { kind: purpose.kind, requestId: required(purpose.requestId, "purpose.requestId"), choiceId: required(purpose.choiceId, "purpose.choiceId") };
  }
  if (purpose.kind === "ACTION_AUTHORIZATION") {
    if (kind !== "APPROVE" && kind !== "REJECT") throw new HumanDecisionError("action authorization requires APPROVE or REJECT.");
    if (!TOOL_ACTION_KINDS_V1.includes(purpose.action)) throw new HumanDecisionError(`unsupported action '${String(purpose.action)}'.`);
    if (!/^[a-f0-9]{64}$/.test(purpose.effectDigest)) throw new HumanDecisionError("purpose.effectDigest must be a SHA-256 digest.");
    return { kind: purpose.kind, action: purpose.action, effectDigest: purpose.effectDigest };
  }
  if (purpose.kind === "OPERATION_CONTROL") {
    if (purpose.command !== kind) throw new HumanDecisionError("operation-control purpose must match its decision kind.");
    return { kind: purpose.kind, command: purpose.command };
  }
  throw new HumanDecisionError("unsupported HumanDecision purpose.");
}

function assertBinding(binding: HumanDecisionBindingV2): HumanDecisionBindingV2 {
  if (!binding || typeof binding !== "object") throw new HumanDecisionError("current operation binding is required.");
  assertCandidateRevisionV1(binding.candidate);
  const operationId = required(binding.operationId, "operationId");
  if (binding.candidate.operationId !== operationId) throw new HumanDecisionError("candidate and decision operation must match.");
  if (!Number.isSafeInteger(binding.operationExecutionRevision) || binding.operationExecutionRevision < 1) throw new HumanDecisionError("operationExecutionRevision must be a positive safe integer.");
  if (!/^[a-f0-9]{64}$/.test(binding.policyDigest)) throw new HumanDecisionError("policyDigest must be a SHA-256 digest.");
  if (!Number.isSafeInteger(binding.controllerEpoch) || binding.controllerEpoch < 0) throw new HumanDecisionError("controllerEpoch must be a non-negative safe integer.");
  return binding;
}

function assertExactBinding(value: unknown): HumanDecisionBindingV2 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HumanDecisionError("selected decision binding must be an object.");
  const record = value as Record<string, unknown>;
  const expected = ["operationId", "candidate", "operationExecutionRevision", "policyDigest", "controllerEpoch"];
  if (Object.keys(record).some((key) => !expected.includes(key)) || expected.some((key) => !(key in record))) throw new HumanDecisionError("selected decision binding has an invalid shape.");
  return assertBinding(value as HumanDecisionBindingV2);
}

/**
 * Durable V2 HumanDecision storage. Each decision and its one-time consumption
 * receipt is created exclusively, so concurrent consumers cannot both use it.
 * A pre-V2 file at the configured path fails explicitly and requires migration.
 */
export class HumanDecisionLedgerV2 {
  constructor(private readonly directoryPath: string) {}

  async record(input: HumanDecisionInputV2): Promise<HumanDecisionV2> {
    const decision = this.create(input);
    await this.ensureDirectory();
    await this.writeExclusive(this.decisionFile(decision.decisionId), decision);
    return decision;
  }

  /** Reserve at most one paired product choice for a request and persist its HumanDecision. */
  async recordProductChoice(input: HumanDecisionInputV2, requestId: string): Promise<HumanDecisionV2> {
    const decision = this.create(input);
    if (decision.kind !== "CHOOSE" || decision.purpose.kind !== "PRODUCT_CHOICE" || decision.purpose.requestId !== required(requestId, "requestId")) {
      throw new HumanDecisionError("a product-choice reservation requires a matching CHOOSE HumanDecision and requestId.");
    }
    await this.ensureDirectory();
    const requestDir = path.join(this.directoryPath, "product-choice-requests");
    await fs.mkdir(requestDir, { recursive: true, mode: 0o700 });
    const requestKey = crypto.createHash("sha256").update(requestId).digest("hex");
    const binding: HumanDecisionBindingV2 = { operationId: decision.operationId, candidate: decision.candidate, operationExecutionRevision: decision.operationExecutionRevision, policyDigest: decision.policyDigest, controllerEpoch: decision.controllerEpoch };
    await this.writeExclusive(path.join(requestDir, `${requestKey}.json`), { version: 1, requestId, binding, decision });
    await this.writeExclusive(this.decisionFile(decision.decisionId), decision);
    return decision;
  }

  /** Load and repair a reserved request after a crash between reservation and ledger materialization. */
  async productChoiceForRequest(requestIdInput: string, bindingInput: HumanDecisionBindingV2, allowedChoiceIds: readonly string[]): Promise<HumanDecisionV2 | undefined> {
    const requestId = required(requestIdInput, "requestId");
    const binding = assertBinding(bindingInput);
    const requestKey = crypto.createHash("sha256").update(requestId).digest("hex");
    const file = path.join(this.directoryPath, "product-choice-requests", `${requestKey}.json`);
    let raw: unknown;
    try { raw = JSON.parse(await fs.readFile(file, "utf8")) as unknown; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new HumanDecisionError("reserved product-choice request is malformed.");
    const reservation = raw as { version?: unknown; requestId?: unknown; binding?: unknown; decision?: unknown };
    const decision = assertDecisionV2(reservation.decision);
    if (reservation.version !== 1 || reservation.requestId !== requestId || !reservation.binding || typeof reservation.binding !== "object"
      || !sameBinding(decision, assertBinding(reservation.binding as HumanDecisionBindingV2))
      || !sameBinding(decision, binding) || decision.purpose.kind !== "PRODUCT_CHOICE" || decision.purpose.requestId !== requestId
      || !allowedChoiceIds.includes(decision.purpose.choiceId)) {
      throw new HumanDecisionError("reserved product-choice request does not match the current request, choice, or authority binding.");
    }
    await this.ensureDirectory();
    const decisionPath = this.decisionFile(decision.decisionId);
    try {
      const stored = assertDecisionV2(JSON.parse(await fs.readFile(decisionPath, "utf8")) as unknown);
      if (stored.decisionId !== decision.decisionId || canonicalSerialize(stored) !== canonicalSerialize(decision)) throw new HumanDecisionError("reserved product-choice decision conflicts with its ledger record.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.writeExclusive(decisionPath, decision);
    }
    return decision;
  }

  private create(input: HumanDecisionInputV2): HumanDecisionV2 {
    const binding = assertBinding(input);
    if (!humanDecisionKindValues.includes(input.kind)) throw new HumanDecisionError(`unsupported human decision kind '${String(input.kind)}'.`);
    const actorId = externalHumanActor(input.actorId);
    const purpose = validatePurpose(input.kind, input.purpose);
    const createdAt = instant(input.createdAt instanceof Date ? input.createdAt.toISOString() : input.createdAt ?? new Date().toISOString(), "createdAt");
    const expiresAt = input.expiresAt === undefined ? undefined : instant(input.expiresAt instanceof Date ? input.expiresAt.toISOString() : input.expiresAt, "expiresAt");
    if (expiresAt && new Date(expiresAt).getTime() <= new Date(createdAt).getTime()) throw new HumanDecisionError("expiresAt must be after createdAt.");
    return {
      version: 2,
      decisionId: `decision:${crypto.randomUUID()}`,
      ...binding,
      purpose,
      kind: input.kind,
      actorId,
      reason: required(input.reason, "reason"),
      createdAt,
      ...(expiresAt ? { expiresAt } : {})
    };
  }

  private async writeExclusive(file: string, value: unknown): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${crypto.randomUUID()}.tmp`;
    const handle = await fs.open(temp, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally { await handle.close(); }
    try {
      await fs.link(temp, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new HumanDecisionError("decision request has already been submitted or replayed.");
      throw error;
    } finally { await fs.unlink(temp).catch(() => undefined); }
  }

  async list(): Promise<HumanDecisionV2[]> {
    await this.ensureDirectory();
    const names = (await fs.readdir(this.directoryPath)).filter((name) => name.endsWith(".json") && !name.endsWith(".consumed.json")).sort();
    const decisions: HumanDecisionV2[] = [];
    for (const name of names) {
      const parsed = JSON.parse(await fs.readFile(path.join(this.directoryPath, name), "utf8")) as unknown;
      decisions.push(assertDecisionV2(parsed));
    }
    return decisions;
  }

  async active(bindingInput: HumanDecisionBindingV2, now = new Date()): Promise<HumanDecisionV2[]> {
    const binding = assertBinding(bindingInput);
    const at = now.getTime();
    const decisions: HumanDecisionV2[] = [];
    for (const decision of await this.list()) {
      if (!sameBinding(decision, binding) || (decision.expiresAt && new Date(decision.expiresAt).getTime() <= at)) continue;
      if (!(await this.isConsumed(decision.decisionId))) decisions.push(decision);
    }
    return decisions;
  }

  async find(decisionId: string): Promise<HumanDecisionV2 | undefined> {
    const match = /^decision:([0-9a-f-]{36})$/i.exec(required(decisionId, "decisionId"));
    if (!match) throw new HumanDecisionError("HumanDecision decisionId is invalid.");
    await this.ensureDirectory();
    try {
      const parsed = JSON.parse(await fs.readFile(this.decisionFile(decisionId), "utf8")) as unknown;
      return assertDecisionV2(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async consumeExact(bindingInput: HumanDecisionBindingV2, purposeInput: HumanDecisionPurposeV2, decisionId: string, actorIdInput: string, now = new Date()): Promise<HumanDecisionV2> {
    const binding = assertBinding(bindingInput);
    const purpose = normalizePurpose(purposeInput);
    const actorId = required(actorIdInput, "actorId");
    const decision = await this.find(decisionId);
    if (!decision || !sameBinding(decision, binding) || decision.actorId !== actorId
      || canonicalSerialize(decision.purpose) !== canonicalSerialize(purpose)) {
      throw new HumanDecisionError("no current HumanDecision matches the operation, candidate, policy, epoch, actor, and exact purpose.");
    }
    if (decision.expiresAt && new Date(decision.expiresAt).getTime() <= now.getTime()) throw new HumanDecisionError("matching HumanDecision has expired.");
    const marker = this.consumedFile(decision.decisionId);
    const receipt = { version: 1, decisionId: decision.decisionId, consumedAt: now.toISOString(), consumerDigest: sha256Canonical({ binding, purpose, actorId: decision.actorId }) };
    try {
      await fs.writeFile(marker, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      throw new HumanDecisionError("matching HumanDecision has already been consumed or replayed.");
    }
    return decision;
  }

  /** Recovery-only read: recognizes the same durable consumption after a crash, never grants a second consume. */
  async consumedExact(bindingInput: HumanDecisionBindingV2, purposeInput: HumanDecisionPurposeV2, decisionId: string, actorIdInput: string): Promise<HumanDecisionV2 | undefined> {
    const binding = assertBinding(bindingInput);
    const purpose = normalizePurpose(purposeInput);
    const actorId = required(actorIdInput, "actorId");
    const decision = await this.find(decisionId);
    if (!decision || !sameBinding(decision, binding) || decision.actorId !== actorId
      || canonicalSerialize(decision.purpose) !== canonicalSerialize(purpose)) return undefined;
    let receipt: unknown;
    try { receipt = JSON.parse(await fs.readFile(this.consumedFile(decisionId), "utf8")) as unknown; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    const stored = receipt as { version?: unknown; decisionId?: unknown; consumerDigest?: unknown };
    const expectedDigest = sha256Canonical({ binding, purpose, actorId: decision.actorId });
    if (stored?.version !== 1 || stored.decisionId !== decisionId || stored.consumerDigest !== expectedDigest) return undefined;
    return decision;
  }

  async consume(bindingInput: HumanDecisionBindingV2, purposeInput: HumanDecisionPurposeV2, actorIdInput?: string, now = new Date()): Promise<HumanDecisionV2> {
    const binding = assertBinding(bindingInput);
    const actorId = actorIdInput === undefined ? undefined : required(actorIdInput, "actorId");
    const purpose = normalizePurpose(purposeInput);
    const all = await this.list();
    const exact = all.filter((decision) => sameBinding(decision, binding)
      && (actorId === undefined || decision.actorId === actorId)
      && canonicalSerialize(decision.purpose) === canonicalSerialize(purpose));
    const at = now.getTime();
    const unexpired = exact.filter((decision) => !decision.expiresAt || new Date(decision.expiresAt).getTime() > at);
    const available: HumanDecisionV2[] = [];
    for (const decision of unexpired) if (!(await this.isConsumed(decision.decisionId))) available.push(decision);
    if (available.length > 1) throw new HumanDecisionError("multiple matching HumanDecisions are available; resolve the ambiguity explicitly.");
    if (!available.length) {
      if (exact.some((decision) => decision.expiresAt && new Date(decision.expiresAt).getTime() <= at)) throw new HumanDecisionError("matching HumanDecision has expired.");
      if (exact.length) throw new HumanDecisionError("matching HumanDecision has already been consumed or replayed.");
      throw new HumanDecisionError("no current HumanDecision matches the operation, candidate, policy, epoch, actor, and exact purpose.");
    }
    const decision = available[0]!;
    const marker = this.consumedFile(decision.decisionId);
    const receipt = { version: 1, decisionId: decision.decisionId, consumedAt: now.toISOString(), consumerDigest: sha256Canonical({ binding, purpose, actorId: decision.actorId }) };
    try {
      await fs.writeFile(marker, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      throw new HumanDecisionError("matching HumanDecision has already been consumed or replayed.");
    }
    return decision;
  }

  private async ensureDirectory(): Promise<void> {
    try {
      const stat = await fs.lstat(this.directoryPath);
      if (!stat.isDirectory()) throw new HumanDecisionError("UNSUPPORTED_HUMAN_DECISION_VERSION: legacy ledger file requires explicit migration before V2 decisions can be stored.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await fs.mkdir(this.directoryPath, { recursive: true, mode: 0o700 });
    }
  }

  private decisionFile(decisionId: string): string {
    return path.join(this.directoryPath, `${decisionId.slice("decision:".length)}.json`);
  }

  private consumedFile(decisionId: string): string {
    return path.join(this.directoryPath, `${decisionId.slice("decision:".length)}.consumed.json`);
  }

  private async isConsumed(decisionId: string): Promise<boolean> {
    try { await fs.access(this.consumedFile(decisionId)); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  }
}

export function assertDecisionV2(value: unknown): HumanDecisionV2 {
  if (!value || typeof value !== "object" || (value as { version?: unknown }).version !== 2) throw new HumanDecisionError("UNSUPPORTED_HUMAN_DECISION_VERSION: expected version 2; migrate and re-record this decision.");
  const allowed = ["version", "decisionId", "operationId", "candidate", "operationExecutionRevision", "policyDigest", "controllerEpoch", "purpose", "kind", "actorId", "reason", "createdAt", "expiresAt"];
  const record = value as Record<string, unknown>;
  const extra = Object.keys(record).filter((key) => !allowed.includes(key));
  const requiredKeys = allowed.filter((key) => key !== "expiresAt");
  const missing = requiredKeys.filter((key) => !(key in record));
  if (extra.length || missing.length) throw new HumanDecisionError(`HumanDecision fields are malformed (extra: ${extra.join(", ") || "none"}; missing: ${missing.join(", ") || "none"}).`);
  const decision = value as HumanDecisionV2;
  assertBinding(decision);
  if (!/^decision:[0-9a-f-]{36}$/i.test(decision.decisionId)) throw new HumanDecisionError("HumanDecision decisionId is invalid.");
  if (!humanDecisionKindValues.includes(decision.kind)) throw new HumanDecisionError("HumanDecision kind is invalid.");
  const normalizedPurpose = validatePurpose(decision.kind, decision.purpose);
  if (canonicalSerialize(normalizedPurpose) !== canonicalSerialize(decision.purpose)) throw new HumanDecisionError("HumanDecision purpose is not in canonical typed form.");
  externalHumanActor(decision.actorId);
  required(decision.reason, "reason");
  instant(decision.createdAt, "createdAt");
  if (decision.expiresAt) {
    const expiresAt = instant(decision.expiresAt, "expiresAt");
    if (new Date(expiresAt).getTime() <= new Date(decision.createdAt).getTime()) throw new HumanDecisionError("HumanDecision expiry must be after creation.");
  }
  return decision;
}

function normalizePurpose(purpose: HumanDecisionPurposeV2): HumanDecisionPurposeV2 {
  // Purpose validation is repeated by callers that have a decision kind; here
  // the exact frozen purpose shape is canonicalized without inferring a choice.
  if (!purpose || typeof purpose !== "object") throw new HumanDecisionError("HumanDecision purpose is required.");
  if (purpose.kind === "PRODUCT_CHOICE") return { kind: purpose.kind, requestId: required(purpose.requestId, "purpose.requestId"), choiceId: required(purpose.choiceId, "purpose.choiceId") };
  if (purpose.kind === "ACTION_AUTHORIZATION") {
    if (!TOOL_ACTION_KINDS_V1.includes(purpose.action) || !/^[a-f0-9]{64}$/.test(purpose.effectDigest)) throw new HumanDecisionError("action authorization purpose is invalid.");
    return { kind: purpose.kind, action: purpose.action, effectDigest: purpose.effectDigest };
  }
  if (purpose.kind === "OPERATION_CONTROL" && ["CANCEL", "RETRY", "ACKNOWLEDGE"].includes(purpose.command)) return { kind: purpose.kind, command: purpose.command };
  throw new HumanDecisionError("unsupported HumanDecision purpose.");
}

function sameBinding(decision: HumanDecisionBindingV2, binding: HumanDecisionBindingV2): boolean {
  return decision.operationId === binding.operationId
    && candidateRevisionsEqual(decision.candidate, binding.candidate)
    && decision.operationExecutionRevision === binding.operationExecutionRevision
    && decision.policyDigest === binding.policyDigest
    && decision.controllerEpoch === binding.controllerEpoch;
}
