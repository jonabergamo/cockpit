// End to end flows for tickets and links on the Terminals canvas, on the demo's tickets, worktrees and PRs (so no
// tracker of your own is needed) with real shells. Needs tmux and a build: `pnpm build && pnpm e2e:canvas`.
import { expect, openBrowser, startCockpit, steps, until } from "./e2e-lib.mjs";

const cockpit = await startCockpit({ port: Number(process.env.E2E_PORT ?? 8797) + 1, name: "canvas-tickets", demo: true });
const { base, api, shell } = cockpit;
let page;
const { step, results, finish } = steps(() => page);

const edges = async () => (await api("GET", "/canvas")).flatMap((c) => c.edges);
// drags a line from one card's right dot to another card's left dot
async function link(from, to) {
  const a = await page.locator(`${from} .react-flow__handle-right`).boundingBox();
  const b = await page.locator(`${to} .react-flow__handle-left`).boundingBox();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 8 });
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 8 });
  await page.mouse.up();
}
const fit = async () => {
  await page.getByRole("button", { name: "Fit", exact: true }).click();
  await page.waitForTimeout(400);
};

let browser;
const errors = [];
try {
  const one = await shell("one");
  const two = await shell("two");
  await until("the shells on the canvas", async () => (await cockpit.canvasOf("term", one.id)) && (await cockpit.canvasOf("term", two.id)));
  ({ browser, page } = await openBrowser(errors));
  const ticket = (key) => `.react-flow__node:has([data-ticket="${key}"])`;
  const term = (id) => `.react-flow__node:has([data-card="${id}"])`;

  await step("a ticket picked from your tickets shows as a card with its worktree", async () => {
    await page.goto(`${base}/terminals?view=canvas`);
    await page.waitForSelector(`[data-card="${one.id}"] .xterm-rows`);
    await page.getByRole("button", { name: "+ Ticket" }).click();
    await page.getByLabel("Find a ticket").fill("saved cards");
    await page.getByRole("option", { name: /ACME-412/ }).click();
    const card = page.locator(`[data-ticket="ACME-412"]`);
    await card.getByText("Saved cards on the checkout page").waitFor();
    await card.getByText("feat/ACME-412/saved-cards").waitFor();
    await card.getByRole("button", { name: /^Start / }).waitFor();
    // its PR's checks fail in the demo: the card says so, edge and all, and offers to fix them
    await card.getByText("checks fail").waitFor();
    await card.getByRole("button", { name: "Fix checks" }).waitFor();
    expect((await card.getAttribute("data-ci")) === "fail", "the card doesn't show its failing checks");
    expect((await cockpit.canvasOf("ticket", "ACME-412"))?.name === "Main", "the ticket isn't on Main");
  });

  await step("a line drawn from a ticket to a terminal is kept, as work on that ticket", async () => {
    await fit();
    await link(ticket("ACME-412"), term(two.id));
    await until("the line saved", async () => (await edges()).length === 1);
    await page.locator(".canvas-link-work").first().waitFor({ state: "attached" });
    await page.locator(`[data-ticket="ACME-412"]`).getByText("1 terminal").waitFor();
  });

  await step("a line can be selected and taken away", async () => {
    const hit = await page.locator(".react-flow__edge-interaction").first().boundingBox();
    await page.mouse.click(hit.x + hit.width / 2, hit.y + hit.height / 2);
    await page.getByRole("button", { name: "Remove this link" }).click();
    await until("the line gone", async () => (await edges()).length === 0);
  });

  await step("two terminals can be linked too", async () => {
    await fit();
    await link(term(one.id), term(two.id));
    await until("the line saved", async () => (await edges()).length === 1);
    await page.locator(".canvas-link-talk").first().waitFor({ state: "attached" });
  });

  await step("Canvas on the Tickets page puts that ticket on the canvas", async () => {
    await page.goto(`${base}/tickets`);
    await page.locator("#ticket-ACME-418").getByRole("button", { name: "Canvas" }).click();
    await until("the canvas", async () => page.url().includes("ticket=ACME-418"));
    await page.locator(`[data-ticket="ACME-418"]`).getByText("Search results load in under 300ms").waitFor();
    expect(!!(await cockpit.canvasOf("ticket", "ACME-418")), "ACME-418 isn't on the canvas");
  });

  await step("a ticket card comes off the canvas with its lines", async () => {
    await fit();
    await link(ticket("ACME-412"), term(one.id));
    await until("the line saved", async () => (await edges()).length === 2);
    await page.locator(ticket("ACME-412")).getByRole("button", { name: "Remove ticket card" }).click();
    await until("the card gone", async () => !(await cockpit.canvasOf("ticket", "ACME-412")));
    expect((await edges()).length === 1, "its line is still there");
  });

  await step("no errors on the page", async () => expect(!errors.length, errors.join(" | ")));
} catch (e) {
  results.push(`FAIL setup: ${e instanceof Error ? e.message : e}`);
} finally {
  await browser?.close();
  cockpit.stop();
}
finish();
