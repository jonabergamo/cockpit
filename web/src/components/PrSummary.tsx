import { useQueries } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Run, RunDetail, RunKind } from "@cockpit/shared";
import { api } from "../lib/api";
import { useSaveSettings, useSettings } from "../lib/cost";
import { duration } from "../lib/format";
import { useRuns } from "../lib/queries";
import { collapse, rowStatus, type RunRow } from "../lib/runGroups";
import { Button, ErrorNote, Loading, Modal } from "./ui";

// An image of a ticket's checks for its PR: the latest run of each thing it ran (E2E flows, tests, lint, types,
// audit, verify) and its newest commit's CI, the ones that passed ticked to start with. Drawn on a canvas, so it
// pastes into GitHub as a picture.

const LABEL: Partial<Record<RunKind, string>> = { unit: "Tests", lint: "Lint", typecheck: "Typecheck", audit: "Audit", e2e: "E2E", proof: "E2E", verify: "Verify", ci: "CI" };
// what a reviewer reads first: the flows, then the checks
const ORDER: RunKind[] = ["proof", "e2e", "unit", "typecheck", "lint", "audit", "verify", "ci"];

interface Line {
  key: string;
  kind: RunKind;
  name: string;
  ok: boolean;
  // worth showing a reviewer: ticked to start with when it passed
  worth: boolean;
  detail: string;
  // the second line: what it ran and when
  more: string[];
  took: number;
  at: number;
}

const when = (t: number) => new Date(t).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

// how long the tests ran: a recording says, so its convert and render after the run don't count
const ranFor = (r: Run) => (typeof r.meta.ranMs === "number" ? r.meta.ranMs : (r.endedAt ?? r.startedAt) - r.startedAt);

// the command as a reader wants it: no "cd somewhere &&" first, nothing piped after, no folders in front of a script
function shortCommand(cmd?: string) {
  if (!cmd) return "";
  const first = cmd.split(/\n/)[0];
  const parts = first.split(/\s*(?:&&|;)\s*/).filter((p) => p && !/^cd\s/.test(p));
  const main = (parts.find((p) => /\b(pnpm|npm|yarn|bun|npx|jest|vitest|pytest|maestro|tsc|eslint|playwright)\b/.test(p)) ?? parts[0] ?? first).split(/\s+\|\s+|\s+2>&1/)[0];
  const tidy = main.replace(/(^|\s)(?:~|\/)[^\s]*\/([^\s/]+)/g, "$1$2").trim();
  return tidy.length > 70 ? `${tidy.slice(0, 69)}…` : tidy;
}

function lineOf(row: RunRow, ticket: string): Line | undefined {
  if (row.type === "ci") {
    const failed = row.checks.filter((r) => r.status === "fail").length;
    const passed = row.checks.filter((r) => r.status === "pass").length;
    const took = Math.max(...row.checks.map((r) => (r.endedAt ?? r.startedAt) - r.startedAt));
    const bad = row.checks.filter((r) => r.status === "fail").map((r) => r.name);
    const flows = [...new Set(row.checks.map((r) => (typeof r.meta.workflow === "string" ? r.meta.workflow.replace(/^[\d.\s]*\W*\s*/u, "") : "")).filter(Boolean))];
    const more = [bad.length ? `failed: ${bad.join(", ")}` : flows.length ? `${flows.length} workflows: ${flows.slice(0, 3).join(", ")}${flows.length > 3 ? "…" : ""}` : "", when(row.latest.startedAt)].filter(Boolean);
    return { key: `ci:${row.sha}`, kind: "ci", name: `${row.checks.length} checks on ${row.sha.slice(0, 7)}${row.pr ? `, PR #${row.pr}` : ""}`, ok: rowStatus(row) === "pass", worth: true, detail: [passed && `${passed} passed`, failed && `${failed} failed`].filter(Boolean).join(", "), more, took, at: row.latest.startedAt };
  }
  const r: Run = row.run;
  if (r.kind === "other" || r.status === "running") return;
  const { passed, failed, skipped } = r.summary;
  const counts = [passed !== undefined && `${passed} passed`, failed && `${failed} failed`, skipped && `${skipped} skipped`].filter(Boolean).join(", ");
  // a recording's name is <ticket>-<flow>; the ticket is already the title
  const name = r.name.startsWith(`${ticket}-`) ? r.name.slice(ticket.length + 1) : r.name;
  // what Claude ran on its own counts when it reported results; a command it only looked around with doesn't
  const worth = r.source !== "hook" || passed !== undefined || failed !== undefined;
  const flow = r.command?.match(/flows\/[\w./-]+\.ya?ml/)?.[0];
  const what = r.kind === "proof" || r.kind === "e2e" ? (flow ?? shortCommand(r.command)) : shortCommand(r.command);
  const more = [
    what,
    r.summary.failing?.length ? `failing: ${r.summary.failing.slice(0, 3).join(", ")}${r.summary.failing.length > 3 ? "…" : ""}` : "",
    when(r.startedAt),
  ].filter(Boolean);
  return { key: r.id, kind: r.kind, name, ok: r.status === "pass", worth, detail: counts, more, took: ranFor(r), at: r.startedAt };
}

// a slim card like an alert, one line a check, at twice the size it shows so it stays sharp on GitHub
function draw(canvas: HTMLCanvasElement, ticket: string, lines: Line[], sub: string, credit: boolean) {
  const W = 760, row = 26, top = 44, bottom = 10, pad = 16;
  const H = top + Math.max(1, lines.length) * row + bottom;
  const s = 2;
  canvas.width = W * s;
  canvas.height = H * s;
  canvas.style.width = `${W}px`;
  const c = canvas.getContext("2d")!;
  c.scale(s, s);
  const font = (w: number, px: number) => `${w} ${px}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`;
  const fit = (text: string, max: number) => {
    let t = text;
    while (c.measureText(t).width > max && t.length > 4) t = `${t.slice(0, -2)}…`;
    return c.measureText(t).width > max ? "" : t;
  };
  const passed = lines.filter((l) => l.ok).length;
  const good = passed === lines.length;
  const tone = good ? { bg: "#f0fbf3", line: "#b7e4c7", ink: "#1a7f37" } : { bg: "#fff5f5", line: "#f5c2c0", ink: "#cf222e" };
  c.fillStyle = tone.bg;
  c.beginPath();
  c.roundRect(0.5, 0.5, W - 1, H - 1, 8);
  c.fill();
  c.strokeStyle = tone.line;
  c.lineWidth = 1;
  c.stroke();
  // the alert's edge
  c.fillStyle = tone.ink;
  c.beginPath();
  c.roundRect(0.5, 0.5, 4, H - 1, [8, 0, 0, 8]);
  c.fill();

  // one line on top: the result, then when and how long
  c.font = font(700, 15);
  c.fillStyle = tone.ink;
  const head = `${good ? "✓" : "✗"} ${ticket}`;
  c.fillText(head, pad + 4, 27);
  let x = pad + 4 + c.measureText(head).width + 8;
  c.fillStyle = "#1f2328";
  c.font = font(600, 14);
  const result = `${passed}/${lines.length} checks passed`;
  c.fillText(result, x, 27);
  x += c.measureText(result).width + 12;
  const total = lines.reduce((n, l) => n + l.took, 0);
  c.fillStyle = "#59636e";
  c.font = font(400, 12);
  c.textAlign = "right";
  c.fillText(fit(`${sub} · ${duration(total) || "0s"} of runs${credit ? " · recorded by cockpit" : ""}`, W - pad - x), W - pad, 27);
  c.textAlign = "left";

  lines.forEach((l, i) => {
    const y = top + i * row + 17;
    if (i === 0) {
      c.fillStyle = tone.line;
      c.fillRect(pad + 4, top - 4, W - 2 * pad - 4, 1);
    }
    c.fillStyle = l.ok ? "#1a7f37" : "#cf222e";
    c.font = font(700, 13);
    c.fillText(l.ok ? "✓" : "✗", pad + 4, y);
    c.fillStyle = "#59636e";
    c.font = font(600, 10.5);
    c.fillText((LABEL[l.kind] ?? l.kind).toUpperCase(), pad + 24, y - 1);
    // right side: the counts, then how long
    c.textAlign = "right";
    c.font = font(400, 12);
    c.fillText(duration(l.took) || "–", W - pad, y);
    const detailRight = W - pad - 52;
    c.fillText(l.detail, detailRight, y);
    const detailW = l.detail ? c.measureText(l.detail).width + 16 : 0;
    c.textAlign = "left";
    // the name, and what it ran and when after it, in what room is left
    const nameX = pad + 100;
    const room = detailRight - detailW - nameX;
    c.fillStyle = "#1f2328";
    c.font = font(500, 13);
    const name = fit(l.name, Math.min(room, 300));
    c.fillText(name, nameX, y);
    const after = nameX + c.measureText(name).width + 10;
    c.fillStyle = "#6e7781";
    c.font = font(400, 11.5);
    c.fillText(fit(l.more.join(" · "), detailRight - detailW - after), after, y);
  });
}

export function PrSummary({ ticket, open, onClose }: { ticket: string; open: boolean; onClose: () => void }) {
  const runs = useRuns({ ticket, limit: 500 });
  const lines = useMemo(() => {
    const rows = collapse(runs.data ?? []);
    // the newest commit's CI only: older commits' checks say nothing about what's in the PR now
    const ci = rows.find((r) => r.type === "ci");
    return rows
      .filter((r) => r.type !== "ci" || r === ci)
      .map((r) => lineOf(r, ticket))
      .filter((l): l is Line => !!l)
      .sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || a.name.localeCompare(b.name))
      // a flow that has a proof says it twice as a plain E2E run
      .map((l, _, all) => (l.kind === "e2e" && all.some((x) => x.kind === "proof" && x.ok && x.name === l.name) ? { ...l, worth: false } : l));
  }, [runs.data, ticket]);
  // a flow's steps are on its own page, so the picked ones are read for how many passed
  const flowIds = lines.filter((l) => l.kind === "proof" || l.kind === "e2e").map((l) => l.key);
  const details = useQueries({ queries: flowIds.map((id) => ({ queryKey: ["run", id], queryFn: () => api.get<RunDetail>(`/runs/${id}`), staleTime: 60_000 })) });
  const stepsOf = new Map(
    details.flatMap((q) => {
      const d = q.data;
      if (!d) return [];
      const steps = d.steps.filter((x) => x.state !== "section" && x.state !== "skipped");
      const ok = steps.filter((x) => x.state === "ok" || (d.status === "pass" && x.state === "running")).length;
      return steps.length ? [[d.id, `${ok}/${steps.length} passed`] as const] : [];
    }),
  );
  const full = lines.map((l) => (stepsOf.has(l.key) && !l.detail ? { ...l, detail: stepsOf.get(l.key)! } : l));
  const [picked, setPicked] = useState<Set<string>>(new Set());
  // ticked afresh only when the rows themselves change, not on every refetch while you pick
  const keys = lines.map((l) => `${l.key}:${l.ok}:${l.worth}`).join();
  useEffect(() => setPicked(new Set(lines.filter((l) => l.ok && l.worth).map((l) => l.key))), [keys]); // eslint-disable-line react-hooks/exhaustive-deps
  const canvas = useRef<HTMLCanvasElement>(null);
  // saved with the other settings, so it holds on every device
  const settings = useSettings();
  const saveSettings = useSaveSettings();
  const runsSettings = (settings.data?.settings as { runs?: Record<string, unknown> } | undefined)?.runs;
  const credit = runsSettings?.imageCredit !== false;
  const setCredit = (on: boolean) => saveSettings({ runs: { ...runsSettings, imageCredit: on } } as never).catch(setErr);
  const shown = full.filter((l) => picked.has(l.key));
  const sub = `Latest run of each, ${new Date().toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}`;
  useEffect(() => {
    if (open && canvas.current) draw(canvas.current, ticket, shown, sub, credit);
  });
  const [said, setSaid] = useState("");
  const [err, setErr] = useState<unknown>();
  const blob = () => new Promise<Blob>((done, fail) => canvas.current!.toBlob((b) => (b ? done(b) : fail(new Error("couldn't draw the image"))), "image/png"));
  const copyImage = async () => {
    setErr(undefined);
    try {
      // the clipboard takes images only on https or localhost
      if (!window.isSecureContext || !navigator.clipboard?.write) throw new Error("This browser only copies images on https or localhost. Download it instead.");
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob() })]);
      setSaid("Copied, paste it into the PR");
    } catch (e) {
      setErr(e);
    }
  };
  const download = async () => {
    setErr(undefined);
    try {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(await blob());
      a.download = `${ticket}-checks.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch (e) {
      setErr(e);
    }
  };
  const toggle = (key: string) =>
    setPicked((old) => {
      const next = new Set(old);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  return (
    <Modal open={open} onClose={onClose} title={`An image of ${ticket}'s checks, for its PR`} wide>
      {runs.isLoading && <Loading what="Reading its runs" />}
      <ErrorNote error={runs.error ?? err} />
      {runs.data && !lines.length && <p className="text-[13px] text-muted">{ticket} has no finished runs to show yet.</p>}
      {!!lines.length && (
        <div className="space-y-3">
          <p className="text-[13px] text-muted">The latest run of each thing {ticket} ran, and its newest commit's CI. Untick what the PR doesn't need.</p>
          <div className="max-h-[220px] overflow-y-auto border border-line rounded-md divide-y divide-line">
            {lines.map((l) => (
              <label key={l.key} className="flex items-center gap-2 px-2.5 py-1.5 text-[13px] cursor-pointer hover:bg-ground">
                <input type="checkbox" checked={picked.has(l.key)} onChange={() => toggle(l.key)} />
                <span className={l.ok ? "text-green" : "text-red"}>{l.ok ? "✓" : "✗"}</span>
                <span className="text-faint w-20 shrink-0">{LABEL[l.kind] ?? l.kind}</span>
                <span className="flex-1 min-w-0 truncate">{l.name}</span>
                <span className="text-faint">{l.detail}</span>
                <span className="text-faint w-12 text-right tabular-nums">{duration(l.took)}</span>
              </label>
            ))}
          </div>
          <div className="overflow-x-auto">
            <canvas ref={canvas} className="max-w-full rounded-md" />
          </div>
          <div className="flex items-center gap-2">
            <Button variant="primary" onClick={copyImage} disabled={!shown.length}>
              Copy image
            </Button>
            <Button onClick={download} disabled={!shown.length}>
              Download PNG
            </Button>
            <label className="flex items-center gap-1.5 text-[13px] text-muted ml-2 cursor-pointer">
              <input type="checkbox" checked={!credit} onChange={(e) => setCredit(!e.target.checked)} disabled={!settings.data} />
              Hide "recorded by cockpit"
            </label>
            {said && <span className="text-[13px] text-green">{said}</span>}
          </div>
        </div>
      )}
    </Modal>
  );
}
