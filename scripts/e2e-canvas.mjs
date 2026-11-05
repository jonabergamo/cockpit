// End to end flows for the Terminals canvas: real shells on a cockpit of the script's own, driven in a browser.
// Needs tmux and a build: `pnpm build && pnpm e2e:canvas`. PLAYWRIGHT_CHROMIUM points at a browser of your own.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { expect, openBrowser, startCockpit, steps, until } from "./e2e-lib.mjs";

const WORD = "QWERTYUIOPASDFGHJKLZXCVBNM";
const cockpit = await startCockpit({ port: Number(process.env.E2E_PORT ?? 8797), name: "canvas" });
const { base, api, shell } = cockpit;
const canvasOf = (term) => cockpit.canvasOf("term", term);
let page;
const { step, results, finish } = steps(() => page);

let browser;
const errors = [];
const cleanup = [];
try {
  const a = await shell("alpha");
  const b = await shell("bravo");
  await until("both shells on the canvas", async () => (await canvasOf(a.id)) && (await canvasOf(b.id)));

  ({ browser, page } = await openBrowser(errors));
  const card = (id) => page.locator(`.react-flow__node:has([data-card="${id}"])`);

  await step("terminals opened elsewhere show up on the first workspace", async () => {
    await page.goto(`${base}/terminals?view=canvas`);
    await page.waitForSelector(`[data-card="${a.id}"] .xterm-rows`);
    await page.waitForSelector(`[data-card="${b.id}"] .xterm-rows`);
    expect(await page.getByRole("tab", { name: /Main/ }).getAttribute("aria-selected") === "true", "Main isn't the open workspace");
  });

  await step("a dragged card keeps its new place", async () => {
    const before = (await canvasOf(a.id)).nodes.find((n) => n.ref === a.id);
    const h = await card(a.id).locator(".card-handle").boundingBox();
    await page.mouse.move(h.x + 60, h.y + h.height / 2);
    await page.mouse.down();
    await page.mouse.move(h.x + 160, h.y + 80, { steps: 8 });
    await page.mouse.move(h.x + 260, h.y + 160, { steps: 8 });
    await page.mouse.up();
    await until("the new place saved", async () => {
      const n = (await canvasOf(a.id)).nodes.find((x) => x.ref === a.id);
      return n.x > before.x + 50 && n.y > before.y + 50;
    });
  });

  await step("a terminal started while the canvas is open joins it live", async () => {
    const c = await shell("charlie");
    globalThis.charlie = c.id;
    await until("the tab count to reach 3", async () => /3/.test(await page.getByRole("tab", { name: /Main/ }).textContent()));
  });

  await step("a link to a terminal brings it up at 100%", async () => {
    await page.goto(`${base}/terminals?view=canvas&id=${globalThis.charlie}`);
    await page.waitForSelector(`[data-card="${globalThis.charlie}"] .xterm-rows`);
    await until("zoom 1", async () => /scale\(1\)/.test(await page.locator(".react-flow__viewport").getAttribute("style")));
  });

  await step("selecting text away from 100% selects what's under the mouse", async () => {
    const id = globalThis.charlie;
    await page.locator(".react-flow__controls-zoomout").click();
    await page.locator(".react-flow__controls-zoomout").click();
    await until("zoom below 1", async () => {
      const m = (await page.locator(".react-flow__viewport").getAttribute("style")).match(/scale\(([\d.]+)\)/);
      return m && Number(m[1]) < 0.9;
    });
    await api("POST", `/code/terms/${id}/input`, { data: `printf '%s\\n' ${WORD} ${WORD}\r` });
    const box = await until("the printed word", () =>
      page.evaluate(
        ([id, word]) => {
          const walker = document.createTreeWalker(document.querySelector(`[data-card="${id}"] .xterm-rows`), NodeFilter.SHOW_TEXT);
          for (let n; (n = walker.nextNode()); ) {
            const i = n.textContent.indexOf(word);
            if (i < 0 || n.parentElement.closest("div").textContent.includes("printf")) continue;
            const at = (k) => {
              const r = document.createRange();
              r.setStart(n, i + k);
              r.setEnd(n, i + k + 1);
              return r.getBoundingClientRect();
            };
            const s = at(3);
            const e = at(9);
            return { x1: s.left + 1, x2: e.right - 1, y: s.top + s.height / 2 };
          }
          return null;
        },
        [id, WORD],
      ),
    );
    await page.evaluate(() => navigator.clipboard.writeText(""));
    await page.mouse.move(box.x1, box.y);
    await page.mouse.down();
    await page.mouse.move((box.x1 + box.x2) / 2, box.y, { steps: 5 });
    await page.mouse.move(box.x2, box.y, { steps: 5 });
    await page.mouse.up();
    await page.keyboard.press("Control+Shift+C");
    const got = await until("the copy", () => page.evaluate(() => navigator.clipboard.readText()));
    expect(got.trim() === WORD.slice(3, 10), `selected "${got.trim()}" instead of "${WORD.slice(3, 10)}"`);
  });

  await step("a link in a terminal away from 100% opens when it's clicked", async () => {
    const id = globalThis.charlie;
    const url = "https://example.com/cockpit-link-check";
    await page.context().route(/example\.com/, (r) => r.fulfill({ body: "ok" }));
    await api("POST", `/code/terms/${id}/input`, { data: `printf '%s\\n' '${url}'\r` });
    // the middle of the printed link, not of the command that printed it
    const at = await until("the printed link", () =>
      page.evaluate(
        ([id, word]) => {
          const walker = document.createTreeWalker(document.querySelector(`[data-card="${id}"] .xterm-rows`), NodeFilter.SHOW_TEXT);
          for (let n; (n = walker.nextNode()); ) {
            const i = n.textContent.indexOf(word);
            if (i < 0 || n.parentElement.closest("div").textContent.includes("printf")) continue;
            const r = document.createRange();
            r.setStart(n, i + 20);
            r.setEnd(n, i + 21);
            const b = r.getBoundingClientRect();
            return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
          }
          return null;
        },
        [id, url],
      ),
    );
    const zoom = await page.evaluate(() => Number(document.querySelector(".react-flow__viewport").style.transform.match(/scale\(([\d.]+)\)/)?.[1] ?? 1));
    expect(zoom < 0.9, `the canvas is at ${zoom}, so this checks nothing`);
    const opened = page.waitForEvent("popup", { timeout: 8000 });
    // hovering first, the way a person reaches a link
    await page.mouse.move(at.x - 30, at.y, { steps: 4 });
    await page.mouse.move(at.x, at.y, { steps: 4 });
    await page.mouse.click(at.x, at.y);
    const popup = await opened;
    expect(popup.url().includes("cockpit-link-check"), `it opened ${popup.url()}`);
    await popup.close();
    await page.context().unroute(/example\.com/);
  });

  await step("a note keeps its markdown across a reload", async () => {
    await page.getByRole("button", { name: "Fit", exact: true }).click();
    // the fit animates; the note goes in the middle of where it ends up
    await page.waitForTimeout(400);
    await page.getByRole("button", { name: "+ Note" }).first().click();
    const area = page.getByLabel("Note text");
    await area.waitFor();
    await area.fill("# Plan\n- **ship it**");
    await page.waitForTimeout(700);
    await page.locator("[data-note]").getByRole("button", { name: "Done" }).click();
    await page.locator("[data-note] strong", { hasText: "ship it" }).waitFor();
    await page.reload();
    await page.locator("[data-note] strong", { hasText: "ship it" }).waitFor({ timeout: 10_000 });
  });

  await step("a new workspace is named, and a terminal moves onto it", async () => {
    await page.getByRole("button", { name: "New workspace" }).click();
    const name = page.getByLabel("Workspace name");
    await name.fill("Review");
    await name.press("Enter");
    await page.getByText("Nothing on Review yet.").waitFor();
    await page.getByRole("tab", { name: /Main/ }).click();
    await page.getByRole("button", { name: "Fit", exact: true }).click();
    await card(a.id).locator('select[aria-label="Move to workspace"]').selectOption({ label: "Review" });
    await until("alpha on Review", async () => (await canvasOf(a.id))?.name === "Review");
    await page.getByRole("tab", { name: /Review/ }).click();
    await page.waitForSelector(`[data-card="${a.id}"] .xterm-rows`);
  });

  await step("closing a terminal takes its card off", async () => {
    await card(a.id).getByRole("button", { name: "Close terminal" }).click();
    await page.getByText("Nothing on Review yet.").waitFor();
    await until("alpha closed", async () => !(await api("GET", "/code/terms")).some((t) => t.id === a.id));
    await until("its card gone", async () => !(await canvasOf(a.id)));
  });

  await step("deleting a workspace sends its terminals back to the first one", async () => {
    // bravo onto Review, then delete Review
    await api("POST", `/canvas/${(await api("GET", "/canvas")).find((c) => c.name === "Review").id}/terms`, { term: b.id });
    await until("bravo on Review", async () => (await canvasOf(b.id))?.name === "Review");
    const tab = page.getByRole("tab", { name: /Review/ });
    await tab.click();
    await tab.hover();
    await page.getByRole("button", { name: "Delete workspace Review" }).click();
    await until("Review gone", async () => (await api("GET", "/canvas")).length === 1);
    expect((await canvasOf(b.id))?.name === "Main", "bravo isn't back on Main");
  });

  await step("a changes card linked to a terminal shows its branch, with each file's diff", async () => {
    // a repo on a branch of its own: one commit on it, one file changed since and a new one not tracked yet
    // in your home, since that is where cockpit lets a saved folder be; removed again at the end
    mkdirSync(join(homedir(), ".cache"), { recursive: true });
    const repo = mkdtempSync(join(homedir(), ".cache", "cockpit-e2e-repo-"));
    cleanup.push(() => rmSync(repo, { recursive: true, force: true }));
    const git = (...args) => execFileSync("git", ["-C", repo, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: "e2e", GIT_AUTHOR_EMAIL: "e2e@example.com", GIT_COMMITTER_NAME: "e2e", GIT_COMMITTER_EMAIL: "e2e@example.com" } });
    git("init", "-q", "-b", "main");
    writeFileSync(join(repo, "app.ts"), "one\ntwo\n");
    git("add", ".");
    git("commit", "-qm", "start");
    git("checkout", "-qb", "feat/canvas-e2e");
    writeFileSync(join(repo, "app.ts"), "one\ntwo\nthree\n");
    git("commit", "-qam", "add three");
    writeFileSync(join(repo, "fresh.ts"), "brand new\n");
    // a folder cockpit knows, so a terminal may open there
    await api("POST", "/code/folders", { path: repo });
    const t = await api("POST", "/code/terms", { cwd: repo, title: "repo" });
    await until("its card", async () => await canvasOf(t.id));
    await page.goto(`${base}/terminals?view=canvas&id=${t.id}`);
    await page.waitForSelector(`[data-card="${t.id}"] .xterm-rows`);
    await page.getByRole("button", { name: "Fit", exact: true }).click();
    await page.waitForTimeout(400);
    await page.getByRole("button", { name: "+ Changes" }).click();
    const changes = page.locator("[data-changes]");
    await changes.getByText(/Draw a line from this card/).waitFor();
    // both on screen, then linked by a line from the changes card to the terminal
    await page.waitForTimeout(400);
    await page.getByRole("button", { name: "Fit", exact: true }).click();
    await page.waitForTimeout(400);
    const from = await page.locator(`.react-flow__node:has([data-changes]) .react-flow__handle-left`).boundingBox();
    const to = await page.locator(`.react-flow__node:has([data-card="${t.id}"]) .react-flow__handle-right`).boundingBox();
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 8 });
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
    await page.mouse.up();
    await changes.getByText("feat/canvas-e2e").waitFor();
    await changes.getByText("1 ahead", { exact: false }).waitFor();
    await changes.getByText("1 not committed").waitFor();
    await changes.getByText("fresh.ts").waitFor();
    await changes.getByRole("button", { name: /app\.ts/ }).click();
    await changes.getByText("+three").waitFor();
    // at 100%, for the proof
    await changes.locator(".card-handle").dblclick();
    await page.waitForTimeout(400);
  });

  await step("a terminal waiting on you glows, the toolbar takes you there and its menu answers from the card", async () => {
    const w = await shell("waiter");
    await until("its card", async () => await canvasOf(w.id));
    // a Claude asking to run something, in that terminal: the socket's sessions are swapped for this one
    const fake = { id: "e2e-waiting", project: "e2e", cwd: w.cwd, title: "Needs a yes", status: "waiting", startedAt: Date.now(), updatedAt: Date.now(), size: 0, term: w.id };
    const p = await page.context().newPage();
    p.on("pageerror", (e) => errors.push(e.message));
    await p.routeWebSocket(/\/ws$/, (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((m) => server.send(m));
      server.onMessage((m) => {
        if (typeof m === "string" && m.includes('"type":"sessions"')) return;
        ws.send(m);
      });
      setTimeout(() => ws.send(JSON.stringify({ type: "sessions", sessions: [fake] })), 300);
    });
    let pressed;
    await p.route("**/api/sessions/e2e-waiting/ask", (r) => r.fulfill({ json: { reachable: true, screen: "", question: "Run the tests?", options: [{ key: "1", label: "Yes" }, { key: "2", label: "No" }] } }));
    await p.route("**/api/sessions/e2e-waiting/keys", async (r) => {
      pressed = r.request().postDataJSON().keys;
      await r.fulfill({ json: { sent: true } });
    });
    await p.goto(`${base}/terminals?view=canvas`);
    // it may well be off screen: the toolbar says one is waiting, and takes you to it
    await p.getByRole("button", { name: /1 waiting/ }).click();
    await p.locator(`[data-card="${w.id}"][data-status="waiting"]`).waitFor({ state: "attached" });
    await until("zoom 1 on it", async () => /scale\(1\)/.test(await p.locator(".react-flow__viewport").getAttribute("style")));
    const strip = p.locator(`[data-card="${w.id}"] [data-waiting]`);
    await strip.getByText("Run the tests?").waitFor();
    await strip.getByRole("button", { name: /Yes/ }).click();
    await until("the key pressed", async () => pressed?.[0] === "1");
    if (process.env.E2E_PROOFS) await p.screenshot({ path: join(process.env.E2E_PROOFS, "waiting.png") });
    await p.close();
  });

  await step("the keys find a card, move between cards and type into a terminal", async () => {
    await page.goto(`${base}/terminals?view=canvas`);
    await page.waitForSelector(".react-flow__node");
    await page.locator(".react-flow__pane").click({ position: { x: 8, y: 8 } });
    await page.keyboard.press("/");
    const find = page.getByLabel("Find a card");
    await find.fill("charlie");
    await find.press("Enter");
    const selected = () => page.locator(".react-flow__node.selected [data-card]").getAttribute("data-card");
    await until("charlie selected", async () => (await selected()) === globalThis.charlie);
    await page.keyboard.press("ArrowLeft");
    await until("another card selected", async () => ((await page.locator(".react-flow__node.selected").count()) === 1 && (await page.locator(`.react-flow__node.selected [data-card="${globalThis.charlie}"]`).count()) === 0));
    await page.keyboard.press("ArrowRight");
    await until("back on charlie", async () => (await selected()) === globalThis.charlie);
    await page.keyboard.press("Enter");
    await until("zoom 1", async () => /scale\(1\)/.test(await page.locator(".react-flow__viewport").getAttribute("style")));
    await until("typing into charlie", async () => page.evaluate((id) => !!document.activeElement?.closest(`[data-card="${id}"]`), globalThis.charlie));
  });

  await step("coming back after a while shows what the agents did, and a row takes you to its terminal", async () => {
    const main = (await api("GET", "/canvas")).find((c) => c.nodes.some((n) => n.ref === globalThis.charlie));
    const p = await page.context().newPage();
    p.on("pageerror", (e) => errors.push(e.message));
    // an hour since you last looked at it, and one agent that got something done meanwhile
    await p.addInitScript((ws) => localStorage.setItem(`cockpit.canvasSeen.${ws}`, String(Date.now() - 3600_000)), main.id);
    await p.route("**/api/canvas/*/away?*", (r) =>
      r.fulfill({ json: [{ term: globalThis.charlie, session: "s1", title: "Export button", status: "idle", edited: ["/r/a.ts", "/r/b.ts"], commands: 3, commits: ["feat: export"], last: "The export works and its test passes." }] }),
    );
    await p.goto(`${base}/terminals?view=canvas`);
    const panel = p.getByRole("region", { name: "While you were away" });
    await panel.getByText("1h", { exact: false }).waitFor();
    await panel.getByText("The export works and its test passes.").waitFor();
    await panel.getByText("edited 2 files").waitFor();
    await panel.getByText("committed “feat: export”").waitFor();
    if (process.env.E2E_PROOFS) await p.screenshot({ path: join(process.env.E2E_PROOFS, "away.png") });
    await panel.getByRole("button", { name: /Export button/ }).click();
    await until("charlie at 100%", async () => /scale\(1\)/.test(await p.locator(".react-flow__viewport").getAttribute("style")) && (await p.locator(`.react-flow__node.selected [data-card="${globalThis.charlie}"]`).count()) === 1);
    await panel.getByRole("button", { name: "Got it" }).click();
    await panel.waitFor({ state: "detached" });
    await p.close();
    // the Recap button asks the real server, which has nothing to tell for these shells
    await page.getByRole("button", { name: "Recap" }).click();
    await page.getByText("Nothing happened on this workspace in that time.").waitFor();
    await page.getByRole("button", { name: "Got it" }).click();
  });

  await step("a line let go over empty canvas, or a card's +, opens a terminal beside it, in its folder and linked", async () => {
    const termCards = async () => (await api("GET", "/canvas")).flatMap((c) => c.nodes.filter((n) => n.kind === "term").map((n) => ({ ...n, canvas: c })));
    const from = (await termCards()).find((n) => n.ref === globalThis.charlie);
    const before = new Set((await termCards()).map((n) => n.ref));
    await page.goto(`${base}/terminals?view=canvas&id=${globalThis.charlie}`);
    await page.waitForSelector(`[data-card="${globalThis.charlie}"] .xterm-rows`);
    await page.locator(".react-flow__controls-zoomout").click();
    await page.locator(".react-flow__controls-zoomout").click();
    await page.waitForTimeout(400);
    // from charlie's right dot to empty canvas under every card
    const dot = await page.locator(`.react-flow__node:has([data-card="${globalThis.charlie}"]) .react-flow__handle-right`).boundingBox();
    const pane = await page.locator(".react-flow__pane").boundingBox();
    const bottom = await page.evaluate(() => Math.max(...[...document.querySelectorAll(".react-flow__node")].map((n) => n.getBoundingClientRect().bottom)));
    const drop = { x: dot.x + 120, y: Math.min(bottom + 60, pane.y + pane.height - 30) };
    await page.mouse.move(dot.x + dot.width / 2, dot.y + dot.height / 2);
    await page.mouse.down();
    await page.mouse.move(drop.x, drop.y, { steps: 10 });
    await page.mouse.up();
    await page.getByRole("menu").getByRole("menuitem", { name: /New shell/ }).click();
    const made = await until("a new shell", async () => (await termCards()).find((n) => !before.has(n.ref)), 15_000);
    const terms = await api("GET", "/code/terms");
    expect(terms.find((t) => t.id === made.ref)?.cwd === terms.find((t) => t.id === globalThis.charlie)?.cwd, "it didn't open in charlie's folder");
    await until("linked to charlie", async () => (await api("GET", "/canvas")).flatMap((c) => c.edges).some((e) => (e.source === from.id && e.target === made.id) || (e.target === from.id && e.source === made.id)));
    // and from that one's +, another beside it
    await page.waitForSelector(`[data-card="${made.ref}"]`);
    await page.locator(`[data-card="${made.ref}"]`).getByRole("button", { name: "New linked terminal" }).click();
    await page.getByRole("menu").getByRole("menuitem", { name: /New shell/ }).click();
    const next = await until("another", async () => (await termCards()).find((n) => !before.has(n.ref) && n.ref !== made.ref), 15_000);
    expect(Math.abs(next.y - made.y) < 1 && next.x > made.x, "it isn't beside the one it came from");
    await until("linked to it", async () => (await api("GET", "/canvas")).flatMap((c) => c.edges).some((e) => e.source === made.id && e.target === next.id));
  });

  const allNodes = async () => (await api("GET", "/canvas")).flatMap((c) => c.nodes);
  let runsCard;
  await step("a runs card linked to a terminal shows its runs as they happen, opens a failing one and turns red", async () => {
    const charlie = globalThis.charlie;
    await page.goto(`${base}/terminals?view=canvas&id=${charlie}`);
    await page.waitForSelector(`[data-card="${charlie}"] .xterm-rows`);
    await page.locator(`[data-card="${charlie}"]`).getByRole("button", { name: "New linked terminal" }).click();
    await page.getByRole("menu").getByRole("menuitem", { name: /Runs card/ }).click();
    runsCard = await until("a runs card", async () => (await allNodes()).find((n) => n.kind === "runs"));
    const from = (await allNodes()).find((n) => n.kind === "term" && n.ref === charlie);
    expect((await api("GET", "/canvas")).flatMap((c) => c.edges).some((e) => e.source === from.id && e.target === runsCard.id), "it isn't linked to charlie");
    const card = page.locator(`[data-runs="${runsCard.id}"]`);
    await card.getByText(/No runs yet/).waitFor();
    // a failing test run in that terminal, as cockpit records one
    await api("POST", "/runs", { finished: true, command: "pnpm test", name: "unit tests", status: "fail", exitCode: 1, output: "FAIL src/sum.test.ts > adds two numbers\n Tests  1 failed | 4 passed (5)", meta: { terminal: charlie } });
    await card.getByText("1 failing").waitFor();
    // opened by itself, with what failed
    await card.getByText("src/sum.test.ts > adds two numbers", { exact: false }).first().waitFor();
    expect((await card.getAttribute("data-tone")) === "fail", "the card isn't red");
    await page.locator(".canvas-map .react-flow__minimap-node.map-fail").first().waitFor({ state: "attached" });
    // another terminal's run isn't one of its own
    await api("POST", "/runs", { finished: true, command: "pnpm lint", name: "lint elsewhere", status: "fail", exitCode: 1, meta: { terminal: "someone-else" } });
    // fixed: the same command passes, and stays one row with the failure before it as a dot
    await api("POST", "/runs", { finished: true, command: "pnpm test", name: "unit tests", status: "pass", exitCode: 0, output: "Tests  5 passed (5)", meta: { terminal: charlie } });
    await card.getByText("1 passing").waitFor();
    await until("green", async () => (await card.getAttribute("data-tone")) === "pass");
    expect((await card.locator("[data-run]").count()) === 1, "the two runs of one command aren't one row");
    expect(!(await card.getByText("lint elsewhere").count()), "it shows another terminal's run");
    // Claude words and runs the same check another way each time: a later lint passing still fixes the failed one
    const at = Date.now() - 30_000;
    await api("POST", "/runs", { finished: true, kind: "lint", command: "pnpm run lint:all", name: "Run full lint to find any errors", status: "fail", exitCode: 1, startedAt: at, meta: { terminal: charlie } });
    await card.getByText("1 failing").waitFor();
    await api("POST", "/runs", { finished: true, kind: "lint", command: "npx eslint src/a.ts", name: "Run eslint on the changed files", status: "pass", exitCode: 0, meta: { terminal: charlie } });
    // one lint row, now passing, with the failure under it as fixed
    await until("one lint row", async () => (await card.locator('[data-run]', { hasText: "lint" }).count()) === 1);
    await until("nothing failing", async () => !(await card.getByText(/^\d+ failing$/).count()));
    // the lint row opened by itself when it failed, and stays open now it passes: the failure is under it, fixed
    await card.locator('[data-earlier][data-status="fixed"]', { hasText: "Run full lint" }).waitFor();
    await card.locator("[data-run]", { hasText: "Run eslint on the changed files" }).locator("> button").click();
    // and one you don't need can be hidden, and brought back
    await api("POST", "/runs", { finished: true, kind: "audit", command: "pnpm audit", name: "audit", status: "fail", exitCode: 1, meta: { terminal: charlie } });
    await card.getByText("1 failing").waitFor();
    // the count filters to what's failing, and back
    await card.getByRole("button", { name: "1 failing" }).click();
    expect((await card.locator("[data-run]").count()) === 1, "it doesn't show only the failing one");
    await card.getByRole("button", { name: "1 failing" }).click();
    expect((await card.locator("[data-run]").count()) > 1, "it doesn't show them all again");
    await card.getByRole("button", { name: "Hide" }).click();
    await card.locator('[data-run][data-status="dismissed"]').waitFor();
    await until("nothing failing", async () => !(await card.getByText(/^\d+ failing$/).count()));
    await card.getByRole("button", { name: "Show it again" }).click();
    await card.getByText("1 failing").waitFor();
    await card.getByRole("button", { name: "Hide" }).click();
    await until("hidden again", async () => !(await card.getByText(/^\d+ failing$/).count()));
    // the open row closed again, so the card is back to just its rows
    await card.locator('[data-run][data-status="dismissed"] > button').click();
    await page.locator(".canvas-map .react-flow__minimap-node.map-pass").first().waitFor({ state: "attached" });
    await card.locator(".card-handle").dblclick();
    await page.waitForTimeout(400);
  });

  await step("a recording run's screen shows beside its runs card while it runs, and goes when it ends", async () => {
    const charlie = globalThis.charlie;
    // the screen a plugin would serve for a simulator: any picture, made up here
    const frame = await page.screenshot({ clip: { x: 0, y: 0, width: 60, height: 100 }, type: "jpeg" });
    await page.route(/\/api\/e2e-sim\/frame/, (r) => r.fulfill({ body: frame, contentType: "image/jpeg" }));
    const run = await api("POST", "/runs", { kind: "e2e", name: "checkout flow on the simulator", command: "maestro test checkout.yaml", meta: { terminal: charlie, liveUrl: "/api/e2e-sim/frame", video: true } });
    const screen = page.locator(`[data-screen="${run.id}"]`);
    await screen.waitFor({ timeout: 15_000 });
    await screen.getByText("Recording").waitFor();
    await until("the picture", async () => !(await screen.getByText("Waiting for the screen").count()), 10_000);
    // the card goes once the run ends, so the proof is taken while it's up
    if (process.env.E2E_PROOFS) await page.screenshot({ path: join(process.env.E2E_PROOFS, "screen card while it records.png") });
    // beside the runs card, and linked to it
    const rc = await page.locator(`.react-flow__node:has([data-runs="${runsCard.id}"])`).boundingBox();
    const sc = await page.locator(`.react-flow__node:has([data-screen="${run.id}"])`).boundingBox();
    expect(Math.abs(sc.y - rc.y) < 2 && (sc.x > rc.x + rc.width || sc.x + sc.width < rc.x), "it isn't beside the runs card");
    await page.locator(".react-flow__edge").filter({ has: page.locator(".canvas-link-watch") }).first().waitFor({ state: "attached" });
    await api("POST", `/runs/${run.id}/event`, { phase: "done" });
    await screen.waitFor({ state: "detached", timeout: 15_000 });
    await page.unroute(/\/api\/e2e-sim\/frame/);
  });

  await step("a card that isn't a terminal fits what it shows, until you size it yourself", async () => {
    const mine = async () => (await allNodes()).find((n) => n.id === runsCard.id);
    // one row and a header, nowhere near its 320 to start with
    const fitted = await until("its height follows its rows", async () => {
      const n = await mine();
      return n.fit && n.h < 200 && n;
    });
    const card = page.locator(`[data-runs="${runsCard.id}"]`);
    await card.locator(".card-handle").click();
    const corner = await page.locator(`.react-flow__node:has([data-runs="${runsCard.id}"]) .react-flow__resize-control.handle.bottom.right`).boundingBox();
    await page.mouse.move(corner.x + corner.width / 2, corner.y + corner.height / 2);
    await page.mouse.down();
    await page.mouse.move(corner.x + corner.width / 2, corner.y + 160, { steps: 8 });
    await page.mouse.up();
    const sized = await until("sized by hand", async () => {
      const n = await mine();
      return n.fit === false && n.h > fitted.h + 60 && n;
    });
    // the box keeps the height you gave it
    await page.waitForTimeout(300);
    const box = await card.boundingBox();
    const zoom = await page.evaluate(() => Number(getComputedStyle(document.querySelector(".react-flow__viewport")).transform.split(",")[3]) || 1);
    expect(Math.abs(box.height / zoom - sized.h) < 6, `it's ${box.height / zoom} high, not the ${sized.h} it was given`);
    await card.getByRole("button", { name: "Fit its height to what it shows" }).click();
    await until("fits again", async () => {
      const n = await mine();
      return n.fit && Math.abs(n.h - fitted.h) < 12;
    });
  });

  await step("the map colours each card by how it's doing, and m hides it", async () => {
    await page.locator(".canvas-map").waitFor({ state: "attached" });
    await page.getByLabel("Map colours").waitFor({ state: "attached" });
    // out of any terminal, on empty canvas under the cards, so the key goes to the canvas
    const pane = await page.locator(".react-flow__pane").boundingBox();
    await page.mouse.click(pane.x + pane.width / 2, pane.y + pane.height - 30);
    await page.keyboard.press("m");
    await page.locator(".canvas-map").waitFor({ state: "detached" });
    await page.reload();
    await page.waitForSelector(".react-flow__node");
    expect(!(await page.locator(".canvas-map").count()), "the map came back after a reload");
    await page.getByRole("button", { name: "Map", exact: true }).click();
    await page.locator(".canvas-map").waitFor({ state: "attached" });
  });

  await step("each workspace opens where you left it, also after a link to one terminal", async () => {
    const charlie = globalThis.charlie;
    const side = await api("POST", "/canvas", { name: "Side" });
    await api("POST", `/canvas/${side.id}/notes`, { x: 0, y: 0, text: "# Side" });
    // opened the way a session card at the top opens it: on one terminal, which stays in the address
    await page.goto(`${base}/terminals?view=canvas&id=${charlie}`);
    await page.waitForSelector(`[data-card="${charlie}"] .xterm-rows`);
    await page.waitForTimeout(500);
    const view = () => page.evaluate(() => getComputedStyle(document.querySelector(".react-flow__viewport")).transform);
    const pan = async (dx, dy) => {
      const pane = await page.locator(".react-flow__pane").boundingBox();
      const x = pane.x + pane.width / 2;
      const y = pane.y + pane.height - 20;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + dx, y + dy, { steps: 6 });
      await page.mouse.up();
      await page.waitForTimeout(300);
    };
    await pan(-150, -60);
    const main = await view();
    await page.getByRole("tab", { name: /Side/ }).click();
    await page.locator("[data-note]").first().waitFor();
    await page.waitForTimeout(300);
    await pan(120, 40);
    const there = await view();
    expect(there !== main, "Side opened where Main was");
    await page.getByRole("tab", { name: /Main/ }).click();
    await page.waitForTimeout(400);
    expect((await view()) === main, `Main is at ${await view()}, not where it was left (${main})`);
    await page.getByRole("tab", { name: /Side/ }).click();
    await page.waitForTimeout(400);
    expect((await view()) === there, `Side is at ${await view()}, not where it was left (${there})`);
    await page.getByRole("tab", { name: /Main/ }).click();
  });

  await step("a card at the top brings its terminal up on the canvas, every time, and Settings picks the view", async () => {
    const charlie = globalThis.charlie;
    await page.goto(`${base}/terminals`);
    // the canvas is what opens when nothing says otherwise
    await page.waitForSelector('[data-testid="canvas"]');
    const top = page.locator(`[data-term="${charlie}"] > button`).first();
    const onScreen = async () => {
      const pane = await page.locator(".react-flow__pane").boundingBox();
      const c = await page.locator(`[data-card="${charlie}"]`).boundingBox();
      return !!c && c.x >= pane.x - 2 && c.x + c.width <= pane.x + pane.width + 2 && c.y >= pane.y - 2;
    };
    const away = async () => {
      await page.locator(".react-flow__controls-zoomout").click();
      const pane = await page.locator(".react-flow__pane").boundingBox();
      await page.mouse.move(pane.x + pane.width / 2, pane.y + pane.height - 15);
      await page.mouse.down();
      await page.mouse.move(pane.x + 40, pane.y + 40, { steps: 6 });
      await page.mouse.up();
      await page.waitForTimeout(300);
    };
    for (const time of ["first", "second"]) {
      await away();
      await top.click();
      await until(`charlie in view the ${time} time`, onScreen, 5000);
    }
    // the strip marks the terminal selected on the canvas
    await until("marked at the top", async () => /ring-cobalt/.test((await top.getAttribute("class")) ?? ""), 5000);
    // on a small window it's fitted with room around it, not filling the screen at 100%
    await page.setViewportSize({ width: 1100, height: 720 });
    await page.waitForTimeout(300);
    await away();
    await top.click();
    await page.waitForTimeout(500);
    const pane = await page.locator(".react-flow__pane").boundingBox();
    const box = await page.locator(`[data-card="${charlie}"]`).boundingBox();
    const room = Math.min(box.x - pane.x, pane.x + pane.width - (box.x + box.width), box.y - pane.y, pane.y + pane.height - (box.y + box.height));
    expect(room >= 30, `only ${Math.round(room)}px of room around it`);
    await page.setViewportSize({ width: 1600, height: 1000 });
    // tabs, from Settings, on this device
    await page.goto(`${base}/settings`);
    await page.getByRole("heading", { name: "Terminals" }).waitFor();
    await page.locator("section", { has: page.getByRole("heading", { name: "Terminals" }) }).getByRole("button", { name: "Tabs", exact: true }).click();
    await page.goto(`${base}/terminals`);
    await page.getByTitle(/New terminal:/).first().waitFor();
    expect(!(await page.locator('[data-testid="canvas"]').count()), "it still opens on the canvas");
    await page.goto(`${base}/settings`);
    await page.locator("section", { has: page.getByRole("heading", { name: "Terminals" }) }).getByRole("button", { name: "Canvas", exact: true }).click();
    await page.goto(`${base}/terminals`);
    await page.waitForSelector('[data-testid="canvas"]');
  });

  await step("a pull request review opens on its own Reviews workspace", async () => {
    // what the PR reviews screen opens, without going to the code host for the PR
    const r = await shell("review #4242");
    cleanup.push(() => api("DELETE", `/code/terms/${r.id}`).catch(() => {}));
    await until("its card", async () => await canvasOf(r.id));
    expect((await canvasOf(r.id)).name === "Reviews", `the review is on ${(await canvasOf(r.id)).name}`);
    await page.goto(`${base}/terminals?view=canvas&id=${r.id}`);
    await page.waitForSelector(`[data-card="${r.id}"] .xterm-rows`);
    expect((await page.getByRole("tab", { name: /Reviews/ }).getAttribute("aria-selected")) === "true", "Reviews isn't the open workspace");
    // a shell opened after it still goes on the first one
    const s = await shell("not a review");
    cleanup.push(() => api("DELETE", `/code/terms/${s.id}`).catch(() => {}));
    await until("its card", async () => await canvasOf(s.id));
    expect((await canvasOf(s.id)).name === "Main", `the shell is on ${(await canvasOf(s.id)).name}`);
  });

  await step("a terminal's runs card shows a run filed under the folder it's in, as a recording script files one", async () => {
    const charlie = globalThis.charlie;
    const cwd = (await api("GET", "/code/terms")).find((t) => t.id === charlie).cwd;
    await page.goto(`${base}/terminals?view=canvas&id=${charlie}`);
    const card = page.locator(`[data-runs="${runsCard.id}"]`);
    await card.waitFor();
    // no terminal or session on it, only where it ran
    await api("POST", "/runs", { finished: true, kind: "proof", name: "view-standing-orders proof", command: "pnpm run e2e flows/x.yaml", status: "pass", exitCode: 0, worktree: cwd });
    await card.getByText("view-standing-orders proof").waitFor();
  });

  await step("no errors on the page", async () => expect(!errors.length, errors.join(" | ")));
} catch (e) {
  results.push(`FAIL setup: ${e instanceof Error ? e.message : e}`);
} finally {
  await browser?.close();
  cockpit.stop();
  for (const fn of cleanup) fn();
}
finish();
