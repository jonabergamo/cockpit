import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Bar, BarChart, CartesianGrid, Cell, LabelList, Legend, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { BurnPoint, DayActivity, Sprint, StatusSpan, Ticket } from "@cockpit/shared";
import { Button, copy, ErrorNote, inputClass, Loading, PageHeader, StatusTag, statusTone, Tag } from "../components/ui";
import { api, qs } from "../lib/api";
import { ago, usd } from "../lib/format";
import { useCost, useSaveSettings, useSettings } from "../lib/cost";
import { useAgentName, useClaudeMain } from "../lib/agent";

interface Person {
  name: string;
  me: boolean;
  scope: number;
  done: number;
  tickets: number;
}

interface SprintReport {
  sprint: Sprint & { state: string };
  tickets: (Ticket & { spans: StatusSpan[]; costUSD?: number; addedLate: boolean })[];
  burnup: BurnPoint[];
  burndown: { date: string; ideal: number; remaining: number | null }[];
  distribution: { name: string; points: number; count: number }[];
  doneStatuses: string[];
  scope: "me" | "team";
  people: Person[];
  elapsedShare: number;
  totals: { scope: number; done: number; released: number; projected: number; daysLeft: number; daysTotal: number; lateScope?: number; byStatus: Record<string, number> };
  releasedStatuses: string[];
  statusOrder: string[];
}

// Recharts writes colours as SVG attributes, which can't read CSS variables, so resolve them.
export function useTokens() {
  const read = () => {
    const s = getComputedStyle(document.documentElement);
    const v = (n: string) => s.getPropertyValue(n).trim();
    return {
      ink: v("--ink"), muted: v("--muted"), faint: v("--faint"), line: v("--line"), cobalt: v("--cobalt"), panel: v("--panel"), raised: v("--raised"),
      green: v("--green"), amber: v("--amber"), red: v("--red"),
    };
  };
  const [t, setT] = useState(read);
  useEffect(() => {
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const update = () => setT(read());
    mq.addEventListener("change", update);
    const mo = new MutationObserver(update);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => {
      mq.removeEventListener("change", update);
      mo.disconnect();
    };
  }, []);
  return t;
}

const shortDate = (d: string) => new Date(`${d}T12:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" });

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="bg-panel border border-line rounded-lg px-4 py-3">
      <div className="text-[28px] font-semibold tracking-tight leading-none">{value}</div>
      <div className="text-[13px] text-muted mt-1.5">{label}</div>
      {note && <div className="text-[12px] text-faint">{note}</div>}
    </div>
  );
}

const tip = (t: ReturnType<typeof useTokens>) => ({ background: t.raised, border: `1px solid ${t.line}`, borderRadius: 6, color: t.ink, fontSize: 13 });
const ddmm = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;

function Burndown({ data }: { data: SprintReport["burndown"] }) {
  const t = useTokens();
  return (
    <div className="h-[300px]" role="img" aria-label="Story points remaining per day against the ideal guideline">
      <ResponsiveContainer>
        <LineChart data={data.map((d) => ({ ...d, label: ddmm(d.date) }))} margin={{ top: 8, right: 16, bottom: 0, left: -4 }}>
          <CartesianGrid stroke={t.line} vertical={false} />
          <XAxis dataKey="label" tick={{ fill: t.muted, fontSize: 12 }} axisLine={{ stroke: t.line }} tickLine={false} />
          <YAxis
            tick={{ fill: t.muted, fontSize: 12 }}
            axisLine={false}
            tickLine={false}
            allowDecimals={false}
            label={{ value: "Story points remaining", angle: -90, position: "insideLeft", offset: 14, fill: t.muted, fontSize: 12, style: { textAnchor: "middle" } }}
          />
          <Tooltip contentStyle={tip(t)} labelStyle={{ color: t.muted }} cursor={{ stroke: t.faint, strokeWidth: 1 }} formatter={(v, n) => [v === null ? "not yet" : `${v} pt`, n]} />
          <Legend wrapperStyle={{ fontSize: 13, color: t.muted }} iconType="plainline" verticalAlign="top" height={28} />
          <Line name="Ideal (guideline)" dataKey="ideal" stroke={t.faint} strokeWidth={2} strokeDasharray="6 4" dot={false} isAnimationActive={false} />
          <Line name="Actual" dataKey="remaining" stroke={t.cobalt} strokeWidth={2.5} dot={{ r: 4, fill: t.cobalt, stroke: t.panel, strokeWidth: 2 }} isAnimationActive={false} connectNulls={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

// status colours mean the same here as in the tags and lanes: done green, review amber, in progress blue
function bucketColor(name: string, t: ReturnType<typeof useTokens>) {
  const n = name.toLowerCase();
  if (/done/.test(n)) return t.green;
  if (/review|qa/.test(n)) return t.amber;
  if (/progress/.test(n)) return t.cobalt;
  if (/block|hold/.test(n)) return t.red;
  if (/to do/.test(n)) return t.muted;
  return t.line;
}

function Distribution({ data, note }: { data: SprintReport["distribution"]; note: string }) {
  const t = useTokens();
  const total = data.reduce((n, d) => n + d.points, 0) || 1;
  const rows = data.filter((d) => d.points > 0);
  return (
    <div className="flex flex-wrap items-center gap-4">
      <div className="h-[230px] w-[230px] shrink-0" role="img" aria-label="Story points by status">
        <ResponsiveContainer>
          <PieChart>
            <Pie data={rows} dataKey="points" nameKey="name" innerRadius={58} outerRadius={100} paddingAngle={1.5} stroke={t.panel} strokeWidth={2} isAnimationActive={false}>
              {rows.map((d) => (
                <Cell key={d.name} fill={bucketColor(d.name, t)} />
              ))}
            </Pie>
            <Tooltip contentStyle={tip(t)} formatter={(v, n) => [`${v} pt · ${Math.round((Number(v) / total) * 100)}%`, n]} />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <table className="text-[13px] flex-1 min-w-[200px]">
        <tbody>
          {data.map((d) => (
            <tr key={d.name}>
              <td className="py-1 pr-2">
                <span className="inline-block size-2.5 rounded-sm mr-2 align-middle" style={{ background: bucketColor(d.name, t) }} />
                {d.name}
              </td>
              <td className="text-right font-medium">{d.points}</td>
              <td className="text-right text-muted w-14">{Math.round((d.points / total) * 100)}%</td>
              <td className="text-right text-muted w-16">{d.count} {d.count === 1 ? "ticket" : "tickets"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-[12px] text-muted w-full">{note}</p>
    </div>
  );
}

const pct = (n: number, of: number) => (of ? Math.round((n / of) * 100) : 0);

// One bar per person: done share filled, with a tick where the even pace says they should be today.
function Pace({ people, ideal }: { people: Person[]; ideal: number }) {
  const team = people.reduce((a, p) => ({ scope: a.scope + p.scope, done: a.done + p.done }), { scope: 0, done: 0 });
  const rows = [{ name: "Whole team", me: false, ...team, tickets: 0, total: true }, ...people.map((p) => ({ ...p, total: false }))];
  return (
    <div className="space-y-2">
      {rows.map((p) => {
        const share = pct(p.done, p.scope);
        const gap = share - Math.round(ideal * 100);
        return (
          <div key={p.name} className="grid grid-cols-[200px_1fr_150px] items-center gap-3 text-[13px]">
            <span className={`truncate ${p.me ? "font-semibold text-cobalt" : p.total ? "font-semibold" : ""}`}>{p.me ? `${p.name} (you)` : p.name}</span>
            <div className="relative h-4 bg-ground rounded">
              <div className={`absolute inset-y-0 left-0 rounded ${p.me ? "bg-cobalt" : p.total ? "bg-ink/60" : "bg-faint"}`} style={{ width: `${Math.min(100, share)}%` }} />
              <div className="absolute top-[-3px] bottom-[-3px] w-0.5 bg-ink" style={{ left: `${ideal * 100}%` }} title="where the even pace is today" />
            </div>
            <span className="text-muted text-right whitespace-nowrap">
              {p.done} / {p.scope} pt · <span className={gap >= 0 ? "text-green" : "text-amber"}>{gap >= 0 ? `+${gap}` : gap}%</span>
            </span>
          </div>
        );
      })}
      <p className="text-[12px] text-muted pt-1">The black tick is the even pace for today ({Math.round(ideal * 100)}% of the sprint's workdays gone). The number on the right is how far ahead or behind it each person is.</p>
    </div>
  );
}

function SayDo({ scope }: { scope: "me" | "team" }) {
  const t = useTokens();
  const q = useQuery({ queryKey: ["saydo", scope], queryFn: () => api.get<{ id: number; name: string; active: boolean; committed: number; completed: number }[]>(`/report/saydo?scope=${scope}`) });
  if (q.isLoading) return <Loading what="Going through past sprints" />;
  if (!q.data) return <ErrorNote error={q.error} />;
  const rows = q.data.map((s) => ({ ...s, label: s.name.replace(/^.*?(\d+)$/, "Sprint $1") + (s.active ? " (now)" : ""), ratio: s.committed ? Math.round((s.completed / s.committed) * 100) : 0 }));
  const past = rows.filter((r) => !r.active);
  const avg = past.length ? Math.round(past.reduce((n, r) => n + r.ratio, 0) / past.length) : 0;
  return (
    <>
      <p className="text-[13px] text-muted mb-2">
        {past.length ? `${scope === "me" ? "You finish" : "The team finishes"} ${avg}% of what ${scope === "me" ? "you commit" : "it commits"} to, on average over the last ${past.length} sprints.` : "No finished sprints yet."} The current sprint counts what's done so far.
      </p>
      <div className="h-[260px]" role="img" aria-label="Committed and completed story points per sprint">
        <ResponsiveContainer>
          <BarChart data={rows} margin={{ top: 18, right: 8, bottom: 0, left: -12 }} barGap={3} barCategoryGap="22%">
            <CartesianGrid stroke={t.line} vertical={false} />
            <XAxis dataKey="label" tick={{ fill: t.muted, fontSize: 12 }} axisLine={{ stroke: t.line }} tickLine={false} />
            <YAxis tick={{ fill: t.muted, fontSize: 12 }} axisLine={false} tickLine={false} allowDecimals={false} />
            <Tooltip contentStyle={tip(t)} cursor={{ fill: t.line, opacity: 0.35 }} formatter={(v, n, p) => [`${v} pt${n === "Completed" ? ` · ${p.payload.ratio}%` : ""}`, n]} />
            <Legend wrapperStyle={{ fontSize: 13, color: t.muted }} verticalAlign="top" height={28} />
            <Bar name="Committed" dataKey="committed" fill={t.cobalt} radius={[4, 4, 0, 0]} isAnimationActive={false}>
              <LabelList dataKey="committed" position="top" fill={t.muted} fontSize={12} />
            </Bar>
            <Bar name="Completed" dataKey="completed" fill={t.green} radius={[4, 4, 0, 0]} isAnimationActive={false}>
              <LabelList dataKey="completed" position="top" fill={t.muted} fontSize={12} />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </>
  );
}

const spanColor: Record<string, string> = { faint: "var(--line)", cobalt: "var(--cobalt)", amber: "var(--amber)", green: "var(--green)", red: "var(--red)", plain: "var(--faint)" };

// One row per ticket, coloured by the status it was in over the sprint. Status names sit inside wide segments.
function StatusLanes({ report }: { report: SprintReport }) {
  const start = Date.parse(report.sprint.start!);
  const end = Math.max(Date.parse(report.sprint.end!), Date.now());
  const pct = (t: number) => Math.min(100, Math.max(0, ((t - start) / (end - start)) * 100));
  const now = pct(Date.now());
  const order = (s: string) => {
    const i = report.statusOrder.indexOf(s);
    return i === -1 ? 99 : i;
  };
  const tickets = [...report.tickets].sort((a, b) => order(b.status) - order(a.status) || a.key.localeCompare(b.key));

  return (
    <div className="space-y-1.5">
      {tickets.map((tk) => (
        <div key={tk.key} className="flex items-center gap-3">
          <Link to="/tickets" search={{ key: tk.key }} className="w-[260px] shrink-0 truncate text-[13px] hover:text-cobalt" title={tk.summary}>
            <span className="font-medium">{tk.key}</span> <span className="text-muted">{tk.summary}</span>
          </Link>
          <div className="relative flex-1 h-6 bg-ground rounded">
            {tk.spans.map((s, i) => {
              const from = pct(Date.parse(s.from));
              const to = pct(s.to ? Date.parse(s.to) : Date.now());
              const w = Math.max(to - from, 0.6);
              const tone = statusTone(s.status);
              const hours = Math.round(((s.to ? Date.parse(s.to) : Date.now()) - Date.parse(s.from)) / 36e5);
              return (
                <div
                  key={i}
                  title={`${s.status}, ${hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`} from ${new Date(s.from).toLocaleString()}`}
                  className="absolute top-0 bottom-0 rounded-[4px] overflow-hidden text-[11px] leading-6 px-1.5 whitespace-nowrap text-on-status"
                  style={{
                    left: `${from}%`,
                    width: `calc(${w}% - 2px)`,
                    background: tone === "red" ? `repeating-linear-gradient(45deg, var(--red) 0 6px, color-mix(in srgb, var(--red) 70%, black) 6px 9px)` : spanColor[tone],
                    color: tone === "faint" ? "var(--muted)" : undefined,
                  }}
                >
                  {w > 9 ? s.status : ""}
                </div>
              );
            })}
            <div className="absolute top-[-3px] bottom-[-3px] w-px bg-ink/50" style={{ left: `${now}%` }} title="now" />
          </div>
          {report.scope === "team" && <span className="w-28 truncate text-[12px] text-muted" title={tk.assignee}>{tk.assignee ?? "Unassigned"}</span>}
          <span className="w-12 text-right text-[12px] text-muted">{tk.points ?? "?"} pt</span>
          {tk.addedLate && <Tag tone="amber">added late</Tag>}
        </div>
      ))}
    </div>
  );
}

function CostChart({ days }: { days: DayActivity[] }) {
  const t = useTokens();
  const cost = useCost();
  const rows = [...days].reverse().map((d) => ({ label: shortDate(d.date), cost: d.costUSD, commits: d.commits.length }));
  return (
    <div className="h-[180px]" role="img" aria-label={`Claude ${cost.label} per day`}>
      <ResponsiveContainer>
        <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: -12 }} barCategoryGap={4}>
          <CartesianGrid stroke={t.line} vertical={false} />
          <XAxis dataKey="label" tick={{ fill: t.muted, fontSize: 11 }} axisLine={{ stroke: t.line }} tickLine={false} interval="preserveStartEnd" />
          <YAxis tick={{ fill: t.muted, fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={(v) => `$${v}`} />
          <Tooltip
            contentStyle={{ background: t.raised, border: `1px solid ${t.line}`, borderRadius: 6, color: t.ink, fontSize: 13 }}
            cursor={{ fill: t.line, opacity: 0.4 }}
            formatter={(v) => [usd(Number(v)), cost.label]}
          />
          <Bar dataKey="cost" fill={t.cobalt} radius={[4, 4, 0, 0]} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// Notes for people outside the team, written by Claude from everything the report has: every ticket with its
// status history, PRs, commits and sessions, day by day. It only runs when you press the button.
function AdditionalNotes({ sprintId }: { sprintId: number }) {
  const agent = useAgentName();
  const qc = useQueryClient();
  const settings = useSettings();
  const saveSettings = useSaveSettings();
  const notes = useQuery({ queryKey: ["notes", sprintId], queryFn: () => api.get<{ saved?: { text: string; at: number }; jobId?: string; defaultPrompt: string }>(`/report/notes${qs({ id: sprintId })}`) });
  const [jobId, setJobId] = useState<string>();
  const running = jobId ?? notes.data?.jobId;
  const job = useQuery({
    queryKey: ["job", running],
    queryFn: () => api.get<{ output: string; code?: number; startedAt: number }>(`/jobs/${running}`),
    enabled: !!running,
    refetchInterval: (q) => (q.state.data?.code === undefined ? 2000 : false),
  });
  const [text, setText] = useState("");
  const [copied, setCopied] = useState(false);
  const [showSetup, setShowSetup] = useState(false);
  const [prompt, setPrompt] = useState<string>();
  const brief = useQuery({ queryKey: ["notes-brief", sprintId], queryFn: () => api.get<string>(`/report/notes/brief${qs({ id: sprintId })}`), enabled: showSetup });

  useEffect(() => {
    if (notes.data?.saved) setText(notes.data.saved.text);
  }, [notes.data?.saved]);
  // once the run ends, pick up what it saved
  const done = job.data?.code !== undefined;
  useEffect(() => {
    if (!done) return;
    setJobId(undefined);
    qc.invalidateQueries({ queryKey: ["notes", sprintId] });
  }, [done, qc, sprintId]);

  const generate = useMutation({
    mutationFn: () => api.post<{ jobId: string }>("/report/notes", { id: sprintId }),
    onSuccess: (r) => setJobId(r.jobId),
  });
  const failed = job.data?.code !== undefined && job.data.code !== 0 ? new Error(job.data.output.slice(-500) || `${agent} stopped without writing anything`) : undefined;
  const custom = settings.data?.settings.notes.prompt ?? "";
  const maxChars = settings.data?.settings.notes.maxChars ?? 0;
  const liveBranch = settings.data?.settings.notes.liveBranch ?? "";
  const saveNotes = (patch: Partial<{ prompt: string; maxChars: number; liveBranch: string }>) => saveSettings({ notes: { prompt: custom, maxChars, liveBranch, ...patch } });
  const shownPrompt = prompt ?? (custom || notes.data?.defaultPrompt || "");
  const saved = notes.data?.saved;

  return (
    <section className="bg-panel border border-line rounded-lg p-4 space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex-1 min-w-[220px]">
          <h2 className="font-semibold">Additional notes</h2>
          <p className="text-[13px] text-muted">
            {running ? `${agent} is reading the sprint and writing, started ${ago(job.data?.startedAt ?? Date.now())}.` : saved ? `Written ${ago(saved.at)}. Edit them here before you copy them.` : "A write-up of the sprint for people outside the team, from every ticket, status change, PR and commit cockpit has. Runs only when you ask."}
          </p>
        </div>
        <Button size="sm" variant="ghost" onClick={() => setShowSetup((v) => !v)}>
          {showSetup ? `Hide what ${agent} gets` : `What ${agent} gets`}
        </Button>
        <Button size="sm" onClick={() => generate.mutate()} disabled={!!running || generate.isPending}>
          {running ? "Writing" : saved ? "Write again" : "Write the notes"}
        </Button>
        <Button
          size="sm"
          variant="primary"
          disabled={!text}
          onClick={() => {
            copy(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>

      {showSetup && (
        <div className="grid lg:grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <div className="text-[12px] text-muted">Instructions, saved for every sprint</div>
            <textarea value={shownPrompt} onChange={(e) => setPrompt(e.target.value)} rows={9} className={`${inputClass} h-auto w-full py-2 font-sans text-[13px] leading-relaxed`} />
            <div className="flex gap-1.5">
              <Button size="sm" disabled={prompt === undefined || prompt === (custom || notes.data?.defaultPrompt)} onClick={() => saveNotes({ prompt: prompt === notes.data?.defaultPrompt ? "" : (prompt ?? "") }).then(() => setPrompt(undefined))}>
                Save
              </Button>
              {custom && (
                <Button size="sm" variant="ghost" onClick={() => saveNotes({ prompt: "" }).then(() => setPrompt(undefined))}>
                  Back to the default
                </Button>
              )}
              <label className="ml-auto flex items-center gap-2 text-[12px] text-muted" title="The branch that is production. Each ticket then says whether its work has reached it, so done work still on its way isn't called live">
                Production branch
                <input
                  key={liveBranch}
                  defaultValue={liveBranch}
                  placeholder="none"
                  onBlur={(e) => {
                    const b = e.target.value.trim();
                    if (b !== liveBranch) saveNotes({ liveBranch: b });
                  }}
                  className={`${inputClass} w-24`}
                />
              </label>
              <label className="flex items-center gap-2 text-[12px] text-muted" title={`A draft that comes out longer goes back to ${agent} to shorten. 0 is no limit`}>
                At most
                <input
                  key={maxChars}
                  defaultValue={maxChars || ""}
                  placeholder="no limit"
                  inputMode="numeric"
                  onBlur={(e) => {
                    const n = Math.max(0, Math.round(Number(e.target.value) || 0));
                    if (n !== maxChars) saveNotes({ maxChars: n });
                  }}
                  className={`${inputClass} w-24 text-right tabular-nums`}
                />
                characters
              </label>
            </div>
          </div>
          <div className="space-y-1.5 min-w-0">
            <div className="text-[12px] text-muted">The sprint's data, as {agent} reads it</div>
            <pre className="h-[236px] overflow-auto rounded-md border border-line bg-ground p-2 text-[12px] leading-relaxed whitespace-pre-wrap">{brief.data ?? (brief.isLoading ? "Gathering it" : "")}</pre>
          </div>
        </div>
      )}

      {(saved || text) && (
        <div className="space-y-1">
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={maxChars && maxChars <= 1000 ? 10 : 18} className={`${inputClass} h-auto w-full py-2 font-sans leading-relaxed`} />
          <div className={`text-right text-[12px] tabular-nums ${maxChars && text.length > maxChars ? "text-red" : "text-faint"}`}>
            {text.length}
            {maxChars ? ` / ${maxChars}` : ""} characters
          </div>
        </div>
      )}
      <ErrorNote error={notes.error ?? generate.error ?? failed ?? brief.error} />
    </section>
  );
}

function Activity({ days }: { days: DayActivity[] }) {
  const cost = useCost();
  return (
    <div className="divide-y divide-line">
      {days.map((d) => {
        const quiet = !d.transitions.length && !d.prsOpened.length && !d.prsMerged.length && !d.commits.length && !d.sessions.length;
        if (quiet) return null;
        return (
          <div key={d.date} className="py-2.5 grid grid-cols-[110px_1fr] gap-3">
            <div>
              <div className="font-medium text-[13px]">{new Date(`${d.date}T12:00`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}</div>
              <div className="text-[12px] text-muted">
                {d.commits.length} commits{d.costUSD && !cost.hidden ? `, ${usd(d.costUSD)}` : ""}
              </div>
            </div>
            <div className="space-y-1 text-[13px] min-w-0">
              {d.transitions.map((t, i) => (
                <div key={i} className="flex items-center gap-1.5">
                  <span className="font-medium">{t.key}</span>
                  {t.from && <span className="text-muted">{t.from} to</span>}
                  <StatusTag status={t.to} />
                </div>
              ))}
              {d.prsMerged.map((p) => (
                <div key={`m${p.number}`} className="truncate">
                  <Tag tone="green">merged</Tag> <a href={p.url} target="_blank" rel="noreferrer" className="hover:text-cobalt">#{p.number} {p.title}</a>
                </div>
              ))}
              {d.prsOpened.map((p) => (
                <div key={`o${p.number}`} className="truncate">
                  <Tag tone="amber">opened</Tag> <a href={p.url} target="_blank" rel="noreferrer" className="hover:text-cobalt">#{p.number} {p.title}</a>
                </div>
              ))}
              {d.sessions.length > 0 && (
                <div className="text-muted truncate">
                  Claude: {d.sessions.filter((s) => s.title).slice(0, 4).map((s) => s.title).join(", ")}
                  {d.sessions.length > 4 ? ` and ${d.sessions.length - 4} more` : ""}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Me against the rest of the team, both measured as the share of their own points done.
function PaceStat({ r }: { r: SprintReport }) {
  const me = r.people.filter((p) => p.me);
  const rest = r.people.filter((p) => !p.me);
  const sum = (ps: Person[]) => ps.reduce((a, p) => ({ scope: a.scope + p.scope, done: a.done + p.done }), { scope: 0, done: 0 });
  const m = sum(me);
  const o = sum(rest);
  const mine = pct(m.done, m.scope);
  const others = pct(o.done, o.scope);
  const ideal = Math.round(r.elapsedShare * 100);
  const diff = mine - others;
  return (
    <Stat
      label="Me against the rest"
      value={`${mine}% vs ${others}%`}
      note={`${diff === 0 ? "level with the team" : diff > 0 ? `you're ${diff}% ahead` : `you're ${-diff}% behind`}, even pace is ${ideal}%`}
    />
  );
}

export function ReportPage() {
  const cost = useCost();
  const claudeMain = useClaudeMain();
  const { sprint, scope: s } = useSearch({ from: "/report" });
  const scope = s ?? "team";
  const navigate = useNavigate();
  const qc = useQueryClient();
  const report = useQuery({ queryKey: ["report", sprint, scope], queryFn: () => api.get<SprintReport>(`/report/sprint${qs({ id: sprint, scope })}`) });
  const sprints = useQuery({ queryKey: ["sprints"], queryFn: () => api.get<(Sprint & { state: string })[]>("/sprints") });
  const from = report.data?.sprint.start?.slice(0, 10);
  const activity = useQuery({
    queryKey: ["activity", from],
    queryFn: () => api.get<DayActivity[]>(`/report/activity${qs({ from: from ?? undefined })}`),
    enabled: !!report.data,
  });
  // a sync refetches the sprint from Jira once; everything built from it reloads after
  const snapshot = useMutation({
    mutationFn: () => api.post("/report/snapshot"),
    onSuccess: () => Promise.all(["report", "saydo", "activity", "daily", "brag-week", "sprints"].map((k) => qc.invalidateQueries({ queryKey: [k] }))),
  });

  const r = report.data;
  const recent = sprints.data?.filter((s) => s.state !== "future").slice(-8).reverse();

  return (
    <div className="max-w-[1200px] space-y-5">
      <PageHeader title="Sprint report" sub={r ? `${r.sprint.name}${r.sprint.goal ? `. ${r.sprint.goal}` : ""}` : undefined}>
        <div className="flex rounded-md border border-line overflow-hidden text-[14px]" role="group" aria-label="Whose points">
          {(["team", "me"] as const).map((v) => (
            <button
              key={v}
              onClick={() => navigate({ to: "/report", search: { sprint, scope: v === "me" ? "me" : undefined } })}
              className={`px-3 h-9 ${scope === v ? "bg-cobalt-soft text-cobalt font-medium" : "text-muted hover:text-ink"}`}
              aria-pressed={scope === v}
            >
              {v === "team" ? "Team" : "Only me"}
            </button>
          ))}
        </div>
        <select value={sprint ?? ""} onChange={(e) => navigate({ to: "/report", search: { sprint: e.target.value ? Number(e.target.value) : undefined, scope: s } })} className={inputClass}>
          <option value="">Current sprint</option>
          {recent?.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <Button onClick={() => snapshot.mutate()} disabled={snapshot.isPending}>
          {snapshot.isPending ? "Syncing" : "Sync now"}
        </Button>
      </PageHeader>
      {report.isLoading && <Loading what="Building the report" />}
      <ErrorNote error={report.error ?? snapshot.error} />

      {r && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Stat label={scope === "me" ? "My points done" : "Team points done"} value={`${r.totals.done} / ${r.totals.scope}`} note={`${pct(r.totals.done, r.totals.scope)}%, ${r.totals.released} pt released`} />
            <PaceStat r={r} />
            <Stat label="Projected by the end" value={`${r.totals.projected} pt`} note={r.totals.projected >= r.totals.scope ? "on pace to finish" : `${(r.totals.scope - r.totals.projected).toFixed(1)} pt short at this pace`} />
            <Stat label="Workdays left" value={String(r.totals.daysLeft)} note={`of ${r.totals.daysTotal}`} />
          </div>

          <section className="bg-panel border border-line rounded-lg p-4">
            <h2 className="font-semibold">Sprint burndown</h2>
            <p className="text-[13px] text-muted">
              {scope === "me" ? "Your" : "The team's"} points left to finish each day from what was committed at the start, against the even pace that ends at zero on the last day.
              {r.totals.lateScope ? ` ${r.totals.lateScope} pt added after the start ${r.totals.lateScope === 1 ? "isn't" : "aren't"} counted here.` : ""}
            </p>
            <Burndown data={r.burndown} />
          </section>

          <div className="grid lg:grid-cols-2 gap-5 items-start">
            <section className="bg-panel border border-line rounded-lg p-4">
              <h2 className="font-semibold mb-2">Work by status</h2>
              <Distribution data={r.distribution} note={`Done counts ${r.doneStatuses.join(", ")}, so part of it still needs testing and UAT sign-off before it ships.`} />
            </section>
            <section className="bg-panel border border-line rounded-lg p-4">
              <h2 className="font-semibold">Say / do ratio</h2>
              <SayDo scope={scope} />
            </section>
          </div>

          <section className="bg-panel border border-line rounded-lg p-4">
            <h2 className="font-semibold mb-3">Who's where</h2>
            <Pace people={r.people} ideal={r.elapsedShare} />
          </section>

          <section className="bg-panel border border-line rounded-lg p-4">
            <h2 className="font-semibold">Where each ticket spent its time</h2>
            <p className="text-[13px] text-muted mb-3">History builds up from hourly syncs. Before the first sync only the latest status change is known.</p>
            <StatusLanes report={r} />
          </section>

          <AdditionalNotes sprintId={r.sprint.id} />
        </>
      )}

      <section className="bg-panel border border-line rounded-lg p-4">
        <h2 className="font-semibold">Day by day</h2>
        {activity.isLoading && <Loading />}
        {activity.data && (
          <>
            {!cost.hidden && <CostChart days={activity.data} />}
            {!cost.hidden && !claudeMain && <p className="text-[12px] text-faint mt-1">Only Claude Code puts a dollar figure on its sessions, so the chart leaves out other agents' sessions.</p>}
            <Activity days={activity.data} />
          </>
        )}
      </section>
    </div>
  );
}
