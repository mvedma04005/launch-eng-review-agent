const MIN_CHARS = 40;

/** The headings that are absent or unfilled in a PR description, in the order given. */
export function missingPlanSections(body: string, headings: string[]): string[] {
  // shortcut: an unclosed `<!--` is not stripped, so the template text after it counts; strip to the end if templates rely on it.
  const text = body.replace(/<!--[\s\S]*?-->/g, '');
  const sections: Array<{ title: string; level: number; chars: number }> = [];
  let open: typeof sections = [];
  let fence: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker && (fence === null || marker[0] === fence[0])) fence = fence === null ? marker : null;
    const h = fence === null && !marker ? /^(#{1,6})\s+(.*)$/.exec(line) : null;
    const chars = line.replace(/\s/g, '').length;
    if (h) {
      // A deeper heading belongs to the sections above it: its line counts toward their text.
      open = open.filter((s) => s.level < h[1]!.length);
      for (const s of open) s.chars += chars;
      const section = { title: h[2]!.trim().toLowerCase(), level: h[1]!.length, chars: 0 };
      sections.push(section);
      open.push(section);
    } else for (const s of open) s.chars += chars;
  }
  return headings.filter((h) => !sections.some((s) => s.title.startsWith(h.toLowerCase()) && s.chars >= MIN_CHARS));
}
