#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const [command, ...rest] = process.argv.slice(2);
const options = Object.fromEntries(rest.flatMap((item, index) => item.startsWith("--") ? [[item.slice(2), rest[index + 1]]] : []));
const root = path.resolve(options.root ?? process.cwd());
const stateDirectory = path.join(root, ".harness", "integration");
const pidFile = path.join(stateDirectory, "service.pid");
const portFile = path.join(stateDirectory, "service.port");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readPort() {
  try { return Number(fs.readFileSync(portFile, "utf8").trim()); } catch { return undefined; }
}

async function health(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    if (!response.ok) return undefined;
    return await response.json();
  } catch {
    return undefined;
  }
}

if (command === "serve") {
  fs.mkdirSync(stateDirectory, { recursive: true });
  const server = http.createServer((request, response) => {
    if (request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok", pid: process.pid }));
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  server.listen(0, "127.0.0.1", () => {
    fs.writeFileSync(portFile, String(server.address().port));
  });
  const shutdown = () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 500).unref(); };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
} else if (command === "provision") {
  fs.mkdirSync(stateDirectory, { recursive: true });
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "serve", "--root", root], { detached: true, stdio: "ignore" });
  child.unref();
  fs.writeFileSync(pidFile, String(child.pid));
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (readPort()) process.exit(0);
    await sleep(100);
  }
  process.exit(1);
} else if (command === "ready") {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const port = readPort();
    if (port && await health(port)) process.exit(0);
    await sleep(150);
  }
  process.exit(1);
} else if (command === "test") {
  const port = readPort();
  if (!port) { console.error("no service port recorded"); process.exit(1); }
  const body = await health(port);
  const expectedPid = Number(fs.readFileSync(pidFile, "utf8").trim());
  if (!body || body.status !== "ok") { console.error("service health check failed"); process.exit(1); }
  if (body.pid !== expectedPid) { console.error(`service pid ${body.pid} does not match the provisioned pid ${expectedPid}`); process.exit(1); }
  console.log(JSON.stringify({ isolatedService: "ok", pid: body.pid, port }));
} else if (command === "cleanup") {
  let pid;
  try { pid = Number(fs.readFileSync(pidFile, "utf8").trim()); } catch { pid = undefined; }
  if (Number.isSafeInteger(pid) && pid > 1) {
    try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      try { process.kill(pid, 0); } catch { break; }
      await sleep(100);
    }
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
  if (Number.isSafeInteger(pid) && pid > 1) fs.writeFileSync(path.join(stateDirectory, "cleaned.json"), JSON.stringify({ pid, terminated: true }));
  for (const file of [pidFile, portFile]) {
    try { fs.unlinkSync(file); } catch { /* already removed */ }
  }
  process.exit(0);
} else {
  console.error(`unknown command '${command}'`);
  process.exit(2);
}
