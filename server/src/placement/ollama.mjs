// One answer from a model in Ollama, for cockpit's quick answers: the prompt on stdin, the answer streamed to
// stdout as it comes. Plain JavaScript, so node runs it on any machine without a build.
const [url, model] = process.argv.slice(2);
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
try {
  const res = await fetch(`${url.replace(/\/$/, "")}/api/generate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model, prompt, stream: true }) });
  if (!res.ok) throw new Error(`Ollama said ${res.status}: ${(await res.text()).slice(0, 300)}`);
  let rest = "";
  for await (const chunk of res.body) {
    rest += Buffer.from(chunk).toString();
    const lines = rest.split("\n");
    rest = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      const d = JSON.parse(line);
      if (d.error) throw new Error(d.error);
      if (d.response) process.stdout.write(d.response);
    }
  }
  process.stdout.write("\n");
} catch (e) {
  // fetch only says "fetch failed" when nothing answers
  console.error(e.message === "fetch failed" ? `Nothing answered at ${url}. Is Ollama running there?` : e.message);
  process.exit(1);
}
