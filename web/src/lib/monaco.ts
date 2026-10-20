import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import { mix, themes } from "@cockpit/shared";
import editorWorker from "monaco-editor/editor/editor.worker?worker";
import cssWorker from "monaco-editor/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/language/html/html.worker?worker";
import jsonWorker from "monaco-editor/language/json/json.worker?worker";
import tsWorker from "monaco-editor/language/typescript/ts.worker?worker";
import { codeStack, fontStore } from "./fonts";
import { themeStore } from "./theme";

self.MonacoEnvironment = {
  getWorker(_, label) {
    if (label === "json") return new jsonWorker();
    if (["css", "scss", "less"].includes(label)) return new cssWorker();
    if (["html", "handlebars", "razor"].includes(label)) return new htmlWorker();
    if (label === "typescript" || label === "javascript") return new tsWorker();
    return new editorWorker();
  },
};

// It's a file viewer for big repos, so skip the type checking noise from missing imports.
monaco.typescript.typescriptDefaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false });
monaco.typescript.javascriptDefaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false });
monaco.typescript.typescriptDefaults.setCompilerOptions({ jsx: monaco.typescript.JsxEmit.Preserve, allowJs: true, target: monaco.typescript.ScriptTarget.ESNext });

// One Monaco theme per cockpit theme. The editor follows the app: switching the theme switches every open editor.
const bare = (c: string) => c.slice(1);
for (const t of themes) {
  const { ui, ansi } = t;
  monaco.editor.defineTheme(t.id, {
    base: t.scheme === "dark" ? "vs-dark" : "vs",
    inherit: true,
    rules: [
      { token: "comment", foreground: bare(ui.faint), fontStyle: "italic" },
      { token: "keyword", foreground: bare(ansi[5]) },
      { token: "string", foreground: bare(ui.green) },
      { token: "number", foreground: bare(ui.amber) },
      { token: "type", foreground: bare(ansi[6]) },
      { token: "tag", foreground: bare(ui.red) },
      { token: "attribute.name", foreground: bare(ui.amber) },
      { token: "attribute.value", foreground: bare(ui.green) },
      { token: "delimiter", foreground: bare(ui.muted) },
    ],
    colors: {
      "editor.background": ui.panel,
      "editor.foreground": ui.ink,
      "editor.lineHighlightBackground": ui.raised,
      "editor.lineHighlightBorder": ui.raised,
      "editorLineNumber.foreground": ui.faint,
      "editorLineNumber.activeForeground": ui.muted,
      "editorCursor.foreground": ui.accent,
      "editor.selectionBackground": mix(ui.accent, ui.panel, 0.3),
      "editor.inactiveSelectionBackground": mix(ui.accent, ui.panel, 0.18),
      "editorIndentGuide.background1": ui.line,
      "editorWidget.background": ui.raised,
      "editorWidget.border": ui.line,
      "editorGutter.background": ui.panel,
      "diffEditor.insertedTextBackground": mix(ui.green, ui.panel, 0.22),
      "diffEditor.removedTextBackground": mix(ui.red, ui.panel, 0.22),
      "scrollbarSlider.background": mix(ui.faint, ui.panel, 0.35),
    },
  });
}

loader.config({ monaco });

export const editorTheme = () => themeStore.get().active.id;

themeStore.subscribe(() => monaco.editor.setTheme(editorTheme()));

// Monaco caches glyph widths per font; after a font change or a late font load, measure again
const remeasure = () => monaco.editor.remeasureFonts();
fontStore.subscribe(() => void document.fonts.load(`13px ${codeStack(fontStore.get())}`).finally(remeasure));
document.fonts.addEventListener("loadingdone", remeasure);
