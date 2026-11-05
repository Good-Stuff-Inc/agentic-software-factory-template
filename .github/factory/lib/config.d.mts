export interface FactoryConfig {
  project: { owner: string; number: number | null; title: string };
  ruleset: { enabled: boolean; requiredApprovals: number };
  security: { enabled: boolean };
}

export interface FactoryLabel {
  name: string;
  color: string;
  description: string;
}

export interface FactoryProject {
  owner: string;
  number: number;
  url: string;
}

export const configPath: string;
export const labelsPath: string;
export const markerPath: string;
export const repositoryRoot: string;
export const CONFIG_FILE: string;
export const MARKER_FILE: string;
export const ENRICHMENT_WORKFLOW: string;
export const ENRICHMENT_LOCK: string;
export const PROJECT_FIELDS: Array<{
  name: string;
  options: Array<{ name: string; color: string; description: string }>;
}>;
export const REQUIRED_FIELDS: string[];
export const ISSUE_TYPES: Array<{ name: string; description: string; color: string }>;
export const NEEDS_ASSIGNMENT_VIEW: { name: string; filter: string; sortField: string };

export function readMarker(path?: string): string;
export function readLabels(path?: string): FactoryLabel[];
export function parseAllowedLabels(markdown: string): string[];
export function loadConfig(path?: string): FactoryConfig;
export function isValidOwner(owner: unknown): boolean;
export function isValidProjectNumber(number: unknown): boolean;
export function resolveProject(config: FactoryConfig): FactoryProject;
export function writeProjectToConfig(owner: string, number: number, path?: string): string;
