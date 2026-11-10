export const MAX_DIFF: number;
export function nameOnly(path: string): boolean;
export function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string | undefined>;
export function topOf(cwd: string): Promise<string | undefined>;
export function snapshot(cwd: string): Promise<string | undefined>;
export function diffBetween(cwd: string, from: string, to: string): Promise<{ files: string[]; skipped: string[]; diff: string } | undefined>;
export function capDiff(diff: string, max?: number): { text: string; cut: boolean; size: number };
export function fenced(text: string, lang?: string): string;
