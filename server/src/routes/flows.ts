import { Hono } from "hono";
import type { Flow } from "@cockpit/shared";
import { answerStep, cancelFlow, checkFlow, getFlowRun, listFlowRuns, type NewFlowRun, startFlow } from "../flows.ts";
import { getSettings } from "../settings.ts";

const fail = (e: unknown) => Response.json({ error: (e as Error).message }, { status: (e as { status?: number }).status ?? 500 });

// The recipes live in Settings (flows); this is running them
export const flows = new Hono()
  .get("/", (c) => c.json(getSettings().flows.map((f) => ({ ...f, problem: checkFlow(f as Flow) }))))
  .get("/runs", (c) => c.json(listFlowRuns()))
  .post("/runs", async (c) => {
    try {
      return c.json(await startFlow(await c.req.json<NewFlowRun>()));
    } catch (e) {
      return fail(e);
    }
  })
  .get("/runs/:id", (c) => {
    const r = getFlowRun(c.req.param("id"));
    return r ? c.json(r) : c.notFound();
  })
  .post("/runs/:id/cancel", (c) => c.json(cancelFlow(c.req.param("id")) ?? null))
  .post("/runs/:id/steps/:step/answer", async (c) => {
    const b = await c.req.json<{ verdict: "approve" | "changes"; note?: string }>();
    try {
      return c.json(await answerStep(c.req.param("id"), c.req.param("step"), b.verdict === "changes" ? "changes" : "approve", b.note));
    } catch (e) {
      return fail(e);
    }
  });
