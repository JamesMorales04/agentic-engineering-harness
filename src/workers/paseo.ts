import type { HarnessProjectConfig, RepairPacket, TaskContract, WorkerSession } from "../core/types.js";
import { commandExists, runProcess } from "../utils/process.js";
import { buildRepairPrompt, buildWorkerPrompt } from "./prompt.js";
import type { WorkerExecutor } from "./types.js";

export class PaseoWorkerExecutor implements WorkerExecutor {
  readonly name = "paseo";

  async doctor(root: string): Promise<{ ok: boolean; message: string }> {
    const ok = await commandExists("paseo", root);
    return { ok, message: ok ? "Paseo CLI detected." : "Paseo CLI not found." };
  }

  async start(root: string, config: HarnessProjectConfig, contract: TaskContract): Promise<WorkerSession> {
    const worker = config.orchestration?.worker;
    const provider = worker?.provider ?? "opencode";
    const model = worker?.model;
    const title = `${worker?.titlePrefix ?? "aeh"}-${contract.task.id}-worker`;
    const parts = ["paseo run --background --quiet", `--title ${quote(title)}`, `--provider ${quote(provider)}`];
    if (model) parts.push(`--model ${quote(model)}`);
    parts.push(quote(buildWorkerPrompt(contract)));
    const launch = await runProcess(parts.join(" "), { cwd: root, timeoutMs: 60_000 });
    if (launch.exitCode !== 0) throw new Error(`Paseo failed to launch worker: ${launch.stderr || launch.stdout}`);
    const id = launch.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1);
    if (!id) throw new Error("Paseo returned no agent id for the background worker.");
    return this.waitAndCollect(root, config, { id, provider, model, exitCode: 0, stdout: launch.stdout, stderr: "" });
  }

  async repair(root: string, config: HarnessProjectConfig, _contract: TaskContract, session: WorkerSession, packet: RepairPacket): Promise<WorkerSession> {
    if (!session.id) throw new Error("Cannot repair without a Paseo agent id.");
    const send = await runProcess(`paseo send ${quote(session.id)} --no-wait ${quote(buildRepairPrompt(packet))}`, { cwd: root, timeoutMs: 60_000 });
    if (send.exitCode !== 0) throw new Error(`Paseo failed to send repair prompt: ${send.stderr || send.stdout}`);
    return this.waitAndCollect(root, config, session);
  }

  private async waitAndCollect(root: string, config: HarnessProjectConfig, session: WorkerSession): Promise<WorkerSession> {
    const timeout = config.orchestration?.worker?.timeoutSeconds ?? 1800;
    const wait = await runProcess(`paseo wait ${quote(session.id!)} --timeout ${timeout}`, { cwd: root, timeoutMs: (timeout + 30) * 1000 });
    if (wait.exitCode !== 0) throw new Error(`Paseo worker did not complete successfully: ${wait.stderr || wait.stdout}`);
    const logs = await runProcess(`paseo logs ${quote(session.id!)} --tail 30`, { cwd: root, timeoutMs: 60_000 });
    return { ...session, exitCode: 0, stdout: logs.stdout || wait.stdout || session.stdout, stderr: [session.stderr, wait.stderr, logs.stderr].filter(Boolean).join("\n") };
  }
}

function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
