import type { FactoryConfig, FactoryLabel } from '../lib/config.mjs';
import type { GhClient } from '../lib/gh.mjs';

export interface DoctorCheck {
  area: string;
  status: 'pass' | 'warn' | 'fail' | 'skip';
  message: string;
}

export function activeCodeownersRules(text: string | null): string[];
export function runDoctor(options: {
  client: GhClient;
  readClient?: GhClient | null;
  agentClient?: GhClient | null;
  repo: string;
  secrets?: { read: boolean | null; agent: boolean | null; bootstrap: boolean | null; exposed?: string[] };
  readFile?: (path: string) => string | null;
  config?: FactoryConfig;
  labels?: FactoryLabel[];
}): Promise<DoctorCheck[]>;
export function renderReport(checks: DoctorCheck[], options: { repo: string }): string;
