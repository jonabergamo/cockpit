import { describe, expect, it } from "vitest";
import { parseScreen } from "../src/agents.ts";

const rule = "─".repeat(80);

describe("parseScreen", () => {
  it("finds a permission menu and its question", () => {
    const screen = [
      "● I'll run the tests now.",
      "",
      "╭──────────────────────────────────────────────╮",
      "│ Bash command                                  │",
      "│   pnpm test --filter web                      │",
      "│                                               │",
      "│ Do you want to proceed?                       │",
      "│ ❯ 1. Yes                                      │",
      "│   2. Yes, and don't ask again for pnpm        │",
      "│   3. No, and tell Claude what to do (esc)     │",
      "╰──────────────────────────────────────────────╯",
    ].join("\n");
    const ask = parseScreen(screen);
    expect(ask.question).toBe("Do you want to proceed?");
    expect(ask.options.map((o) => o.key)).toEqual(["1", "2", "3"]);
    expect(ask.options[1].label).toBe("Yes, and don't ask again for pnpm");
  });

  it("reads a question tool menu whose options have descriptions", () => {
    const screen = ["● A couple of choices first.", "", " ☐ Storage", "", "Where should the saved cards live?", "", "❯ 1. Server", "     Kept with the account", "  2. Browser", "     Only on this device", "  3. Type something.", "", "Enter to select · ↑/↓ to navigate · Esc to cancel"].join("\n");
    const ask = parseScreen(screen);
    expect(ask.question).toBe("Where should the saved cards live?");
    expect(ask.options.map((o) => o.label)).toEqual(["Server", "Browser", "Type something."]);
  });

  it("finds a dialog that took the input box's place", () => {
    const screen = ["● Write(notes/todo.md)", "", "─".repeat(50), " Create file", " notes/todo.md", "╌".repeat(50), "  1 hi", "╌".repeat(50), " Do you want to create todo.md?", " ❯ 1. Yes", "   2. Yes, and allow edits for this session; and", "      always allow access to notes/ (shift+tab)", "   3. No", "", " Esc to cancel · Tab to amend"].join("\n");
    const ask = parseScreen(screen);
    expect(ask.question).toBe("Do you want to create todo.md?");
    expect(ask.options.map((o) => o.key)).toEqual(["1", "2", "3"]);
    expect(ask.screen).toContain("Create file");
  });

  it("splits the conversation from the input box and keeps an unsent draft", () => {
    const screen = ["● Pushed the branch.", "", "✻ Brewed for 53s", "", rule, "❯ run the app so i can see it", rule, "  Opus │ acme │ main │ ctx 9%", "  ⏵⏵ auto mode on"].join("\n");
    const ask = parseScreen(screen);
    expect(ask.options).toEqual([]);
    expect(ask.draft).toBe("run the app so i can see it");
    expect(ask.screen).toContain("Pushed the branch.");
    expect(ask.screen).not.toContain("auto mode");
  });

  it("doesn't take a numbered list in the conversation for a menu", () => {
    const screen = ["● Three things to do:", "  1. Fix the test", "  2. Update the docs", "  3. Push", "", "✻ Done", "", rule, "❯ ", rule].join("\n");
    expect(parseScreen(screen).options).toEqual([]);
  });
});
