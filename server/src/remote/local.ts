// This machine, as a Host: the same helpers cockpit has always used, called in the process
import { currentCwd, input, kill, listTerms, resize, spawnTerm } from "../pty.ts";
import { run, stream } from "../util.ts";
import type { Host } from "./host.ts";

export const localHost: Host = {
  id: "local",
  exec: (cmd, args, opts) => run(cmd, args, opts),
  stream: (command, onChunk, cwd) => stream(command, onChunk, cwd),
  terminals: {
    spawn: (opts) => spawnTerm(opts),
    list: () => listTerms(),
    input: (id, data) => input(id, data),
    resize: (id, cols, rows) => resize(id, cols, rows),
    kill: (id) => kill(id),
    cwd: (id) => currentCwd(id),
  },
};
