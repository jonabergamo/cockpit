// A stand-in coding agent for tests: reads its prompt on stdin and answers in Codex's JSON lines. What it does
// depends on words in the prompt: EDIT writes a file, SLOW takes a while, FAIL fails the turn, CRASH exits
// without a word, REVIEW ends with a verdict and TASKS with a list of tasks.
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const resume = args.includes("--resume") ? args[args.indexOf("--resume") + 1] : undefined;
let prompt = "";
for await (const c of process.stdin) prompt += c;
const say = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

if (prompt.includes("CRASH")) {
  process.stderr.write("fake-agent: something broke\n");
  process.exit(2);
}
say({ type: "thread.started", thread_id: resume ?? `thread-${Math.random().toString(36).slice(2, 8)}` });
say({ type: "turn.started" });
if (prompt.includes("SLOW")) await new Promise((r) => setTimeout(r, 400));
if (prompt.includes("EDIT")) {
  say({ type: "item.started", item: { id: "item_1", type: "command_execution", command: "touch touched.txt", status: "in_progress" } });
  writeFileSync("touched.txt", prompt);
  say({ type: "item.completed", item: { id: "item_1", type: "command_execution", command: "touch touched.txt", aggregated_output: "", exit_code: 0, status: "completed" } });
}
if (prompt.includes("FAIL")) {
  say({ type: "turn.failed", error: { message: "the model said no" } });
  process.exit(1);
}
const answer = prompt.includes("REVIEW")
  ? "Looked at it.\nVERDICT: changes"
  : prompt.includes("TASKS")
    ? 'Here they are:\n```json\n[{"title":"one","prompt":"do one"},{"title":"two","prompt":"do two"}]\n```'
    : `${resume ? "again" : "first"}: ${prompt.trim().split("\n")[0].slice(0, 40)}`;
say({ type: "item.completed", item: { id: "item_2", type: "agent_message", text: answer } });
say({ type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 10, reasoning_output_tokens: 2 } });
