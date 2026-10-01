export interface SelfCheckoutRuntimePlan {
    selfCheckout: boolean;
    currentEntry: string;
    localEntry: string;
    localEntryReady: boolean;
    shouldRelaunch: boolean;
    checkoutVersion?: string;
}
export declare function planSelfCheckoutRuntime(root: string, currentEntry: string): Promise<SelfCheckoutRuntimePlan>;
export declare function resolveStartProjectRoot(argv: string[], cwd?: string): string;
