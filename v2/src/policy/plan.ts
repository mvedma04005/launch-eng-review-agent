const MIN_CHARS = 40;

/** The headings that are absent or unfilled in a PR description, in the order given. */
export function missingPlanSections(body: string, headings: string[]): string[] {
  const text = body.replace(/<!--[\s\S]*?-->/g, '');
  const sections: Array<{ title: string; chars: number }> = [];
  for (const line of text.split(/\r?\n/)) {
    const h = /^#{1,6}\s+(.*)$/.exec(line);
    if (h) sections.push({ title: h[1]!.trim().toLowerCase(), chars: 0 });
    else if (sections.length) sections.at(-1)!.chars += line.replace(/\s/g, '').length;
  }
  return headings.filter((h) => !sections.some((s) => s.title.startsWith(h.toLowerCase()) && s.chars >= MIN_CHARS));
}
