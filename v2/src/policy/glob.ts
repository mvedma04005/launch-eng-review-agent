/** Small glob matcher: `**` any depth, `*` within a segment, `?` one char, `{a,b}` alternatives. Paths are repository-relative with `/`. */
export function minimatch(path: string, pattern: string): boolean {
  return toRegExp(pattern).test(path);
}

const cache = new Map<string, RegExp>();

export function toRegExp(pattern: string): RegExp {
  const hit = cache.get(pattern);
  if (hit) return hit;
  let out = '^';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i]!;
    if (c === '*' && pattern[i + 1] === '*') {
      const slashAfter = pattern[i + 2] === '/';
      out += slashAfter ? '(?:.*/)?' : '.*';
      i += slashAfter ? 3 : 2;
    } else if (c === '*') { out += '[^/]*'; i++; }
    else if (c === '?') { out += '[^/]'; i++; }
    else if (c === '{') {
      const end = pattern.indexOf('}', i);
      if (end === -1) { out += '\\{'; i++; continue; }
      const alts = pattern.slice(i + 1, end).split(',').map((a) => a.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*'));
      out += '(?:' + alts.join('|') + ')';
      i = end + 1;
    } else { out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&'); i++; }
  }
  const re = new RegExp(out + '$');
  cache.set(pattern, re);
  return re;
}
