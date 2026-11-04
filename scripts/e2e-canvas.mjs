// End to end flows for the Terminals canvas: real shells on a cockpit of the script's own, driven in a browser.
// Needs tmux and a build: `pnpm build && pnpm e2e:canvas`. PLAYWRIGHT_CHROMIUM points at a browser of your own.
import { expect, openBrowser, startCockpit, steps, until } from "./e2e-lib.mjs";

const WORD = "QWERTYUIOPASDFGHJKLZXCVBNM";
const cockpit = await startCockpit({ port: Number(process.env.E2E_PORT ?? 8797), name: "canvas" });
const { base, api, shell } = cockpit;
const canvasOf = (term) => cockpit.canvasOf("term", term);
let page;
const { step, results, finish } = steps(() => page);

let browser;
const errors = [];
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

  await step("no errors on the page", async () => expect(!errors.length, errors.join(" | ")));
} catch (e) {
  results.push(`FAIL setup: ${e instanceof Error ? e.message : e}`);
} finally {
  await browser?.close();
  cockpit.stop();
}
finish();
