export interface FontOption {
  label: string;
  value: string; // the font-family CSS value written into style={{fontFamily}}
  googleFont?: string; // Google Fonts family name to load, if not a system font
}

// A curated set, not the full Google Fonts catalog (1500+) — matches how
// most page builders scope their font picker to something browsable rather
// than a live search. Web-safe entries need no loading at all; Inter is
// already registered site-wide via next/font in app/layout.tsx.
export const FONT_LIBRARY: FontOption[] = [
  { label: "Inter", value: "Inter, sans-serif" },
  { label: "System UI", value: "system-ui, sans-serif" },
  { label: "Arial", value: "Arial, Helvetica, sans-serif" },
  { label: "Helvetica", value: "Helvetica, Arial, sans-serif" },
  { label: "Georgia", value: "Georgia, serif" },
  { label: "Times New Roman", value: "'Times New Roman', Times, serif" },
  { label: "Courier New", value: "'Courier New', Courier, monospace" },
  { label: "Verdana", value: "Verdana, sans-serif" },
  { label: "Trebuchet MS", value: "'Trebuchet MS', sans-serif" },
  { label: "Palatino", value: "Palatino, 'Palatino Linotype', serif" },
  { label: "Roboto", value: "'Roboto', sans-serif", googleFont: "Roboto" },
  { label: "Poppins", value: "'Poppins', sans-serif", googleFont: "Poppins" },
  { label: "Montserrat", value: "'Montserrat', sans-serif", googleFont: "Montserrat" },
  { label: "Playfair Display", value: "'Playfair Display', serif", googleFont: "Playfair Display" },
  { label: "Lato", value: "'Lato', sans-serif", googleFont: "Lato" },
  { label: "Open Sans", value: "'Open Sans', sans-serif", googleFont: "Open Sans" },
  { label: "Merriweather", value: "'Merriweather', serif", googleFont: "Merriweather" },
  { label: "Oswald", value: "'Oswald', sans-serif", googleFont: "Oswald" },
  { label: "Nunito", value: "'Nunito', sans-serif", googleFont: "Nunito" },
  { label: "Raleway", value: "'Raleway', sans-serif", googleFont: "Raleway" },
];

const loadedGoogleFonts = new Set<string>();

/**
 * Injects a Google Fonts <link> at runtime — dev-only overlay code, never
 * touches any page source file. Keeps the actual persisted change (the
 * font-family value written into the component's style) a normal content
 * edit, same shape as any other CSS property patch, while this makes sure
 * the browser actually has the face to render it with.
 */
export function ensureGoogleFontLoaded(googleFont: string) {
  if (typeof document === "undefined" || loadedGoogleFonts.has(googleFont)) return;
  loadedGoogleFonts.add(googleFont);
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = `https://fonts.googleapis.com/css2?family=${googleFont.replace(/ /g, "+")}:wght@400;500;600;700&display=swap`;
  document.head.appendChild(link);
}

/** Eagerly loads every library Google Font once — so a font applied in an earlier session still renders correctly on a fresh page load, without tracking per-element usage. */
export function preloadFontLibrary() {
  for (const font of FONT_LIBRARY) {
    if (font.googleFont) ensureGoogleFontLoaded(font.googleFont);
  }
}
