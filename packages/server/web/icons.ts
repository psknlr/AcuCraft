import { s } from "./dom.js";

/**
 * The workspace's icons: a few line drawings on a 24-unit grid, stroked in the text's colour (built as SVG
 * elements, never parsed from markup).
 */

const PATHS: Record<string, string[]> = {
  ask: ["M21 11.5a8.4 8.4 0 0 1-9 8.4 9 9 0 0 1-3.7-.8L3 21l1.9-5.1A8.4 8.4 0 0 1 3 11.5 8.4 8.4 0 0 1 12 3a8.4 8.4 0 0 1 9 8.5z", "M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6", "M12 16.5h.01"],
  say: ["M21 11.5a8.4 8.4 0 0 1-9 8.4 9 9 0 0 1-3.7-.8L3 21l1.9-5.1A8.4 8.4 0 0 1 3 11.5 8.4 8.4 0 0 1 12 3a8.4 8.4 0 0 1 9 8.5z", "M8 10h8", "M8 14h5"],
  examine: ["M5 3v6a5 5 0 0 0 10 0V3", "M10 14v2a5 5 0 0 0 10 0v-3", "M20 10.5a2 2 0 1 1 0 .01", "M3.5 3H6.5", "M13.5 3h3"],
  observe: ["M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z", "M12 9a3 3 0 1 1 0 6 3 3 0 0 1 0-6z"],
  vitals: ["M3 12h4l2.5-6 4 12 2.5-6H21"],
  monitor: ["M3 5h18v12H3z", "M8 21h8", "M12 17v4", "M6 12h3l1.5-3 2 6 1.5-3H18"],
  hygiene: ["M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z", "M9.5 15a2.5 2.5 0 0 0 2.5 2.5"],
  count: ["M9 6h11", "M9 12h11", "M9 18h11", "M4 6l1 1 2-2", "M4 12l1 1 2-2", "M4 18l1 1 2-2"],
  wait: ["M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18z", "M12 7v5l3 2"],
  note: ["M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z", "M14 3v6h6", "M8 13h8", "M8 17h5"],
  play: ["M7 4.5v15l12-7.5z"],
  pause: ["M8 5v14", "M16 5v14"],
  stop: ["M6 6h12v12H6z"],
  download: ["M12 4v11", "M7 10l5 5 5-5", "M5 20h14"],
  print: ["M7 9V3h10v6", "M7 18H5a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2", "M7 14h10v7H7z"],
  trash: ["M4 7h16", "M10 11v6", "M14 11v6", "M6 7l1 13h10l1-13", "M9 7V4h6v3"],
  lock: ["M6 11h12v10H6z", "M8.5 11V7.5a3.5 3.5 0 0 1 7 0V11"],
  copy: ["M9 9h11v11H9z", "M5 15H4V4h11v1"],
  sparkle: ["M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z", "M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z"],
  search: ["M10.5 4a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13z", "M20 20l-4.8-4.8"],
  check: ["M5 12.5l4.5 4.5L19 7.5"],
  alert: ["M12 3l9.5 17H2.5z", "M12 10v4", "M12 17h.01"],
  info: ["M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18z", "M12 11v5", "M12 8h.01"],
};

export type IconName = keyof typeof PATHS;

/** An icon (decorative: hidden from assistive technology; the button or label beside it carries the words). */
export function icon(name: IconName, size = 16): SVGSVGElement {
  return s(
    "svg",
    { class: "icon", viewBox: "0 0 24 24", width: size, height: size, fill: "none", stroke: "currentColor", "stroke-width": 1.9, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", focusable: "false" },
    (PATHS[name] ?? []).map((d) => s("path", { d })),
  );
}
