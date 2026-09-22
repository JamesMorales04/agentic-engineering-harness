import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ControlCenterApi, ControlCenterApiError, type Candidate, type Knowledge, type Operation, type Overview, type Participant } from "./api";

const api = new ControlCenterApi();
type Mode = "home" | "project";

function label(value: string | undefined): string { return value?.replaceAll("_", " ").toLowerCase() ?? "unknown"; }
function short(value: string | undefined): string { return value ? `${value.slice(0, 12)}…` : "—"; }
function tone(value: string | undefined): string { return (value ?? "unknown").toLowerCase().replaceAll("_", "-"); }

function StatusPill({ value }: { value: string | undefined }) {
  return <span className={`pill pill-${tone(value)}`} aria-label={`Status: ${label(value)}`}>{label(value)}</span>;
}

function Metric({ name, value, detail }: { name: string; value: string | number; detail?: string }) {
  return <div className="metric"><span className="eyebrow">{name}</span><strong>{value}</strong>{detail && <small>{detail}</small>}</div>;
}

function Card({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return <section className="card"><div className="card-heading"><h2>{title}</h2>{aside}</div>{children}</section>;
}

function KnowledgeCard({ knowledge }: { knowledge: Knowledge }) {
  return <Card title="Knowledge gate" aside={<StatusPill value={knowledge.status} />}>
    <div className="stack"><div className="row"><span>Mode</span><strong>{label(knowledge.mode)}</strong></div><div className="row"><span>Trusted sources</span><strong>{knowledge.trustedSourceCount}</strong></div><div className="row"><span>Librarian</span><strong>{knowledge.librarianRequired ? "required" : "not required"}</strong></div></div>
    {knowledge.missingCompetencies.length > 0 && <p className="notice">Gap: {knowledge.missingCompetencies.join(", ")}</p>}
  </Card>;
}

function AssuranceCard({ overview }: { overview: Overview }) {
  const { quality, certification, security } = overview;
  return <Card title="Assurance" aside={<StatusPill value={quality.status} />}>
    <div className="assurance-grid"><div><span className="eyebrow">Quality</span><strong>{quality.unresolvedFindingCount} unresolved</strong><small>{quality.rounds} rounds · {quality.findingCount} findings</small></div><div><span className="eyebrow">Certification</span><strong>{certification.passedChecks}/{certification.checks || 0}</strong><small>{label(certification.status)}</small></div></div>
    <p className="muted">{security.loopbackOnly ? "Loopback only" : "Network exposed"} · {security.csrfForMutations ? "CSRF protected mutations" : "Read-only"}</p>
  </Card>;
}

function PaseoCard({ connected }: { connected: boolean }) {
  const query = useQuery({ queryKey: ["paseo"], queryFn: () => api.paseo(), enabled: connected });
  const snapshot = query.data;
  const state = query.isError ? "DEGRADED" : snapshot?.status ?? (connected ? "DEGRADED" : "UNAVAILABLE");
  return <Card title="Paseo gateway" aside={<StatusPill value={state} />}><p className="notice">{snapshot?.message ?? (snapshot?.status === "AVAILABLE" ? `${snapshot.participants.length} participant${snapshot.participants.length === 1 ? "" : "s"} projected by the bounded gateway.` : "The bounded Paseo gateway is unavailable or not configured." )}</p><span className="muted">{query.isFetching ? "Refreshing…" : snapshot ? `Captured ${new Date(snapshot.capturedAt).toLocaleTimeString()}` : "No gateway snapshot"} · no Paseo credentials are rendered or stored.</span></Card>;
}

function LeadConversation({ csrfToken, operationId }: { csrfToken: string; operationId?: string }) {
  const [message, setMessage] = useState("");
  const [result, setResult] = useState<string>();
  const mutation = useMutation({ mutationFn: () => api.leadMessage(csrfToken, message.trim()), onSuccess: (data) => { setResult(data.lastMessage ?? data.error ?? (data.status ? `Lead status: ${data.status}` : "Message sent to lead.")); setMessage(""); } });
  const disabled = !csrfToken || !message.trim() || mutation.isPending;
  return <Card title="Lead conversation" aside={<span className="muted">bounded Paseo surface</span>}>
    <p className="muted">Send a bounded message through AEH&apos;s PaseoGateway. This panel never accepts or forwards raw Paseo credentials.</p>
    <form className="conversation" onSubmit={(event) => { event.preventDefault(); if (!disabled) mutation.mutate(); }}>
      <label htmlFor="lead-message">Message for the lead</label><textarea id="lead-message" value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Ask for a bounded decision…" rows={3} maxLength={4_000} />
      <div className="form-footer"><span className="muted">{message.length}/4000</span><button type="submit" disabled={disabled}>{mutation.isPending ? "Sending…" : "Send to lead"}</button></div>
    </form>
    {result && <p className="success" role="status">{result}</p>}
    {mutation.error && <p className="error" role="alert">{mutation.error instanceof Error ? mutation.error.message : "Decision failed."}</p>}
  </Card>;
}

function ParticipantTable({ participants }: { participants: Participant[] }) {
  if (!participants.length) return <p className="muted">No compiled participants are currently projected.</p>;
  return <div className="table-wrap"><table><caption className="sr-only">Compiled participant status</caption><thead><tr><th scope="col">Participant</th><th scope="col">Role</th><th scope="col">Phase</th><th scope="col">Status</th><th scope="col">Skills</th></tr></thead><tbody>{participants.map((participant) => <tr key={participant.participantId}><td><code>{short(participant.participantId)}</code></td><td>{participant.role ?? participant.logicalAgent ?? "—"}</td><td>{participant.phase ?? "—"}</td><td><StatusPill value={participant.status} /></td><td>{participant.skills.slice(0, 3).join(", ") || "—"}</td></tr>)}</tbody></table></div>;
}

function Operations({ operations }: { operations: Operation[] }) {
  return <Card title="Operations" aside={<span className="muted">{operations.length} projected</span>}>
    {!operations.length ? <p className="muted">No operations in the current projection.</p> : <div className="operation-list">{operations.slice(0, 8).map((operation) => <div className="operation" key={operation.operationId}><div><strong>{label(operation.kind)}</strong><small><code>{short(operation.operationId)}</code> · {operation.phase}</small></div><StatusPill value={operation.status} /></div>)}</div>}
  </Card>;
}

function Home({ overview, csrfToken }: { overview: Overview; csrfToken: string }) {
  const active = overview.operations.filter((operation) => operation.status === "RUNNING" || operation.status === "QUEUED").length;
  return <><div className="hero"><div><span className="kicker">AEH / HOME</span><h1>Engineering signal, at a glance.</h1><p>One read-only projection of projects, operations, participants, assurance, and current authority.</p></div><StatusPill value="CONNECTED" /></div><div className="metrics"><Metric name="Projects" value={overview.projects.length} /><Metric name="Active operations" value={active} detail={`${overview.operations.length} total`} /><Metric name="Participants" value={overview.participants.length} /><Metric name="Candidate" value={overview.candidates.length ? `r${overview.candidates.at(-1)?.revision ?? "—"}` : "—"} /></div><div className="grid two"><KnowledgeCard knowledge={overview.knowledge} /><AssuranceCard overview={overview} /><PaseoCard connected /><LeadConversation csrfToken={csrfToken} /></div><Operations operations={overview.operations} /></>;
}

function ProjectCenter({ overview, csrfToken, onSelect }: { overview: Overview; csrfToken: string; onSelect: (id: string) => void }) {
  const project = overview.project ?? overview.projects[0];
  const context = overview.context;
  const budget = context.budgetTokens ? `${context.consumedTokens ?? 0}/${context.budgetTokens}` : "not projected";
  return <><div className="hero"><div><span className="kicker">PROJECT CONTROL CENTER</span><h1>{project?.displayName ?? "Select a project"}</h1><p>{project ? `${project.repositoryIdentity} · ${short(project.configDigest)}` : "Choose a registered project to inspect its current projection."}</p></div>{project && <StatusPill value={project.availability} />}</div><div className="project-picker"><label htmlFor="project">Project</label><select id="project" value={overview.projectSelection?.projectId ?? project?.projectId ?? ""} onChange={(event) => onSelect(event.target.value)}><option value="">Select project</option>{overview.projects.map((item) => <option value={item.projectId} key={item.projectId}>{item.displayName}</option>)}</select><span className="muted">Health: {overview.projectHealth?.runtime.status ?? "not checked"}</span></div><div className="metrics"><Metric name="Token budget" value={budget} detail={`${context.continuationCount} continuations`} /><Metric name="Authorized refs" value={context.authorizedReferenceCount} /><Metric name="Leases" value={overview.authority.leases.length} /><Metric name="Evidence" value={overview.evidence.length} /></div><div className="grid two"><KnowledgeCard knowledge={overview.knowledge} /><AssuranceCard overview={overview} /><Card title="Candidate"><p className="digest">{overview.candidates.length ? overview.candidates.map((candidate) => <span key={candidate.controlCenterId}><code>r{candidate.revision}</code> {short(candidate.identityDigest)}</span>) : <span className="muted">No candidate projection.</span>}</p></Card><Card title="Services"><div className="stack">{overview.services.services.length ? overview.services.services.map((service) => <div className="row" key={service.serviceId}><span>{service.kind}</span><StatusPill value={service.status} /></div>) : <span className="muted">No service projection.</span>}</div></Card></div><Card title="Compiled participants"><ParticipantTable participants={overview.participants} /></Card><LeadConversation csrfToken={csrfToken} operationId={overview.operations.find((item) => item.status === "RUNNING")?.operationId} /><Operations operations={overview.operations} /></>;
}

export function App({ mode, onModeChange }: { mode: Mode; onModeChange: (mode: Mode) => void }) {
  const [csrfToken, setCsrfToken] = useState("");
  const [pairingError, setPairingError] = useState<string>();
  const [selectedError, setSelectedError] = useState<string>();
  const queryClient = useQueryClient();
  const sessionInitialized = useRef(false);
  useEffect(() => {
    if (sessionInitialized.current) return;
    sessionInitialized.current = true;
    const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const nonce = fragment.get("pair");
    if (window.location.hash) window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    const session = nonce ? api.pair(nonce) : api.session();
    void session.then((value) => setCsrfToken(value.csrfToken)).catch((error: unknown) => {
      setPairingError(error instanceof ControlCenterApiError && error.status === 401
        ? "No paired session is available. Open a fresh Control Center pairing link from AEH."
        : error instanceof Error ? error.message : "Control Center pairing failed.");
    });
  }, []);
  const query = useQuery({ queryKey: ["overview"], queryFn: () => api.overview(), enabled: Boolean(csrfToken) });
  const overview = query.data;
  const connectionError = query.error instanceof ControlCenterApiError && query.error.status === 401 ? "The paired session expired. Open a fresh Control Center pairing link from AEH." : query.error?.message;
  const projectMutation = useMutation({ mutationFn: (id: string) => api.selectProject(csrfToken, id), onSuccess: () => queryClient.invalidateQueries({ queryKey: ["overview"] }), onError: (error) => setSelectedError(error instanceof Error ? error.message : "Project selection failed.") });
  const status = !csrfToken ? "PAIRING REQUIRED" : query.isFetching ? "SYNCING" : query.isError ? "DEGRADED" : "CONNECTED";
  return <div className="app-shell"><header className="topbar"><a className="brand" href="/" aria-label="AEH Control Center home"><span className="brand-mark">A</span><span>AEH <small>CONTROL CENTER</small></span></a><nav aria-label="View mode"><button className={mode === "home" ? "nav-active" : ""} onClick={() => onModeChange("home")}>Home</button><button className={mode === "project" ? "nav-active" : ""} onClick={() => onModeChange("project")}>Project Control Center</button></nav><StatusPill value={status} /></header><main><section className="connection"><strong>{csrfToken ? "Paired loopback session" : "Single-use loopback pairing"}</strong><span className="muted">{csrfToken ? "Session is held in an HttpOnly cookie · no provider credentials are requested" : "Open the pairing link printed by aeh start or aeh home"}</span></section>{pairingError && <div className="error banner" role="alert">{pairingError}</div>}{connectionError && <div className="error banner" role="alert">{connectionError}</div>}{selectedError && <div className="error banner" role="alert">{selectedError}</div>}{!overview && !query.isError && <div className="empty"><h1>{csrfToken ? "Loading the current projection." : "Pair this browser with AEH."}</h1><p>{csrfToken ? "The authenticated Control Center session is ready." : "Use the single-use loopback link from aeh start. Pairing happens in this browser and the URL fragment is cleared immediately."}</p></div>}{overview && (mode === "home" ? <Home overview={overview} csrfToken={csrfToken} /> : <ProjectCenter overview={overview} csrfToken={csrfToken} onSelect={(id) => projectMutation.mutate(id)} />)}</main><footer><span>{overview ? `AEH ${overview.buildIdentity.packageVersion} · ${overview.buildIdentity.releaseId} · ${new Date(overview.generatedAt).toLocaleTimeString()}` : "AEH · offline"}</span><span>Bounded projections · local authenticated surface</span></footer></div>;
}
