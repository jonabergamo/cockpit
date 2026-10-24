import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { AutomationSettings } from "../components/AutomationSettings";
import { FontSection } from "../components/FontSettings";
import { MachinesSection } from "../components/Machines";
import { PluginsSection, ScreensSection } from "../components/PluginSettings";
import { SetupSection } from "../components/SetupSection";
import { TemplateSettings } from "../components/TemplateSettings";
import { Button, ErrorNote, Loading, PageHeader, Tabs } from "../components/ui";
import { type CostMode, useCost, useSaveSettings, useSettings } from "../lib/cost";
import { useNavGroups } from "../lib/nav";

export const SETTINGS_TABS = ["general", "setup", "automation", "machines", "screens", "plugins"] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];
const TAB_LABEL: Record<SettingsTab, string> = { general: "General", setup: "Setup", automation: "Automation", machines: "Machines", screens: "Screens", plugins: "Plugins" };

export function SettingsPage() {
  const { tab = "general" } = useSearch({ from: "/settings" });
  const navigate = useNavigate();
  const q = useSettings();
  const save = useSaveSettings();
  const cost = useCost();
  const [err, setErr] = useState<unknown>();
  const s = q.data;
  const pages = useNavGroups().settingsPages;

  const choose = (costs: CostMode) => {
    setErr(undefined);
    save({ costs }).catch(setErr);
  };

  const detected = s?.billing.kind === "api" ? "Cost" : "API value";
  const explain: Record<CostMode, string> = {
    auto: `Cockpit works it out from your Claude login. Right now it shows them as ${detected}.`,
    real: "Dollars show as Cost, the bill you pay for these tokens.",
    api: "Dollars show as API value, what the tokens would cost on the API. Right for a Pro, Max, Team or Enterprise plan.",
    hide: "No dollar amounts anywhere. Usage shows tokens and the plan limits instead.",
  };

  return (
    <div className="max-w-[860px] space-y-5">
      <PageHeader title="Settings" sub="Saved on the server, so every device shows the same.">
        {/* Claude's own settings, memory and skills, out of the sidebar unless Screens turns it on */}
        <Link to="/memory" search={{ path: undefined }}>
          <Button>Memory & skills</Button>
        </Link>
      </PageHeader>
      <Tabs<SettingsTab> value={tab} onChange={(t) => navigate({ to: "/settings", search: { tab: t === "general" ? undefined : t }, replace: true })} items={SETTINGS_TABS.map((t) => ({ value: t, label: TAB_LABEL[t] }))} />
      {q.isLoading && <Loading />}
      <ErrorNote error={q.error ?? err} />
      {tab === "setup" && <SetupSection />}
      {tab === "general" && s && (
        <section className="bg-panel border border-line rounded-lg p-4 space-y-3">
          <div>
            <h2 className="font-semibold">Costs</h2>
            <p className="text-[13px] text-muted mt-0.5">
              Claude Code puts a dollar figure on every session, priced at API rates. Whether that's a bill depends on how you log in:{" "}
              {s.billing.why}, so {s.billing.kind === "api" ? "it's what you pay" : s.billing.kind === "subscription" ? "it's only a comparison, your plan doesn't charge it" : "cockpit treats it as a comparison"}.
            </p>
          </div>
          <Tabs<CostMode>
            value={s.settings.costs}
            onChange={choose}
            items={[
              { value: "auto", label: `Auto (${detected})` },
              { value: "real", label: "Cost" },
              { value: "api", label: "API value" },
              { value: "hide", label: "Hidden" },
            ]}
          />
          <p className="text-[13px] text-muted">{explain[s.settings.costs]}</p>
          {!cost.hidden && <p className="text-[12px] text-faint">{cost.hint}.</p>}
        </section>
      )}
      {tab === "general" && <FontSection />}
      {tab === "automation" && (
        <>
          <AutomationSettings />
          <TemplateSettings />
        </>
      )}
      {tab === "machines" && <MachinesSection />}
      {tab === "screens" && <ScreensSection />}
      {tab === "plugins" && !!pages.length && (
        <section className="bg-panel border border-line rounded-lg p-4 space-y-2">
          <div>
            <h2 className="font-semibold">Plugin settings</h2>
            <p className="text-[13px] text-muted mt-0.5">Pages of settings that plugins bring, too big for the plugin list below.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {pages.map((p) => (
              <Link key={`${p.plugin}/${p.id}`} to="/p/$plugin/$screen" params={{ plugin: p.plugin, screen: p.id }}>
                <Button>{p.title}</Button>
              </Link>
            ))}
          </div>
        </section>
      )}
      {tab === "plugins" && <PluginsSection />}
    </div>
  );
}
