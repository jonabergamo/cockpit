// Takes the README screenshots and the short tour from demo mode, so they never show anyone's own data.
// Needs a build and ffmpeg with libwebp: `pnpm build && node scripts/screenshots.mjs`.
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const port = Number(process.env.SHOTS_PORT ?? 8797);
const base = `http://127.0.0.1:${port}`;
const repo = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const out = join(repo, "docs");
const data = mkdtempSync(join(tmpdir(), "cockpit-shots-"));
const tmp = mkdtempSync(join(tmpdir(), "cockpit-frames-"));

// A made-up repo for the terminal and its git panels, with the demo's tickets in its history
const fake = join(data, "acme");
const git = (...args) => execFileSync("git", ["-C", fake, ...args], { env: { ...process.env, ...author } });
let author = {};
execFileSync("git", ["init", "-q", "-b", "main", fake]);
const commits = [
  ["Alex Doe", 9 * 24, "chore: set up the storefront app", { "README.md": "# acme storefront\n", "package.json": '{ "name": "acme" }\n' }],
  ["Sam Rivera", 7 * 24, "feat: order history filters (ACME-401)", { "src/orders/filters.ts": "export const filters = [];\n" }],
  ["Alex Doe", 6 * 24, "fix: basket rounding on discounts (ACME-399)", { "src/basket/total.ts": "export const total = (n: number) => Math.round(n * 100) / 100;\n" }],
  ["Sam Rivera", 4 * 24, "feat: apple pay button on mobile web (ACME-405)", { "src/checkout/ApplePay.tsx": "export function ApplePay() {}\n" }],
  ["Alex Doe", 50, "feat: prefix index for product search (ACME-418)", { "src/search/index.ts": "export const index = new Map();\n" }],
  ["Alex Doe", 26, "test: search results under 300ms", { "src/search/index.test.ts": "test('fast', () => {});\n" }],
  ["Sam Rivera", 20, "fix: apple pay review comments", { "src/checkout/ApplePay.tsx": "export function ApplePay() {\n  return null;\n}\n" }],
  ["Alex Doe", 3, "feat: saved cards on the checkout page (ACME-412)", { "src/checkout/SavedCards.tsx": "export function SavedCards() {\n  return null;\n}\n" }],
];
for (const [name, hoursAgo, subject, files] of commits) {
  for (const [f, body] of Object.entries(files)) {
    execFileSync("mkdir", ["-p", join(fake, f, "..")]);
    writeFileSync(join(fake, f), body);
  }
  const date = new Date(Date.now() - hoursAgo * 3600_000).toISOString();
  author = { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: "dev@example.com", GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: "dev@example.com", GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
  git("add", "-A");
  git("commit", "-q", "-m", subject);
}
git("tag", "v1.4.0", "HEAD~3");
// work in progress, for the Changes panel
writeFileSync(join(fake, "src/checkout/SavedCards.tsx"), "export function SavedCards({ cards }: { cards: string[] }) {\n  return cards.length;\n}\n");
execFileSync("mkdir", ["-p", join(fake, "src/checkout/cards")]);
writeFileSync(join(fake, "src/checkout/cards/useCards.ts"), "export const useCards = () => [];\n");
writeFileSync(join(fake, "src/basket/total.ts"), "export const total = (n: number) => Math.round(n * 100) / 100; // in pence\n");

const config = join(data, "config.toml");
writeFileSync(config, readFileSync(join(repo, "config.example.toml"), "utf8").replace(/^path = .*$/m, `path = "${fake}"`).replace(/^name = "app"$/m, 'name = "acme"'));

const server = spawn("pnpm", ["--filter", "server", "start"], {
  env: { ...process.env, COCKPIT_DEMO: "1", COCKPIT_CONFIG: config, PORT: String(port), COCKPIT_DATA: data },
  stdio: "ignore",
  detached: true,
});

async function up() {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${base}/api/config`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("server didn't start");
}

const webp = (png, name) => execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", png, "-quality", "88", join(out, name)]);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// a plain shell, so the picture doesn't carry your prompt, hostname or banner
async function terminal(title) {
  const res = await fetch(`${base}/api/code/terms`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd: fake, title, command: "env", args: ["-i", `HOME=${data}`, "TERM=xterm-256color", "PATH=/usr/local/bin:/usr/bin:/bin", "PS1=\\[\\e[36m\\]~/code/acme\\[\\e[0m\\] \\[\\e[32m\\]❯\\[\\e[0m\\] ", "bash", "--norc", "--noprofile"] }),
  });
  return (await res.json()).id;
}

let browser;
try {
  await up();
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: "dark" });
  await context.addInitScript(() => localStorage.setItem("theme", "tokyo-night"));
  const page = await context.newPage();
  const shot = async (path, name, prep) => {
    await page.goto(base + path);
    await page.waitForLoadState("networkidle").catch(() => {});
    await wait(1500);
    if (prep) await prep();
    const png = join(tmp, `${name}.png`);
    await page.screenshot({ path: png });
    webp(png, `${name}.webp`);
    console.log("docs/" + name + ".webp");
  };

  await shot("/", "today");
  await shot("/sessions/d1", "session");
  await shot("/report", "report");
  await shot("/usage", "usage");

  const id = await terminal("shell");
  await shot(`/terminals?id=${id}`, "terminals", async () => {
    await page.keyboard.type("git log --oneline --decorate && git status -s\n", { delay: 5 });
    await wait(1200);
    await page.locator("aside button[title*='·']").nth(1).click();
    await wait(1200);
  });
  await shot("/settings", "settings");

  // a short tour for the top of the README, recorded as video and turned into an animated webp
  const rec = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: "dark", recordVideo: { dir: tmp, size: { width: 1280, height: 800 } } });
  await rec.addInitScript(() => localStorage.setItem("theme", "tokyo-night"));
  const tour = await rec.newPage();
  await tour.goto(base + "/");
  await wait(2500);
  await tour.goto(base + "/sessions/d1");
  await wait(2500);
  await tour.goto(base + "/tickets");
  await wait(2000);
  const tid = await terminal("shell");
  await tour.goto(`${base}/terminals?id=${tid}`);
  await wait(1500);
  await tour.keyboard.type("git status -s\n", { delay: 40 });
  await wait(1500);
  await tour.locator("aside button[title*='·']").nth(1).click();
  await wait(2000);
  await tour.goto(base + "/report");
  await wait(2500);
  await tour.keyboard.press("Meta+k").catch(() => {});
  await tour.keyboard.press("Control+k");
  await wait(600);
  await tour.keyboard.type("theme", { delay: 60 });
  await wait(1500);
  await tour.close();
  await rec.close();
  const video = readdirSync(tmp).find((f) => f.endsWith(".webm"));
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", join(tmp, video), "-vf", "fps=10,scale=1100:-1:flags=lanczos", "-loop", "0", "-quality", "80", "-compression_level", "3", "-c:v", "libwebp_anim", join(out, "tour.webp")]);
  console.log("docs/tour.webp");
} finally {
  await browser?.close();
  try {
    process.kill(-server.pid);
  } catch {}
  rmSync(data, { recursive: true, force: true });
  rmSync(tmp, { recursive: true, force: true });
}
