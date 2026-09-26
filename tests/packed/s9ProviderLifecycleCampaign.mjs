import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageRoot = process.env.AEH_S9_PACKED_PACKAGE_ROOT ?? process.argv[2];
if (!packageRoot) throw new Error('Usage: node tests/packed/s9ProviderLifecycleCampaign.mjs <extracted-packed-package-root>');
const pkg = path.resolve(packageRoot);
const dist = path.join(pkg, 'dist');
const releaseId = (await fs.readFile(path.join(dist, 'current'), 'utf8')).trim();
const release = path.join(dist, 'releases', releaseId);
const state = await import(pathToFileURL(path.join(release, 'operations/state.js')));
const executionIdentity = await import(pathToFileURL(path.join(release, 'architecture/executionIdentity.js')));
const runtime = await import(pathToFileURL(path.join(release, 'runtime/index.js')));
const decisions = await import(pathToFileURL(path.join(release, 'security/humanDecision.js')));
const controller = await import(pathToFileURL(path.join(release, 'operations/controller.js')));

const fixedId = 'RUN-S9-PACKED-CAMPAIGN';
const sessions = { takeover: 'packed-takeover-session', cancel: 'packed-restart-cancel-session' };
const childMode = process.argv[2];
if (childMode === '--owner') {
  const root = path.resolve(process.argv[3]);
  const operationId = process.argv[4];
  const sessionId = process.argv[5];
  const sourceTag = process.argv[6];
  const now = new Date().toISOString();
  process.env.AEH_OPERATION_ID = operationId;
  process.env.AEH_OPERATION_KIND = 'audit';
  process.env.AEH_CONTROL_ROOT = root;
  process.env.AEH_OPERATION_STATE_REDIRECT = '0';
  await state.saveOperation(root, {
    version: 2, id: operationId, kind: 'audit', status: 'RUNNING', phase: 'reviewing', root,
    payload: { request: `packed S9 ${sourceTag}` }, revision: 1, operationExecutionRevision: 1,
    createdAt: now, updatedAt: now, lastProgressAt: now,
    supervision: { required: false, materialized: false, generations: [] }, stages: {}, participants: {},
    progress: { expected: 0, registered: 0, running: 0, completed: 0, failed: 0, blocked: 0 },
    notification: { lastLeadWakeRevision: 0, terminalDelivered: false, attempts: 0 }
  });
  await state.claimControllerEpoch(root, operationId, `packed-controller:${process.pid}`, { pid: process.pid });
  await state.bindOperationLead(root, operationId, 'packed-lead-session', 'packed-restart-campaign');
  let current = await state.loadOperation(root, operationId);
  const policy = executionIdentity.compileResolvedOperationPolicy({
    projectId: current.candidateRevision.projectId, operationId,
    operationExecutionRevision: current.operationExecutionRevision,
    candidateRevision: current.candidateRevision.revision,
    candidateDigest: current.candidateRevision.identityDigest,
    controllerEpoch: state.currentControllerEpoch(current),
    intent: `packed S9 ${sourceTag}`, route: 'DIRECT', minimumAssurance: 'STANDARD',
    policyVersions: { resolvedOperationPolicy: '1' }, policyDigests: {}, validationPolicy: {}, reviewPolicy: {},
    deliveryPolicy: {}, knowledgePolicy: {}, contextPolicy: {}, allowedExternalEffects: [], humanDecisionRequirements: []
  });
  await state.bindResolvedOperationPolicy(root, operationId, policy);
  const hold = setInterval(() => {}, 1000);
  await runtime.runWithOperationProviderLease({
    root, provider: 'opencode', workspaceId: root, operationId,
    leadAgentId: 'packed-lead-session', leadGeneration: 1, sessionId,
    renewEveryMs: 1000,
    inspect: async () => ({ status: 'active' }), stop: async () => {}
  }, async () => new Promise(() => {}));
  clearInterval(hold);
  process.exit(91);
}

function assert(condition, message) { if (!condition) throw new Error(`PACKED_ASSERTION_FAILED: ${message}`); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function waitForLease(root, sessionId, child) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const snapshot = await runtime.readManagedRuntimeSnapshot(root).catch(() => undefined);
    const lease = snapshot?.providerLeases.find((item) => item.lifecycle?.sessionId === sessionId);
    if (lease) return lease;
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`lease owner exited before durable acquire: ${child.exitCode}/${child.signalCode}`);
    await sleep(50);
  }
  throw new Error(`timeout waiting for durable lease ${sessionId}`);
}
async function createOwner(root, operationId, sessionId, tag) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--owner', root, operationId, sessionId, tag], {
    stdio: 'ignore',
    env: { ...process.env, AEH_S9_PACKED_PACKAGE_ROOT: pkg }
  });
  const lease = await waitForLease(root, sessionId, child);
  assert(lease.lifecycle.operationId === operationId, 'packed provider lease bound to operation');
  assert(lease.lifecycle.leadAgentId === 'packed-lead-session' && lease.lifecycle.leadGeneration === 1, 'packed lease bound to current Lead generation');
  assert(lease.lifecycle.controllerEpoch === 1, 'initial packed lease uses epoch 1');
  child.kill('SIGKILL');
  await new Promise((resolve) => child.once('exit', resolve));
  assert(child.signalCode === 'SIGKILL', 'provider owner process was terminated to model a controller restart');
  return lease;
}
async function bindPolicyAtCurrentEpoch(root, operationId) {
  const current = await state.loadOperation(root, operationId);
  const policy = executionIdentity.compileResolvedOperationPolicy({
    projectId: current.candidateRevision.projectId, operationId,
    operationExecutionRevision: current.operationExecutionRevision,
    candidateRevision: current.candidateRevision.revision,
    candidateDigest: current.candidateRevision.identityDigest,
    controllerEpoch: state.currentControllerEpoch(current),
    intent: `packed S9 ${operationId}`, route: 'DIRECT', minimumAssurance: 'STANDARD',
    policyVersions: { resolvedOperationPolicy: '1' }, policyDigests: {}, validationPolicy: {}, reviewPolicy: {},
    deliveryPolicy: {}, knowledgePolicy: {}, contextPolicy: {}, allowedExternalEffects: [], humanDecisionRequirements: []
  });
  await state.bindResolvedOperationPolicy(root, operationId, policy);
}

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'aeh-s9-packed-'));
try {
  const takeoverRoot = path.join(temp, 'takeover-project');
  const cancelRoot = path.join(temp, 'cancel-project');
  await fs.mkdir(takeoverRoot); await fs.mkdir(cancelRoot);

  const takeoverLease = await createOwner(takeoverRoot, `${fixedId}-TAKEOVER`, sessions.takeover, 'takeover');
  const crashed = await state.loadOperation(takeoverRoot, `${fixedId}-TAKEOVER`);
  assert(crashed.status === 'RUNNING' && state.currentControllerEpoch(crashed) === 1, 'durable operation survives owner process exit');
  const nextOwner = await state.claimControllerEpoch(takeoverRoot, crashed.id, `packed-controller:restart:${process.pid}`, { pid: process.pid });
  assert(state.currentControllerEpoch(nextOwner) === 2, 'restart claims a strictly newer controller epoch');
  await bindPolicyAtCurrentEpoch(takeoverRoot, crashed.id);
  process.env.AEH_OPERATION_ID = crashed.id;
  process.env.AEH_OPERATION_KIND = 'audit';
  process.env.AEH_CONTROL_ROOT = takeoverRoot;
  process.env.AEH_OPERATION_STATE_REDIRECT = '0';
  let providerStatus = 'working';
  const inspections = []; const stops = [];
  const resumed = await runtime.runWithOperationProviderLease({
    root: takeoverRoot, provider: 'opencode', workspaceId: takeoverRoot, operationId: crashed.id,
    leadAgentId: 'packed-lead-session', leadGeneration: 1,
    renewEveryMs: 60_000,
    inspect: async (sessionId) => { inspections.push(sessionId); return { status: providerStatus }; },
    stop: async (sessionId) => { stops.push(sessionId); providerStatus = 'idle'; }
  }, async () => ({ value: 'resumed-after-observed-takeover', sessionId: sessions.takeover }));
  assert(resumed === 'resumed-after-observed-takeover', 'packed provider call resumes after takeover');
  assert(stops.length === 1 && stops[0] === sessions.takeover, 'takeover stopped the exact old session');
  assert(inspections.length === 3 && inspections.every((id) => id === sessions.takeover), 'takeover and settled call inspect exact prior session');
  assert((await runtime.readManagedRuntimeSnapshot(takeoverRoot)).providerLeases.length === 0, 'settled takeover leaves no provider lease');
  console.log('PACKED_TAKEOVER_PASS: child controller SIGKILL; epoch 1 -> 2; exact prior session inspected active, stopped, observed idle; resumed turn released lease.');

  const cancellationLease = await createOwner(cancelRoot, `${fixedId}-CANCEL`, sessions.cancel, 'cancel');
  let current = await state.loadOperation(cancelRoot, `${fixedId}-CANCEL`);
  const decisionLedger = new decisions.HumanDecisionLedgerV2(path.join(cancelRoot, '.harness', 'security', 'human-decisions.json'));
  const authorizeCancel = async (operation) => decisionLedger.record({
    operationId: operation.id, candidate: operation.candidateRevision,
    operationExecutionRevision: operation.operationExecutionRevision,
    policyDigest: operation.resolvedOperationPolicy.digest,
    controllerEpoch: state.currentControllerEpoch(operation),
    purpose: { kind: 'OPERATION_CONTROL', command: 'CANCEL' }, kind: 'CANCEL', actorId: 'human:s9-packed',
    reason: 'packed S9 restart cleanup campaign', createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000)
  });
  await authorizeCancel(current);
  process.env.AEH_OPERATION_ID = current.id;
  process.env.AEH_OPERATION_KIND = 'audit';
  process.env.AEH_CONTROL_ROOT = cancelRoot;
  process.env.AEH_OPERATION_STATE_REDIRECT = '0';
  let status = 'working'; const stopCommands = []; const cleanupInspections = [];
  const cancelDeps = {
    humanActorId: 'human:s9-packed',
    run: async (command) => {
      stopCommands.push(command);
      if (command === `paseo stop '${sessions.cancel}'` && stopCommands.filter((value) => value === command).length > 1) status = 'idle';
      const exitCode = command === `paseo stop '${sessions.cancel}'` && stopCommands.filter((value) => value === command).length === 1 ? 1 : 0;
      return { exitCode, stdout: exitCode === 0 ? 'stopped' : '', stderr: exitCode === 0 ? '' : 'injected provider stop fault', durationMs: 1 };
    },
    trace: async () => undefined,
    notifyCompletion: async () => undefined,
    inspectProviderSession: async (_root, provider, sessionId) => {
      cleanupInspections.push(`${provider}:${sessionId}`);
      return provider === 'opencode' && sessionId === sessions.cancel ? { status } : undefined;
    }
  };
  let firstCancelError;
  try { await controller.cancelOperation(cancelRoot, current.id, cancelDeps); }
  catch (error) { firstCancelError = error; }
  current = await state.loadOperation(cancelRoot, current.id);
  assert(firstCancelError?.message.includes('AEH_CANCELLATION_FENCING_REQUIRED'), 'packed provider stop fault blocks terminal cancellation');
  assert(current.status === 'RUNNING' && current.phase === 'cancellation-fencing-required', 'uncertain packed cancellation remains non-terminal');
  assert((await runtime.readManagedRuntimeSnapshot(cancelRoot)).providerLeases.some((item) => item.leaseId === cancellationLease.leaseId), 'packed stop fault retains the old provider lease');
  console.log('PACKED_PROVIDER_FAULT_PASS: injected stop failure leaves operation RUNNING and the provider lease fenced.');

  await authorizeCancel(current);
  const cancelled = await controller.cancelOperation(cancelRoot, current.id, cancelDeps);
  assert(cancelled.status === 'CANCELLED', 'packed cancellation becomes terminal after stop and observed quiescence');
  assert(stopCommands.includes(`paseo stop '${sessions.cancel}'`), 'packed cancellation stops exact durable provider session');
  assert(cleanupInspections.length === 4 && cleanupInspections.every((value) => value === `opencode:${sessions.cancel}`), `packed failed and successful cancellation attempts inspected the exact provider session around stop (observed ${JSON.stringify(cleanupInspections)})`);
  assert(!(await runtime.readManagedRuntimeSnapshot(cancelRoot)).providerLeases.some((item) => item.leaseId === cancellationLease.leaseId), 'packed cancellation releases old epoch lease after restart cleanup');
  console.log('PACKED_RESTART_CLEANUP_PASS: child controller SIGKILL; refreshed scoped cancellation consumed; exact session stopped and observed idle; old lease released before CANCELLED.');
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
