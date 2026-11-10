import type { Side } from '../types.ts';

export interface DiffFile {
  path: string;
  oldPath: string;
  status: 'added' | 'removed' | 'modified' | 'renamed';
  binary: boolean;
  additions: number;
  deletions: number;
  /** Raw unified diff text for this file. */
  text: string;
}

export interface Anchors {
  /** Lines a GitHub review comment may attach to: RIGHT = added or context lines in the new file, LEFT = deleted lines in the old file. */
  has(path: string, side: Side, line: number): boolean;
  files: DiffFile[];
}

/** Parse `git diff` unified output into per-file records and the set of commentable line anchors. */
export function parseUnifiedDiff(text: string): Anchors {
  const files: DiffFile[] = [];
  const set = new Set<string>();
  const chunks = text.split(/^(?=diff --git )/m).filter((c) => c.startsWith('diff --git '));
  for (const chunk of chunks) {
    const header = chunk.match(/^diff --git a\/(.+?) b\/(.+)$/m);
    if (!header) continue;
    let oldPath = unquote(header[1]!), path = unquote(header[2]!);
    const renameTo = chunk.match(/^rename to (.+)$/m);
    const renameFrom = chunk.match(/^rename from (.+)$/m);
    if (renameTo && renameFrom) { path = unquote(renameTo[1]!); oldPath = unquote(renameFrom[1]!); }
    const status: DiffFile['status'] = /^new file mode/m.test(chunk) ? 'added' : /^deleted file mode/m.test(chunk) ? 'removed' : renameTo ? 'renamed' : 'modified';
    const binary = /^Binary files /m.test(chunk) || /^GIT binary patch/m.test(chunk);
    let additions = 0, deletions = 0, left = 0, right = 0, inHunk = false;
    for (const line of chunk.split('\n')) {
      const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunk) { left = Number(hunk[1]); right = Number(hunk[2]); inHunk = true; continue; }
      if (!inHunk) continue;
      if (line.startsWith('\\')) continue; // "\ No newline at end of file"
      if (line.startsWith('+')) { set.add(key(path, 'RIGHT', right)); right++; additions++; }
      else if (line.startsWith('-')) { set.add(key(oldPath, 'LEFT', left)); left++; deletions++; }
      else if (line.startsWith(' ')) { set.add(key(path, 'RIGHT', right)); left++; right++; }
      else if (line === '') { /* trailing */ }
      else inHunk = false;
    }
    files.push({ path, oldPath, status, binary, additions, deletions, text: chunk });
  }
  return { files, has: (p, s, l) => set.has(key(p, s, l)) };
}

const key = (p: string, s: Side, l: number) => `${s}\u0000${p}\u0000${l}`;
function unquote(p: string): string {
  return p.startsWith('"') && p.endsWith('"') ? JSON.parse(p) as string : p;
}
