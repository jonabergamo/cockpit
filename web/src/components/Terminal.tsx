import { ClipboardAddon } from "@xterm/addon-clipboard";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { mix, type TermInfo, type Theme } from "@cockpit/shared";
import { api } from "../lib/api";
import { keep, send, useLive } from "../lib/live";
import { termPrefs } from "../lib/termPrefs";
import { themeStore } from "../lib/theme";
import { codeStack, fontStore } from "../lib/fonts";
import { copy } from "./ui";

// Straight to the URL: the addon's default opens a blank window first, which the desktop app hands to the
// browser before the address is set.
const openLink = (_: MouseEvent, uri: string) => {
  if (/^https?:\/\//i.test(uri)) window.open(uri, "_blank", "noopener,noreferrer");
};

const NAMES = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"] as const;

// The xterm palette from the active cockpit theme, including all 16 ANSI colours.
function xtermTheme(t: Theme) {
  const ansi = Object.fromEntries(NAMES.flatMap((n, i) => [[n, t.ansi[i]], [`bright${n[0].toUpperCase()}${n.slice(1)}`, t.ansi[i + 8]]]));
  return { ...ansi, background: t.ui.panel, foreground: t.ui.ink, cursor: t.ui.accent, cursorAccent: t.ui.panel, selectionBackground: mix(t.ui.accent, t.ui.panel, 0.3) };
}

// a point smaller on a phone, where every column counts
const termSize = () => (window.innerWidth < 640 ? Math.min(12, fontStore.get().codeSize) : fontStore.get().codeSize);

export function Terminal({ id, onExit }: { id: string; onExit?: (code: number) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const term = useRef<XTerm>(null);
  const tmux = useRef(false);
  const finder = useRef<SearchAddon>(null);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [note, setNote] = useState<string>();
  const [ownHistory, setOwnHistory] = useState(true);
  // a terminal on a node whose link dropped: still running there, but typing would go nowhere, or worse, land in
  // whatever prompt is up by the time it came back, so it waits until the node is back
  const terms = useQuery({ queryKey: ["terms"], queryFn: () => api.get<TermInfo[]>("/code/terms") });
  const info = terms.data?.find((t) => t.id === id);
  const offline = info?.state === "disconnected";
  const blocked = useRef(false);
  blocked.current = offline;

  useEffect(() => {
    const t = new XTerm({
      fontFamily: codeStack(fontStore.get()),
      fontSize: termSize(),
      cursorBlink: true,
      scrollback: 10000,
      theme: xtermTheme(themeStore.get().active),
      allowProposedApi: true,
      // ⌥-drag selects text even while claude has the mouse
      macOptionClickForcesSelection: true,
      // OSC 8 links, e.g. the "PR #123" text claude prints
      linkHandler: { activate: openLink, allowNonHttpProtocols: false },
    });
    const fit = new FitAddon();
    t.loadAddon(fit);
    t.loadAddon(new WebLinksAddon(openLink));
    // OSC 52, how claude copies its own mouse selection; writes only, programs don't get to read your clipboard
    t.loadAddon(new ClipboardAddon(undefined, { readText: () => "", writeText: (_, text) => copy(text) }));
    const search = new SearchAddon();
    t.loadAddon(search);
    finder.current = search;
    // ⌘F on a Mac, Ctrl+Shift+F elsewhere (plain Ctrl+F belongs to the shell)
    t.attachCustomKeyEventHandler((e) => {
      if (e.type === "keydown" && e.key.toLowerCase() === "f" && (e.metaKey || (e.ctrlKey && e.shiftKey))) {
        setSearching(true);
        return false;
      }
      // ⌘C, Ctrl+Shift+C, or Ctrl+C while text is selected copies it; Ctrl+C with nothing selected still interrupts
      if (e.type === "keydown" && e.key.toLowerCase() === "c" && (e.metaKey || e.ctrlKey) && t.hasSelection()) {
        e.preventDefault();
        copy(t.getSelection());
        if (!e.metaKey) t.clearSelection();
        return false;
      }
      return true;
    });
    t.open(box.current!);
    // on mouseup rather than every selection change, so the fallback copy doesn't steal focus mid-drag
    const copySelection = () => termPrefs.copyOnSelect() && t.hasSelection() && copy(t.getSelection());
    const el = box.current!;
    el.addEventListener("mouseup", copySelection);

    // An image on the clipboard, or files dropped on the terminal, go up to the dev box and their paths get
    // pasted in, which claude turns into attachments.
    const upload = async (files: File[]) => {
      setNote(`Sending ${files.length > 1 ? `${files.length} files` : files[0].type.startsWith("image/") ? "image" : files[0].name}`);
      try {
        const paths = [];
        for (const f of files) {
          const res = await fetch(`/api/code/terms/${id}/paste?name=${encodeURIComponent(f.name)}`, { method: "POST", body: f });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error ?? res.statusText);
          paths.push(data.path);
        }
        t.paste(paths.join(" ") + " ");
        setNote(undefined);
      } catch (e) {
        setNote(`Couldn't send it: ${e instanceof Error ? e.message : e}`);
        setTimeout(() => setNote(undefined), 4000);
      }
      t.focus();
    };
    // capture, so this runs before xterm's own paste handler, which only knows text
    const onPaste = (e: ClipboardEvent) => {
      const files = [...(e.clipboardData?.files ?? [])];
      if (!files.length || e.clipboardData?.getData("text/plain")) return;
      e.preventDefault();
      e.stopPropagation();
      upload(files);
    };
    const onDragOver = (e: DragEvent) => e.dataTransfer?.types.includes("Files") && e.preventDefault();
    const onDrop = (e: DragEvent) => {
      const files = [...(e.dataTransfer?.files ?? [])];
      if (!files.length) return;
      e.preventDefault();
      upload(files);
    };
    el.addEventListener("paste", onPaste, true);
    el.addEventListener("dragover", onDragOver);
    el.addEventListener("drop", onDrop);
    term.current = t;

    const resize = () => {
      if (term.current !== t) return;
      try {
        fit.fit();
        send({ type: "pty.resize", id, cols: t.cols, rows: t.rows });
      } catch {}
    };
    const ro = new ResizeObserver(resize);
    ro.observe(box.current!);
    // the first fit can run on the fallback font; once the real one loads the cells are taller, so fit again
    document.fonts.ready.then(resize);
    document.fonts.addEventListener("loadingdone", resize);

    // Inside tmux the history lives in tmux, not in xterm, so the wheel is turned into tmux scroll commands.
    let acc = 0;
    let pending = 0;
    let frame = 0;
    t.attachCustomWheelEventHandler((e) => {
      if (!tmux.current) return true;
      const cell = box.current && t.rows ? box.current.clientHeight / t.rows : 17;
      acc += e.deltaMode === 1 ? e.deltaY * cell : e.deltaY;
      const lines = Math.trunc(acc / cell);
      if (lines) {
        acc -= lines * cell;
        pending += lines;
        frame ||= requestAnimationFrame(() => {
          send({ type: "pty.scroll", id, lines: -pending });
          pending = 0;
          frame = 0;
        });
      }
      e.preventDefault();
      return false;
    });

    const sub = t.onData((data) => {
      if (!blocked.current) return send({ type: "pty.input", id, data });
      setNote("Not sent: this terminal's machine is disconnected");
      setTimeout(() => setNote(undefined), 2500);
    });
    keep(`pty:${id}`, { type: "pty.attach", id });
    setTimeout(resize, 50);
    t.focus();

    // open terminals switch with the app theme and the fonts from Settings
    const unsub = themeStore.subscribe(() => (t.options.theme = xtermTheme(themeStore.get().active)));
    const unfont = fontStore.subscribe(() => {
      t.options.fontFamily = codeStack(fontStore.get());
      t.options.fontSize = termSize();
      // a font that isn't loaded yet measures as the fallback; fit again when it is
      document.fonts.load(`${termSize()}px ${codeStack(fontStore.get())}`).finally(resize);
    });

    return () => {
      unsub();
      unfont();
      el.removeEventListener("mouseup", copySelection);
      el.removeEventListener("paste", onPaste, true);
      el.removeEventListener("dragover", onDragOver);
      el.removeEventListener("drop", onDrop);
      keep(`pty:${id}`, null);
      sub.dispose();
      ro.disconnect();
      document.fonts.removeEventListener("loadingdone", resize);
      t.dispose();
    };
  }, [id]);

  useLive(
    (ev) => {
      if (ev.type === "pty.data" && ev.id === id) term.current?.write(ev.data);
      // the whole scrollback follows, so the screen starts clean instead of showing it twice
      if (ev.type === "pty.reset" && ev.id === id) term.current?.reset();
      if (ev.type === "pty.mode" && ev.id === id) {
        tmux.current = !!ev.tmux;
        // tmux (or the full-screen app inside it) holds the history, so xterm's own scrollback and bar would only scroll nothing
        if (ev.tmux && term.current) term.current.options.scrollback = 0;
        setOwnHistory(!ev.tmux);
      }
      if (ev.type === "pty.exit" && ev.id === id) {
        term.current?.write(`\r\n\x1b[2m[process exited${ev.code >= 0 ? ` with ${ev.code}` : ""}]\x1b[0m\r\n`);
        onExit?.(ev.code);
      }
    },
    [id],
  );

  // tmux keeps the history, so searching there drives tmux's own search; plain terminals use xterm's
  // "older" walks up the history from the bottom, like a terminal's own search
  const started = useRef("");
  const find = (dir: "older" | "newer") => {
    if (!query) return;
    if (!tmux.current) return dir === "older" ? finder.current?.findPrevious(query) : finder.current?.findNext(query);
    const fresh = started.current !== query;
    started.current = query;
    send({ type: "pty.search", id, query, step: fresh ? "find" : dir === "older" ? "next" : "prev" });
  };
  const close = () => {
    started.current = "";
    if (tmux.current) send({ type: "pty.search", id, query: "", step: "close" });
    finder.current?.clearDecorations();
    setSearching(false);
    term.current?.focus();
  };

  return (
    <div className="relative h-full w-full overflow-clip">
      {/* the padding sits outside the box xterm measures, or it fits one row too many and the last one is cut off */}
      <div className={`h-full w-full px-2 py-1 bg-panel ${ownHistory ? "" : "term-no-scrollbar"}`}>
        <div ref={box} className="h-full w-full" />
      </div>
      {offline && (
        <div className="absolute inset-x-0 top-0 z-10 flex items-center justify-center gap-2 bg-amber-soft/90 border-b border-amber/50 px-3 py-1.5 text-[12px] text-amber">
          <span className="size-2 rounded-full bg-amber animate-pulse" />
          {info?.node ?? "Its machine"} is disconnected. It keeps running there, and this reconnects by itself. Typing is paused until then.
        </div>
      )}
      {note && <div className="absolute bottom-3 right-4 z-10 bg-raised border border-line rounded-md shadow-lg px-2.5 py-1 text-[12px] text-muted">{note}</div>}
      {searching && (
        <form
          className="absolute top-2 right-4 z-10 flex items-center gap-1 bg-raised border border-line rounded-md shadow-lg px-1.5 py-1"
          onSubmit={(e) => {
            e.preventDefault();
            find("older");
          }}
        >
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") close();
              if (e.key === "Enter" && e.shiftKey) {
                e.preventDefault();
                find("newer");
              }
            }}
            placeholder="Find in terminal"
            className="h-7 w-48 bg-transparent px-1.5 text-[13px] outline-none"
          />
          <button type="button" className="size-7 rounded hover:bg-ground text-muted" onClick={() => find("older")} title="Older match (↵)">
            ↑
          </button>
          <button type="button" className="size-7 rounded hover:bg-ground text-muted" onClick={() => find("newer")} title="Newer match (⇧↵)">
            ↓
          </button>
          <button type="button" className="size-7 rounded hover:bg-ground text-muted" onClick={close} title="Close (Esc)">
            ×
          </button>
        </form>
      )}
    </div>
  );
}
