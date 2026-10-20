// Real editor and terminal themes, from their published palettes. A colour marked "nudged" was moved a little
// from the official value so text on it stays readable (see server/test/themes.test.ts for the bars).
// On light themes the accent is often a few percent darker than the original so button text stays readable.

export interface Theme {
  id: string;
  name: string;
  scheme: "dark" | "light";
  ui: {
    ground: string; // page background
    panel: string; // cards and the terminal
    raised: string; // inputs, popovers
    ink: string;
    muted: string;
    faint: string;
    line: string;
    accent: string;
    amber: string;
    green: string;
    red: string;
  };
  // black red green yellow blue magenta cyan white, then the bright eight
  ansi: string[];
}

export const themes: Theme[] = [
  {
    id: "cockpit-dark",
    name: "Cockpit Dark",
    scheme: "dark",
    ui: { ground: "#151a22", panel: "#1c222c", raised: "#232a35", ink: "#dce2ea", muted: "#8c96a6", faint: "#6f7989", line: "#2c3441", accent: "#6f93f5", amber: "#e0a93a", green: "#5cbf86", red: "#e8706a" },
    ansi: ["#151a22", "#e8706a", "#5cbf86", "#e0a93a", "#6f93f5", "#c08cf0", "#5cc5d1", "#dce2ea", "#626c7c", "#f08a85", "#7bd3a0", "#ecbe5e", "#8fabf8", "#d1a7f5", "#7fd6e0", "#ffffff"],
  },
  {
    id: "github-dark",
    name: "GitHub Dark",
    scheme: "dark",
    ui: { ground: "#010409", panel: "#0d1117", raised: "#161b22", ink: "#e6edf3", muted: "#9198a1", faint: "#6e7681", line: "#30363d", accent: "#4493f8", amber: "#d29922", green: "#3fb950", red: "#f85149" },
    ansi: ["#484f58", "#ff7b72", "#3fb950", "#d29922", "#58a6ff", "#bc8cff", "#39c5cf", "#b1bac4", "#6e7681", "#ffa198", "#56d364", "#e3b341", "#79c0ff", "#d2a8ff", "#56d4dd", "#ffffff"],
  },
  {
    id: "dracula",
    name: "Dracula",
    scheme: "dark",
    // muted nudged: the official comment colour is too dim for body text
    ui: { ground: "#21222c", panel: "#282a36", raised: "#343746", ink: "#f8f8f2", muted: "#a9b0d0", faint: "#7282b4", line: "#44475a", accent: "#bd93f9", amber: "#ffb86c", green: "#50fa7b", red: "#ff5555" },
    ansi: ["#21222c", "#ff5555", "#50fa7b", "#f1fa8c", "#bd93f9", "#ff79c6", "#8be9fd", "#f8f8f2", "#6272a4", "#ff6e6e", "#69ff94", "#ffffa5", "#d6acff", "#ff92df", "#a4ffff", "#ffffff"],
  },
  {
    id: "nord",
    name: "Nord",
    scheme: "dark",
    // ground and red nudged: Nord's aurora red is too dark on polar night
    ui: { ground: "#272c36", panel: "#2e3440", raised: "#3b4252", ink: "#eceff4", muted: "#c0c8d6", faint: "#8590a6", line: "#434c5e", accent: "#88c0d0", amber: "#ebcb8b", green: "#a3be8c", red: "#d57780" },
    ansi: ["#3b4252", "#bf616a", "#a3be8c", "#ebcb8b", "#81a1c1", "#b48ead", "#88c0d0", "#e5e9f0", "#4c566a", "#bf616a", "#a3be8c", "#ebcb8b", "#81a1c1", "#b48ead", "#8fbcbb", "#eceff4"],
  },
  {
    id: "one-dark",
    name: "One Dark",
    scheme: "dark",
    ui: { ground: "#21252b", panel: "#282c34", raised: "#2c313a", ink: "#d7dae0", muted: "#abb2bf", faint: "#7f848e", line: "#3e4451", accent: "#61afef", amber: "#e5c07b", green: "#98c379", red: "#e06c75" },
    ansi: ["#282c34", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#abb2bf", "#5c6370", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#ffffff"],
  },
  {
    id: "tokyo-night",
    name: "Tokyo Night",
    scheme: "dark",
    ui: { ground: "#16161e", panel: "#1a1b26", raised: "#24283b", ink: "#c0caf5", muted: "#a9b1d6", faint: "#737aa2", line: "#292e42", accent: "#7aa2f7", amber: "#e0af68", green: "#9ece6a", red: "#f7768e" },
    ansi: ["#15161e", "#f7768e", "#9ece6a", "#e0af68", "#7aa2f7", "#bb9af7", "#7dcfff", "#a9b1d6", "#414868", "#f7768e", "#9ece6a", "#e0af68", "#7aa2f7", "#bb9af7", "#7dcfff", "#c0caf5"],
  },
  {
    id: "catppuccin-mocha",
    name: "Catppuccin Mocha",
    scheme: "dark",
    ui: { ground: "#181825", panel: "#1e1e2e", raised: "#313244", ink: "#cdd6f4", muted: "#a6adc8", faint: "#7f849c", line: "#45475a", accent: "#89b4fa", amber: "#f9e2af", green: "#a6e3a1", red: "#f38ba8" },
    ansi: ["#45475a", "#f38ba8", "#a6e3a1", "#f9e2af", "#89b4fa", "#f5c2e7", "#94e2d5", "#bac2de", "#585b70", "#f38ba8", "#a6e3a1", "#f9e2af", "#89b4fa", "#f5c2e7", "#94e2d5", "#a6adc8"],
  },
  {
    id: "catppuccin-macchiato",
    name: "Catppuccin Macchiato",
    scheme: "dark",
    ui: { ground: "#1e2030", panel: "#24273a", raised: "#363a4f", ink: "#cad3f5", muted: "#a5adcb", faint: "#8087a2", line: "#494d64", accent: "#8aadf4", amber: "#eed49f", green: "#a6da95", red: "#ed8796" },
    ansi: ["#494d64", "#ed8796", "#a6da95", "#eed49f", "#8aadf4", "#f5bde6", "#8bd5ca", "#b8c0e0", "#5b6078", "#ed8796", "#a6da95", "#eed49f", "#8aadf4", "#f5bde6", "#8bd5ca", "#a5adcb"],
  },
  {
    id: "gruvbox-dark",
    name: "Gruvbox Dark",
    scheme: "dark",
    ui: { ground: "#1d2021", panel: "#282828", raised: "#3c3836", ink: "#ebdbb2", muted: "#bdae93", faint: "#928374", line: "#504945", accent: "#83a598", amber: "#fabd2f", green: "#b8bb26", red: "#fb4934" },
    ansi: ["#282828", "#cc241d", "#98971a", "#d79921", "#458588", "#b16286", "#689d6a", "#a89984", "#928374", "#fb4934", "#b8bb26", "#fabd2f", "#83a598", "#d3869b", "#8ec07c", "#ebdbb2"],
  },
  {
    id: "solarized-dark",
    name: "Solarized Dark",
    scheme: "dark",
    // faint and line nudged: base01 and base02 are too close to the background for borders and hints
    ui: { ground: "#00212b", panel: "#002b36", raised: "#073642", ink: "#93a1a1", muted: "#839496", faint: "#6c8189", line: "#0e4a59", accent: "#268bd2", amber: "#b58900", green: "#859900", red: "#dc322f" },
    ansi: ["#073642", "#dc322f", "#859900", "#b58900", "#268bd2", "#d33682", "#2aa198", "#eee8d5", "#002b36", "#cb4b16", "#586e75", "#657b83", "#839496", "#6c71c4", "#93a1a1", "#fdf6e3"],
  },
  {
    id: "rose-pine",
    name: "Rosé Pine",
    scheme: "dark",
    // Rosé Pine has no green, foam is what it uses for success
    ui: { ground: "#191724", panel: "#1f1d2e", raised: "#26233a", ink: "#e0def4", muted: "#908caa", faint: "#6e6a86", line: "#403d52", accent: "#c4a7e7", amber: "#f6c177", green: "#9ccfd8", red: "#eb6f92" },
    ansi: ["#26233a", "#eb6f92", "#31748f", "#f6c177", "#9ccfd8", "#c4a7e7", "#ebbcba", "#e0def4", "#6e6a86", "#eb6f92", "#31748f", "#f6c177", "#9ccfd8", "#c4a7e7", "#ebbcba", "#e0def4"],
  },
  {
    id: "monokai",
    name: "Monokai",
    scheme: "dark",
    // faint nudged from the comment colour #75715e
    ui: { ground: "#1e1f1c", panel: "#272822", raised: "#3e3d32", ink: "#f8f8f2", muted: "#cfcfc2", faint: "#8f8b77", line: "#49483e", accent: "#66d9ef", amber: "#e6db74", green: "#a6e22e", red: "#f92672" },
    ansi: ["#272822", "#f92672", "#a6e22e", "#f4bf75", "#66d9ef", "#ae81ff", "#a1efe4", "#f8f8f2", "#75715e", "#f92672", "#a6e22e", "#f4bf75", "#66d9ef", "#ae81ff", "#a1efe4", "#f9f8f5"],
  },
  {
    id: "night-owl",
    name: "Night Owl",
    scheme: "dark",
    ui: { ground: "#010e1a", panel: "#011627", raised: "#0b2942", ink: "#d6deeb", muted: "#a1b3c5", faint: "#6f8a8a", line: "#1d3b53", accent: "#82aaff", amber: "#ecc48d", green: "#addb67", red: "#ef5350" },
    ansi: ["#011627", "#ef5350", "#22da6e", "#c5e478", "#82aaff", "#c792ea", "#21c7a8", "#ffffff", "#575656", "#ef5350", "#22da6e", "#ffeb95", "#82aaff", "#c792ea", "#7fdbca", "#ffffff"],
  },
  {
    id: "ayu-mirage",
    name: "Ayu Mirage",
    scheme: "dark",
    ui: { ground: "#1a1f29", panel: "#1f2430", raised: "#272d38", ink: "#cbccc6", muted: "#a2a6ad", faint: "#707a8c", line: "#33415e", accent: "#ffcc66", amber: "#ffa759", green: "#bae67e", red: "#f28779" },
    ansi: ["#191e2a", "#ed8274", "#a6cc70", "#fad07b", "#6dcbfa", "#cfbafa", "#90e1c6", "#c7c7c7", "#686868", "#f28779", "#bae67e", "#ffd580", "#73d0ff", "#d4bfff", "#95e6cb", "#ffffff"],
  },
  {
    id: "everforest-dark",
    name: "Everforest Dark",
    scheme: "dark",
    ui: { ground: "#232a2e", panel: "#2d353b", raised: "#343f44", ink: "#d3c6aa", muted: "#9da9a0", faint: "#859289", line: "#475258", accent: "#7fbbb3", amber: "#dbbc7f", green: "#a7c080", red: "#e67e80" },
    ansi: ["#343f44", "#e67e80", "#a7c080", "#dbbc7f", "#7fbbb3", "#d699b6", "#83c092", "#859289", "#475258", "#e67e80", "#a7c080", "#dbbc7f", "#7fbbb3", "#d699b6", "#83c092", "#d3c6aa"],
  },
  {
    id: "kanagawa",
    name: "Kanagawa",
    scheme: "dark",
    ui: { ground: "#16161d", panel: "#1f1f28", raised: "#2a2a37", ink: "#dcd7ba", muted: "#c8c093", faint: "#7c7b72", line: "#363646", accent: "#7e9cd8", amber: "#e6c384", green: "#98bb6c", red: "#e46876" },
    ansi: ["#090618", "#c34043", "#76946a", "#c0a36e", "#7e9cd8", "#957fb8", "#6a9589", "#c8c093", "#727169", "#e82424", "#98bb6c", "#e6c384", "#7fb4ca", "#938aa9", "#7aa89f", "#dcd7ba"],
  },

  {
    id: "cockpit-light",
    name: "Cockpit Light",
    scheme: "light",
    ui: { ground: "#e7eaee", panel: "#f6f7f9", raised: "#ffffff", ink: "#1b2333", muted: "#5d6778", faint: "#7c8595", line: "#cbd1da", accent: "#2f5bd3", amber: "#a06b05", green: "#2a7f50", red: "#c2413a" },
    ansi: ["#1b2333", "#c2413a", "#2e8b57", "#9a6a05", "#2f5bd3", "#8a3fbf", "#1b7f8c", "#8b94a3", "#5d6778", "#d4544d", "#379e66", "#b97c06", "#4a72e0", "#a259d6", "#2696a5", "#cbd1da"],
  },
  {
    id: "github-light",
    name: "GitHub Light",
    scheme: "light",
    ui: { ground: "#f6f8fa", panel: "#ffffff", raised: "#ffffff", ink: "#1f2328", muted: "#59636e", faint: "#818b98", line: "#d1d9e0", accent: "#0969da", amber: "#9a6700", green: "#1a7f37", red: "#d1242f" },
    ansi: ["#24292f", "#cf222e", "#116329", "#4d2d00", "#0969da", "#8250df", "#1b7c83", "#6e7781", "#57606a", "#a40e26", "#1a7f37", "#633c01", "#218bff", "#a475f9", "#3192aa", "#8c959f"],
  },
  {
    id: "solarized-light",
    name: "Solarized Light",
    scheme: "light",
    // muted, faint and the yellow-green accents nudged darker so they read on base3
    ui: { ground: "#eee8d5", panel: "#fdf6e3", raised: "#fffbee", ink: "#586e75", muted: "#5b6f76", faint: "#7f8f90", line: "#e1dac4", accent: "#217ab9", amber: "#9a7500", green: "#6f8000", red: "#dc322f" },
    ansi: ["#073642", "#dc322f", "#859900", "#b58900", "#268bd2", "#d33682", "#2aa198", "#eee8d5", "#002b36", "#cb4b16", "#586e75", "#657b83", "#839496", "#6c71c4", "#93a1a1", "#fdf6e3"],
  },
  {
    id: "catppuccin-latte",
    name: "Catppuccin Latte",
    scheme: "light",
    // yellow and green nudged darker, Latte's are meant for syntax on white, not small text
    ui: { ground: "#e6e9ef", panel: "#eff1f5", raised: "#ffffff", ink: "#4c4f69", muted: "#5c5f77", faint: "#7c7f93", line: "#ccd0da", accent: "#1e66f5", amber: "#b5700f", green: "#378a24", red: "#d20f39" },
    ansi: ["#5c5f77", "#d20f39", "#40a02b", "#df8e1d", "#1e66f5", "#ea76cb", "#179299", "#acb0be", "#6c6f85", "#d20f39", "#40a02b", "#df8e1d", "#1e66f5", "#ea76cb", "#179299", "#bcc0cc"],
  },
  {
    id: "gruvbox-light",
    name: "Gruvbox Light",
    scheme: "light",
    ui: { ground: "#f2e5bc", panel: "#fbf1c7", raised: "#f9f5d7", ink: "#3c3836", muted: "#665c54", faint: "#857767", line: "#d5c4a1", accent: "#076678", amber: "#b57614", green: "#79740e", red: "#9d0006" },
    ansi: ["#fbf1c7", "#cc241d", "#98971a", "#d79921", "#458588", "#b16286", "#689d6a", "#7c6f64", "#928374", "#9d0006", "#79740e", "#b57614", "#076678", "#8f3f71", "#427b58", "#3c3836"],
  },
  {
    id: "rose-pine-dawn",
    name: "Rosé Pine Dawn",
    scheme: "light",
    // faint and gold nudged darker for text on the dawn base
    ui: { ground: "#f2e9e1", panel: "#faf4ed", raised: "#fffaf3", ink: "#575279", muted: "#6e6a8a", faint: "#8a859b", line: "#dfdad9", accent: "#826e98", amber: "#b87422", green: "#286983", red: "#b4637a" },
    ansi: ["#f2e9e1", "#b4637a", "#286983", "#ea9d34", "#56949f", "#907aa9", "#d7827e", "#575279", "#9893a5", "#b4637a", "#286983", "#ea9d34", "#56949f", "#907aa9", "#d7827e", "#575279"],
  },
  {
    id: "one-light",
    name: "One Light",
    scheme: "light",
    ui: { ground: "#eaeaeb", panel: "#fafafa", raised: "#ffffff", ink: "#383a42", muted: "#5f626c", faint: "#84868e", line: "#dbdbdc", accent: "#3c71e3", amber: "#a87301", green: "#3f8a3e", red: "#e45649" },
    ansi: ["#383a42", "#e45649", "#50a14f", "#c18401", "#4078f2", "#a626a4", "#0184bc", "#a0a1a7", "#696c77", "#e45649", "#50a14f", "#c18401", "#4078f2", "#a626a4", "#0184bc", "#fafafa"],
  },
  {
    id: "tokyo-night-day",
    name: "Tokyo Night Day",
    scheme: "light",
    ui: { ground: "#d0d5e3", panel: "#e1e2e7", raised: "#e9e9ed", ink: "#3760bf", muted: "#4e5d9b", faint: "#6a72a0", line: "#c4c8da", accent: "#2a73d6", amber: "#8c6c3e", green: "#587539", red: "#d1204f" },
    ansi: ["#e9e9ed", "#f52a65", "#587539", "#8c6c3e", "#2e7de9", "#9854f1", "#007197", "#6172b0", "#a1a6c5", "#f52a65", "#587539", "#8c6c3e", "#2e7de9", "#9854f1", "#007197", "#3760bf"],
  },
  {
    id: "everforest-light",
    name: "Everforest Light",
    scheme: "light",
    // the bright accents are nudged darker so status text reads on the cream background
    ui: { ground: "#efebd4", panel: "#fdf6e3", raised: "#fffbef", ink: "#5c6a72", muted: "#5f6d63", faint: "#7a8a7b", line: "#e6e2cc", accent: "#2e7daa", amber: "#a07700", green: "#6c7d00", red: "#e2403d" },
    ansi: ["#5c6a72", "#f85552", "#8da101", "#dfa000", "#3a94c5", "#df69ba", "#35a77c", "#e6e2cc", "#829181", "#f85552", "#8da101", "#dfa000", "#3a94c5", "#df69ba", "#35a77c", "#fdf6e3"],
  },
  {
    id: "ayu-light",
    name: "Ayu Light",
    scheme: "light",
    // Ayu's orange, yellow and green are nudged darker for text on its near-white background
    ui: { ground: "#f0f0f0", panel: "#fafafa", raised: "#ffffff", ink: "#5c6166", muted: "#5f6469", faint: "#7c8188", line: "#e1e3e6", accent: "#b55c19", amber: "#a86e12", green: "#5e7d00", red: "#d65252" },
    ansi: ["#000000", "#ea6c6d", "#6cbf43", "#eca944", "#3199e1", "#9e75c7", "#46ba94", "#bababa", "#686868", "#f07171", "#86b300", "#f2ae49", "#399ee6", "#a37acc", "#4cbf99", "#d1d1d1"],
  },
];

export const themeById = (id: string) => themes.find((t) => t.id === id);

// --- colour maths -------------------------------------------------------------

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const hex = (c: number[]) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;

// t of a over b, like color-mix(in srgb, a t, b)
export const mix = (a: string, b: string, t: number) => {
  const [x, y] = [rgb(a), rgb(b)];
  return hex(x.map((v, i) => v * t + y[i] * (1 - t)));
};

const luminance = (c: string) => {
  const [r, g, b] = rgb(c).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

export const contrast = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

// text on an accent-coloured fill: whichever of white or the theme's darkest colour reads better
export const onAccent = (t: Theme) => {
  const dark = t.scheme === "dark" ? t.ui.ground : t.ui.ink;
  return contrast("#ffffff", t.ui.accent) >= contrast(dark, t.ui.accent) ? "#ffffff" : dark;
};

// Every CSS variable the app reads. The soft tints are the colour mixed into the panel.
export function themeVars(t: Theme): Record<string, string> {
  const soft = t.scheme === "dark" ? 0.2 : 0.15;
  const u = t.ui;
  return {
    "--ground": u.ground,
    "--panel": u.panel,
    "--raised": u.raised,
    "--ink": u.ink,
    "--muted": u.muted,
    "--faint": u.faint,
    "--line": u.line,
    "--cobalt": u.accent,
    "--cobalt-soft": mix(u.accent, u.panel, soft),
    "--amber": u.amber,
    "--amber-soft": mix(u.amber, u.panel, soft),
    "--green": u.green,
    "--green-soft": mix(u.green, u.panel, soft),
    "--red": u.red,
    "--red-soft": mix(u.red, u.panel, soft),
    "--on-accent": onAccent(t),
    // labels on green/amber/red fills: those are bright on dark themes and deep on light ones
    "--on-status": t.scheme === "dark" ? u.ground : "#ffffff",
  };
}
