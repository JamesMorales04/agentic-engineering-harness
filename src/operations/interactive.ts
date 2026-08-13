import {
  isManagedInteractiveLead,
  isSideEffectFreeMetaInvocation
} from "./executionContext.js";

export interface InteractiveOperationPromotion {
  kind: "audit" | "run";
  operationArgv: string[];
}

export function promoteInteractiveOperation(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env
): InteractiveOperationPromotion | undefined {
  if (
    !env.PASEO_AGENT_ID?.trim() ||
    !isManagedInteractiveLead(env) ||
    env.AEH_ALLOW_SYNC_INTERACTIVE === "1" ||
    isSideEffectFreeMetaInvocation(argv)
  ) {
    return undefined;
  }

  if (argv[0] === "audit") {
    return { kind: "audit", operationArgv: ["audit", ...argv.slice(1)] };
  }

  if (argv[0] === "run") {
    return { kind: "run", operationArgv: translateRun(argv.slice(1)) };
  }

  return undefined;
}

function translateRun(argv: string[]): string[] {
  const positional: string[] = [];
  let profile: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--profile") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error("Interactive aeh run --profile requires a value.");
      profile = value;
      continue;
    }
    if (token.startsWith("--")) {
      throw new Error(
        `Managed Paseo leads cannot execute synchronous 'aeh run' option ${token}. ` +
        "Prepare/import the task first, then use 'aeh operation start run <taskId>'. " +
        "Set AEH_ALLOW_SYNC_INTERACTIVE=1 only for an explicit compatibility or recovery flow."
      );
    }
    positional.push(token);
  }

  const taskId = positional[0];
  if (!taskId) {
    throw new Error(
      "Managed Paseo leads cannot execute a synchronous bare 'aeh run'. " +
      "Use a prepared/sealed task id so AEH can start a detached operation."
    );
  }
  if (positional.length > 2) throw new Error("Interactive aeh run accepts <taskId> and at most one project directory.");

  const operationArgv = ["run", taskId];
  if (positional[1]) operationArgv.push(positional[1]);
  if (profile) operationArgv.push("--profile", profile);
  return operationArgv;
}
