import { mkdirSync } from "node:fs";

// one data folder per test worker: files run in parallel, and two of them switching the same database to WAL at
// once can fail with "database is locked"
process.env.COCKPIT_DATA = `${process.env.COCKPIT_DATA}-${process.env.VITEST_POOL_ID ?? "0"}`;
// made here, since not every module that writes in it makes it first
mkdirSync(process.env.COCKPIT_DATA, { recursive: true });
