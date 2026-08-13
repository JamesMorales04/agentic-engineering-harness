export interface ManagedAgentExecutionIdentity {
  logicalAgent: string;
  role?: string;
  operationId?: string;
  operationKind?: string;
  phase?: string;
  interactiveLead?: boolean;
  orchestrationAllowed?: boolean;
}

const REENTRY_TOP_LEVEL = new Set([
  "start",
  "audit",
  "run",
  "quick",
  "issue",
  "spec",
  "sdd",
  "seal",
  "verify",
  "intervention",
  "init"
]);
const REENTRY_OPERATION_SUBCOMMANDS = new Set([
  "start",
  "execute",
  "wait",
  "cancel",
  "mcp"
]);
const META_FLAGS = new Set(["--help", "-h", "--version", "-V"]);

export function buildManagedAgentEnvironment(
  identity: ManagedAgentExecutionIdentity
): Record<string, string> {
  const env: Record<string, string> = {
    AEH_MANAGED_AGENT: "1",
    AEH_LOGICAL_AGENT: identity.logicalAgent,
    AEH_AGENT_ROLE: identity.role ?? "worker",
    AEH_INTERACTIVE_LEAD: identity.interactiveLead ? "1" : "0",
    AEH_ORCHESTRATION_ALLOWED: identity.orchestrationAllowed ? "1" : "0"
  };
  if (identity.operationId) env.AEH_PARENT_OPERATION_ID = identity.operationId;
  if (identity.operationKind) env.AEH_PARENT_OPERATION_KIND = identity.operationKind;
  if (identity.phase) env.AEH_AGENT_PHASE = identity.phase;
  return env;
}

export function isManagedInteractiveLead(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return (
    env.AEH_MANAGED_AGENT === "1" &&
    env.AEH_INTERACTIVE_LEAD === "1" &&
    env.AEH_ORCHESTRATION_ALLOWED === "1"
  );
}

export function isManagedBoundedAgent(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return env.AEH_MANAGED_AGENT === "1" && !isManagedInteractiveLead(env);
}

export function isSideEffectFreeMetaInvocation(argv: string[]): boolean {
  return argv.some((token) => META_FLAGS.has(token));
}

export function assertHarnessWorkflowEntryAllowed(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env
): void {
  if (!isManagedBoundedAgent(env)) return;
  if (env.AEH_ALLOW_NESTED_OPERATION === "1") return;
  if (isSideEffectFreeMetaInvocation(argv)) return;
  if (!isRecursiveWorkflowEntry(argv)) return;

  const logicalAgent = env.AEH_LOGICAL_AGENT?.trim() || "bounded-agent";
  const role = env.AEH_AGENT_ROLE?.trim() || "worker";
  const operationId = env.AEH_PARENT_OPERATION_ID?.trim();
  const operation = operationId ? ` inside ${operationId}` : " inside an AEH workflow";
  throw new Error(
    `AEH_RECURSIVE_OPERATION_DENIED: ${logicalAgent} (${role}) is already executing${operation}. ` +
      `Harness-spawned bounded agents may not re-enter AEH through '${displayCommand(argv)}'. ` +
      "Complete the assigned bounded role directly. Set AEH_ALLOW_NESTED_OPERATION=1 only for an explicit controller-recovery assignment."
  );
}

export function managedBoundedAgentPromptContext(
  identity: ManagedAgentExecutionIdentity
): string {
  const lines = [
    "AEH bounded execution context (deterministic):",
    `- Logical agent: ${identity.logicalAgent}`,
    `- Role: ${identity.role ?? "worker"}`,
    identity.operationId ? `- Parent operation: ${identity.operationId}` : undefined,
    identity.operationKind ? `- Operation kind: ${identity.operationKind}` : undefined,
    identity.phase ? `- Phase: ${identity.phase}` : undefined,
    "- The top-level user request has already entered AEH. You are executing inside that existing Harness workflow.",
    "- Do not invoke or re-enter `aeh start`, `aeh audit`, `aeh run`, `aeh operation start/execute/wait/cancel`, QUICK/SPEC authoring, or another Harness workflow from this assignment.",
    "- Use only the repository/runtime tools needed for your bounded role and return the requested output contract. Do not recover or orchestrate the parent operation unless this assignment explicitly delegates controller recovery."
  ].filter((line): line is string => Boolean(line));
  return lines.join("\n");
}

function isRecursiveWorkflowEntry(argv: string[]): boolean {
  const command = argv[0];
  if (!command) return false;
  if (REENTRY_TOP_LEVEL.has(command)) return true;
  return command === "operation" && REENTRY_OPERATION_SUBCOMMANDS.has(argv[1] ?? "");
}

function displayCommand(argv: string[]): string {
  return ["aeh", ...argv.slice(0, 3)].join(" ");
}
