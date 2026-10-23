import { Link } from "@tanstack/react-router";
import { useTabs } from "../lib/nav";

// The tabs across the top of a screen made of several, each a link so it has its own address.
// Nothing shows when only one tab is left.
export function ScreenTabs({ screen, current }: { screen: string; current: string }) {
  const tabs = useTabs(screen, current);
  if (tabs.length < 2) return null;
  return (
    <nav className="inline-flex bg-ground rounded-md p-0.5 gap-0.5 mb-4" aria-label="Views">
      {tabs.map((t) => (
        <Link
          key={t.value}
          to={t.to}
          search={(t.search ?? {}) as never}
          // the router would call a tab with fewer parameters current too; which one is, is ours to say
          activeOptions={{ exact: true }}
          aria-current={t.value === current ? "page" : undefined}
          className={`px-2.5 h-7 grid place-items-center rounded text-[13px] font-medium ${t.value === current ? "bg-raised text-ink shadow-[0_0_0_1px_var(--line)]" : "text-muted hover:text-ink"}`}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
