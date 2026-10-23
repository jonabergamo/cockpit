import { describe, expect, it } from "vitest";
import { countShells, parsePs, ppidOf } from "../src/claude/background.ts";
import { columnOf } from "../src/board.ts";

describe("background shells", () => {
  it("reads the parent pid even when the command name has spaces and brackets", () => {
    expect(ppidOf("4242 (tmux: server (x)) S 4100 4242 4242 0 -1 4194560")).toBe(4100);
  });

  it("counts only Claude's own shells under each Claude process", () => {
    const shell = "/bin/bash -c source /home/dev/.claude/shell-snapshots/snapshot-bash-1-abc.sh && eval 'pnpm dev'";
    const procs = [
      { pid: 10, ppid: 1, cmdline: shell },
      { pid: 11, ppid: 1, cmdline: shell },
      { pid: 12, ppid: 1, cmdline: "node /home/dev/mcp/server.js" },
      { pid: 13, ppid: 2, cmdline: shell },
      { pid: 14, ppid: 99, cmdline: shell },
    ];
    expect(countShells(procs, new Set([1, 2, 3]))).toEqual(new Map([[1, 2], [2, 1]]));
  });

  it("reads ps output the way macOS prints it", () => {
    const out = "    1     0 /sbin/launchd\n  812   640 /bin/zsh -c source /Users/dev/.claude/shell-snapshots/snapshot-zsh-1-x.sh && eval 'pnpm dev'\n  813   640 node mcp.js\n";
    const procs = parsePs(out);
    expect(procs[1]).toEqual({ pid: 812, ppid: 640, cmdline: "/bin/zsh -c source /Users/dev/.claude/shell-snapshots/snapshot-zsh-1-x.sh && eval 'pnpm dev'" });
    expect(countShells(procs, new Set([640]))).toEqual(new Map([[640, 1]]));
  });

  it("keeps a session with background shells in Working", () => {
    expect(columnOf({ session: { status: "busy", background: 2, updatedAt: 0 } })).toEqual({ column: "working", reason: "2 shells running in the background" });
  });
});
