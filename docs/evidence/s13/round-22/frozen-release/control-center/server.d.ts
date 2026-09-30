import type { ProjectRegistryV1 } from "../projects/index.js";
import { PaseoGatewayV1 } from "../paseo/gateway.js";
import { type ControlCenterActionResultV1, type ControlCenterDecisionInputV1, type ControlCenterProjectHealthProjectionV1, type ControlCenterProjectSelectionV1, type ControlCenterSnapshotInputV1 } from "./contracts.js";
export type { ControlCenterEventV1, ControlCenterOverviewV1 } from "./contracts.js";
export type ProjectRuntimeHealthStatusV1 = ControlCenterProjectHealthProjectionV1["runtime"]["status"];
export type ProjectSelectionV1 = ControlCenterProjectSelectionV1;
export type ProjectHealthProbeV1 = ControlCenterProjectHealthProjectionV1;
export interface LocalControlCenterOptionsV1 {
    host?: "127.0.0.1" | "localhost";
    port?: number;
    snapshot?: () => Promise<ControlCenterSnapshotInputV1> | ControlCenterSnapshotInputV1;
    onDecision?: (decision: ControlCenterDecisionInputV1, actorId: string) => Promise<ControlCenterActionResultV1> | ControlCenterActionResultV1;
    onCancelOperation?: (operationId: string, actorId: string) => Promise<ControlCenterActionResultV1> | ControlCenterActionResultV1;
    onPauseOperation?: (operationId: string, actorId: string) => Promise<ControlCenterActionResultV1> | ControlCenterActionResultV1;
    onResumeOperation?: (operationId: string, actorId: string) => Promise<ControlCenterActionResultV1> | ControlCenterActionResultV1;
    healthProbeTimeoutMs?: number;
    paseoGateway?: PaseoGatewayV1;
    paseo?: {
        root: string;
        leadId?: string;
        resolveLeadId?: () => Promise<string | undefined>;
        participantLabels?: Record<string, string>;
        provider?: string;
        model?: string;
    };
    uiRoot?: string;
    operationRoots?: () => Promise<readonly string[]> | readonly string[];
}
export interface StartedControlCenterV1 {
    url: string;
    pairingUrl: string;
    host: string;
    port: number;
}
export declare class ControlCenterSecurityError extends Error {
    readonly statusCode = 403;
    constructor(message: string);
}
interface ProjectHomeBindingV1 {
    registry: ProjectRegistryV1;
    selectedProjectId?: string;
    autoOpen: boolean;
}
export declare class LocalControlCenterV1 {
    private readonly server;
    private readonly host;
    private readonly requestedPort;
    private pairingNonce?;
    private readonly snapshotProvider;
    private readonly onDecision?;
    private readonly onCancelOperation?;
    private readonly onPauseOperation?;
    private readonly onResumeOperation?;
    private readonly healthProbeTimeoutMs;
    private readonly projectHome?;
    private readonly paseoGateway?;
    private readonly paseo?;
    private readonly uiRoot?;
    private readonly operationRootsProvider?;
    private readonly subscribers;
    private eventPollTimer?;
    private eventPoll?;
    private readonly sessions;
    private started?;
    constructor(options?: LocalControlCenterOptionsV1 & {
        projectHome?: ProjectHomeBindingV1;
    });
    start(): Promise<StartedControlCenterV1>;
    close(): Promise<void>;
    private handle;
    private overview;
    private snapshot;
    private projectOverview;
    private collection;
    private detail;
    private projectResource;
    private operationResource;
    private projectSelection;
    private publicProject;
    private probeProjectHealth;
    private assertLoopbackRequest;
    private sessionFor;
    private assertSameOrigin;
    private assertCsrf;
    private pair;
    private paseoSnapshot;
    private currentPaseoLeadId;
    private paseoParticipantTimeline;
    private body;
    private operationRoots;
    private durableEvents;
    private eventsStream;
    private flushDurableEvents;
    private deliverDurableEvents;
    private readDurableEventRecords;
    private json;
    private frontend;
}
export declare function createProjectHome(options: LocalControlCenterOptionsV1 & {
    registry: ProjectRegistryV1;
    projectId?: string;
    autoOpen?: boolean;
}): Promise<LocalControlCenterV1>;
