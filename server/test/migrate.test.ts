import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hubOnly, withRole } from "../src/migrate.ts";

describe("moving to a hub and a node", () => {
  it("sets the role as the config's first key, or replaces the one it has", () => {
    expect(withRole('port = 8770\n\n[repo]\npath = "~/app"\n', "hub")).toBe('role = "hub"\nport = 8770\n\n[repo]\npath = "~/app"\n');
    expect(withRole('role = "all"\nport = 8770\n', "node")).toBe('role = "node"\nport = 8770\n');
  });

  it("keeps the hub's part of a database and leaves the node's out", () => {
    const file = join(mkdtempSync(join(tmpdir(), "cockpit-migrate-")), "cockpit.db");
    const db = new Database(file);
    db.exec(`
      create table settings (key text primary key, value text not null);
      create table sessions (id text);
      create table tasks (id text);
      create table snapshots (id text);
      insert into settings values ('tracker', '"jira"'), ('lead:/home/me/app', '{}'), ('worktree-template:/w/A-1/app', '"x"'), ('hubSettingsVersion', '"v"');
      insert into sessions values ('s1');
      insert into tasks values ('t1');
      insert into snapshots values ('n1');
    `);
    db.close();
    hubOnly(file);
    const out = new Database(file, { readonly: true });
    expect(out.prepare("select key from settings").all()).toEqual([{ key: "tracker" }]);
    expect(out.prepare("select count(*) n from sessions").get()).toEqual({ n: 0 });
    expect(out.prepare("select count(*) n from tasks").get()).toEqual({ n: 0 });
    expect(out.prepare("select count(*) n from snapshots").get()).toEqual({ n: 1 });
  });
});
