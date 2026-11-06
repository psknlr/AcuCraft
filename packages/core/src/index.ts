/**
 * @acucraft/core — the acupuncture field on top of the ClinicalCraft engine: schemas, patient-specific anatomy and
 * localisation, the needle lifecycle and its invariants, roles and rules, and the deterministic encounter engine.
 * Isomorphic and pure: no I/O, no clock, no unseeded randomness. See docs/ARCHITECTURE.md.
 */
export * from "./schema/index.js";
export * from "./engine/index.js";
export const ACUCRAFT_VERSION = "0.1.0";
