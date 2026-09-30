import type { ValidationReport } from "../core/types.js";
import type { CertificationOracle } from "./types.js";
/** Bridge existing deterministic AEH validation into the runtime-agnostic oracle contract. */
export declare function validationReportOracle(source: ValidationReport | (() => Promise<ValidationReport>)): CertificationOracle;
