import { useMemo, useState } from "react";

interface Node {
  name: string;
  path: string;
  children?: Map<string, Node>;
}

function build(paths: string[]) {
  const root: Node = { name: "", path: "", children: new Map() };
  for (const p of paths) {
    let cur = root;
    const parts = p.split("/");
    parts.forEach((part, i) => {
      const leaf = i === parts.length - 1;
      let next = cur.children!.get(part);
      if (!next) {
        next = { name: part, path: parts.slice(0, i + 1).join("/"), children: leaf ? undefined : new Map() };
        cur.children!.set(part, next);
      }
      cur = next;
    });
  }
  return root;
}

const sorted = (n: Node) => [...n.children!.values()].sort((a, b) => Number(!!b.children) - Number(!!a.children) || a.name.localeCompare(b.name));

// expanded flips the set to mean "collapsed", so folders that show up later start open too
export function FileTree({ paths, active, changed, onOpen, expanded = false }: { paths: string[]; active?: string; changed: Map<string, string>; onOpen: (p: string) => void; expanded?: boolean }) {
  const tree = useMemo(() => build(paths), [paths]);
  const [open, setOpen] = useState<Set<string>>(() => new Set());

  const toggle = (p: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(p)) n.delete(p);
      else n.add(p);
      return n;
    });

  // only expanded folders render their children, which keeps big repos fast
  const render = (node: Node, depth: number): React.ReactNode =>
    sorted(node).map((c) => {
      const pad = { paddingLeft: 8 + depth * 12 };
      if (c.children) {
        const isOpen = open.has(c.path) !== expanded;
        return (
          <div key={c.path}>
            <button onClick={() => toggle(c.path)} style={pad} className="w-full flex items-center gap-1 h-6 text-left text-[13px] hover:bg-ground truncate">
              <span className="text-faint w-3 shrink-0">{isOpen ? "▾" : "▸"}</span>
              <span className="truncate">{c.name}</span>
            </button>
            {isOpen && render(c, depth + 1)}
          </div>
        );
      }
      const st = changed.get(c.path);
      return (
        <button
          key={c.path}
          onClick={() => onOpen(c.path)}
          style={pad}
          className={`w-full flex items-center gap-1 h-6 text-left text-[13px] truncate ${active === c.path ? "bg-cobalt-soft text-cobalt" : "hover:bg-ground"} ${st ? "text-amber" : ""}`}
        >
          <span className="w-3 shrink-0" />
          <span className="truncate flex-1">{c.name}</span>
          {st && <span className="text-[11px] pr-2">{st}</span>}
        </button>
      );
    });

  return <div className="py-1">{render(tree, 0)}</div>;
}
