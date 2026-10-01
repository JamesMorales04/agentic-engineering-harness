import type { CertificationReport } from "./types.js";
export declare function writeCertificationReport(root: string, report: CertificationReport, directory?: string): Promise<string>;
export declare function certificationReportDigest(report: CertificationReport): string;
