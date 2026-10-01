export type ControlCenterLeadBindingV1 = {
    status: "BOUND";
    leadId: string;
} | {
    status: "UNCONFIGURED";
    reason: string;
};
export declare function resolveControlCenterLeadBinding(root: string, expectedStartLeadId?: string): Promise<ControlCenterLeadBindingV1>;
