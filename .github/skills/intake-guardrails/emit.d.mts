export const MAX_ITEMS: number;

export function prepareItems(payload: unknown): Array<{
  title: string;
  body: string;
  fields: Record<string, string>;
  provenance: { adapter: string; sourceRef: string };
}>;

export function runIntake(payload: unknown, dependencies?: {
  runGh?: (args: string[]) => unknown;
  log?: (message: string) => void;
  project?: { owner: string; number: number; url: string };
}): Promise<string[]>;
