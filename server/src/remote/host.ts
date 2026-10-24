// A machine cockpit can work on. Everything that runs a command, opens a terminal or reads files of the machine it
// runs on goes through one, so the same code can later work on this machine or on a node over its link. "local"
// is the machine this process runs on; a single-machine cockpit only ever has that one.
import type { TermInfo } from "@cockpit/shared";

export interface ExecOpts {
  cwd?: string;
  input?: string;
  timeout?: number;
  env?: Record<string, string>;
}

export interface SpawnOpts {
  cwd: string;
  title?: string;
  command?: string;
  args?: string[];
  session?: string;
  parent?: string;
  run?: string;
  beside?: boolean;
}

export interface Host {
  id: string;
  // a command and its arguments, no shell; resolves with stdout, rejects with stderr
  exec(cmd: string, args: string[], opts?: ExecOpts): Promise<string>;
  // a shell command line (bash -lc), its output as it comes
  stream(command: string, onChunk: (s: string) => void, cwd?: string): Promise<{ code: number; out: string }>;
  terminals: {
    spawn(opts: SpawnOpts): TermInfo;
    list(): TermInfo[];
    input(id: string, data: string): void;
    resize(id: string, cols: number, rows: number): void;
    kill(id: string): void;
    cwd(id: string): string | undefined;
  };
}
