import type { FactoryConfig, FactoryLabel } from '../lib/config.mjs';
import type { GhClient } from '../lib/gh.mjs';

export type SetupStatus = 'ok' | 'created' | 'updated' | 'planned' | 'skipped' | 'warn' | 'fail';
export interface SetupResult {
  step: string;
  status: SetupStatus;
  message: string;
}

export const STEPS: string[];
export const RULESET_NAME: string;
export const ENVIRONMENT_NAME: string;
export const BOOTSTRAP_ENVIRONMENT_NAME: string;

export function parseArgs(argv: string[]): {
  repo?: string;
  only?: string[];
  skip: string[];
  dryRun: boolean;
  commitConfig: boolean;
  summary?: string;
  help?: boolean;
};
export function selectSteps(options: { only?: string[]; skip?: string[] }): string[];
export function rulesetBody(requiredApprovals: number, options?: { copilotReview?: boolean }): any;
export function runSetup(options: {
  client: GhClient;
  repo: string;
  steps?: string[];
  config?: FactoryConfig;
  labels?: FactoryLabel[];
  dryRun?: boolean;
  commitConfig?: boolean;
  writeLocalConfig?: (owner: string, number: number) => unknown;
  log?: (message: string) => void;
}): Promise<SetupResult[]>;
export function renderSummary(results: SetupResult[], options: { repo: string; dryRun: boolean }): string;
