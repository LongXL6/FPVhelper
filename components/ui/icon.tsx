const paths = {
  live: "M3 5h18v12H3z M8 21h8 M12 17v4 M9 9l6 3-6 3z",
  folder: "M3 7V5h6l2 2h10v13H3z",
  settings: "M4 7h16 M4 17h16 M8 4v6 M16 14v6",
  camera: "M3 6h12v12H3z M15 10l6-3v10l-6-3",
  usb: "M12 21V3 M9 6l3-3 3 3 M12 15l-6-4V8 M12 18l6-5V8 M4 5h4v3H4z M16 5h4v3h-4z",
  "arrow-right": "M4 12h16 M14 6l6 6-6 6",
  "arrow-left": "M20 12H4 M10 6l-6 6 6 6",
  check: "M5 12l4 4L19 6",
  chevron: "M9 5l7 7-7 7",
  download: "M12 3v12 M7 10l5 5 5-5 M4 15v6h16v-6",
  expand: "M8 3H3v5 M16 3h5v5 M3 16v5h5 M21 16v5h-5",
  collapse: "M3 8h5V3 M21 8h-5V3 M8 21v-5H3 M16 21v-5h5",
  flag: "M5 22V3 M5 3c5-5 9 5 14 0v10c-5 5-9-5-14 0",
  clock: "M12 7v5l3 2 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0",
  record: "M19 12a7 7 0 1 1-14 0 7 7 0 0 1 14 0",
  stop: "M6 6h12v12H6z",
  shield: "M12 3l8 3v6c0 5-8 9-8 9S4 17 4 12V6z M8 12l3 3 5-6",
  help: "M9 9a3 3 0 1 1 4 3v2 M12 17h.01 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0",
  search: "M21 21l-5-5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
  close: "M6 6l12 12 M18 6L6 18",
  signal: "M4 18v3 M9 13v8 M14 8v13 M19 3v18",
  layers: "M12 3L2 8l10 5 10-5z M2 12l10 5 10-5 M2 16l10 5 10-5",
  reset: "M3 4v6h6 M3 10a9 9 0 1 1 2 8",
  info: "M12 11v6 M12 7h.01 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0",
} as const;

export type IconName = keyof typeof paths;

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
