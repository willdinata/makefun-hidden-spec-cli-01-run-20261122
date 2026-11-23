// mend, the patch-applying CLI specified in SPEC.md (MIT).
// Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

function safePaths(paths: (string | null)[]): void {
  for (const p of paths) if (p !== null && !safe(p)) throw new Fail('unsafe', p);
}

/** A file retains its own breaks, including whether there was a final break. */
class LineFile {
  readonly br: string;
  readonly lines: string[];
  final: boolean;
  constructor(text: string) {
    const nl = text.indexOf('\n');
    this.br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
    this.lines = text === '' ? [] : text.split(this.br);
    this.final = text !== '' && text.endsWith(this.br);
    if (this.final) this.lines.pop();
  }
  text(): string {
    return this.lines.length === 0 ? '' : this.lines.join(this.br) + (this.final ? this.br : '');
  }
}

const leading = (s: string): string => s.match(/^[ \t]*/)![0];
const atTier = (s: string, tier: number): string => tier === 0 ? s : tier === 1 ? s.replace(/[ \t]+$/, '') : s.replace(/^[ \t]+|[ \t]+$/g, '');

interface Matches {
  tier: number;
  positions: number[];
}

/** Occurrences can overlap; restrictions are applied before selecting a tier. */
function matchLines(lines: string[], old: string[], strict: boolean, from = 0, endOnly = false): Matches | null {
  for (let tier = 0; tier <= (strict ? 0 : 2); tier += 1) {
    const want = old.map((l) => atTier(l, tier));
    const have = lines.map((l) => atTier(l, tier));
    const positions: number[] = [];
    const last = lines.length - old.length;
    for (let i = endOnly ? Math.max(from, last) : from; i <= last; i += 1) {
      if (want.every((l, j) => l === have[i + j])) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

function reindent(line: string, filePrefix: string, patchPrefix: string): string {
  return !blank(line) && line.startsWith(patchPrefix) ? filePrefix + line.slice(patchPrefix.length) : line;
}

interface BodyLine {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
}

const oldLines = (body: BodyLine[]): string[] => body.filter((l) => l.kind === ' ' || l.kind === '-').map((l) => l.text);

/** Context is copied from the occurrence, not from the patch's version of it. */
function replacementLines(lines: string[], body: BodyLine[], at: number, tier: number): string[] {
  const old = oldLines(body);
  const filePrefix = leading(lines[at] ?? '');
  const patchPrefix = leading(old[0] ?? '');
  const out: string[] = [];
  let offset = 0;
  for (const l of body) {
    if (l.kind === ' ') out.push(lines[at + offset++]!);
    else if (l.kind === '-') offset += 1;
    else if (l.kind === '+') out.push(tier === 2 ? reindent(l.text, filePrefix, patchPrefix) : l.text);
  }
  return out;
}

function bodyLines(lines: string[]): BodyLine[] {
  return lines.map((l) => l === '' ? { kind: ' ', text: '' } : { kind: l[0] as BodyLine['kind'], text: l.slice(1) });
}

function noFinalBreak(body: BodyLine[], plusOnly = false): boolean {
  for (let i = body.length - 1; i >= 0; i -= 1) {
    if (body[i]!.kind === '+' || (!plusOnly && body[i]!.kind === ' ')) return body[i + 1]?.kind === '\\';
  }
  return false;
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: { old: string; new: string }[] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  move(old: string, next: string, text: string): void {
    this.now.set(old, null);
    this.now.set(next, text);
    this.moves.push({ old, new: next });
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

interface UnifiedHunk {
  start: number;
  body: BodyLine[];
}

interface NamedPath {
  path: string | null;
  order: number;
}

interface UnifiedSection {
  gitOld: NamedPath;
  gitNew: NamedPath;
  pair: { old: NamedPath; new: NamedPath } | null;
  renameOld?: NamedPath;
  renameNew?: NamedPath;
  create: boolean;
  delete: boolean;
  hunks: UnifiedHunk[];
}

function unifiedPath(line: string): string | null {
  const p = line.slice(4).split('\t', 1)[0]!.trim();
  return p === '/dev/null' ? null : p.replace(/^[ab]\//, '');
}

function unifiedEdit(section: UnifiedSection, strict: boolean): Edit {
  const oldName = section.pair !== null ? section.pair.old : section.renameOld ?? section.gitOld;
  const nextName = section.pair !== null ? section.pair.new : section.renameNew ?? section.gitNew;
  const old = oldName.path;
  const next = nextName.path;
  const paths = [oldName, nextName].sort((a, b) => a.order - b.order).map((p) => p.path);
  return (tree) => {
    safePaths(paths);
    if (section.create || old === null) {
      const p = next ?? '';
      safePaths([p]);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const lines: string[] = [];
      let final = true;
      for (const h of section.hunks) {
        const plus = h.body.filter((l) => l.kind === '+').map((l) => l.text);
        lines.push(...plus);
        if (plus.length > 0) final = !noFinalBreak(h.body, true);
      }
      tree.now.set(p, lines.length === 0 ? '' : lines.join('\n') + (final ? '\n' : ''));
      return;
    }
    if (section.delete || next === null) {
      if (tree.get(old) === null) throw new Fail('missing', old);
      tree.now.set(old, null);
      return;
    }
    const before = tree.get(old);
    if (before === null) throw new Fail('missing', old);
    if (old !== next && tree.get(next) !== null) throw new Fail('exists', next);
    const file = new LineFile(before);
    let delta = 0;
    for (const h of section.hunks) {
      const oldBlock = oldLines(h.body);
      let at: number;
      let tier = 0;
      if (oldBlock.length === 0) at = Math.max(0, Math.min(file.lines.length, h.start + delta));
      else {
        const matches = matchLines(file.lines, oldBlock, strict);
        if (matches === null) throw new Fail('no-match', old);
        tier = matches.tier;
        const target = h.start - 1 + delta;
        at = matches.positions[0]!;
        for (const p of matches.positions) if (Math.abs(p - target) < Math.abs(at - target)) at = p;
      }
      const atEnd = at + oldBlock.length === file.lines.length;
      const add = replacementLines(file.lines, h.body, at, tier);
      file.lines.splice(at, oldBlock.length, ...add);
      if (atEnd) file.final = !noFinalBreak(h.body);
      delta += add.length - oldBlock.length;
    }
    if (old === next) tree.now.set(old, file.text());
    else tree.move(old, next, file.text());
  };
}

/** Parse every section before the run loop is allowed to inspect the tree. */
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UnifiedSection[] = [];
  let section: UnifiedSection | null = null;
  const newSection = (old: NamedPath, next: NamedPath): UnifiedSection => {
    const s: UnifiedSection = { gitOld: old, gitNew: next, pair: null, create: false, delete: false, hunks: [] };
    sections.push(s);
    section = s;
    return s;
  };
  const pairAt = (i: number): boolean => lines[i]?.startsWith('--- ') === true && lines[i + 1]?.startsWith('+++ ') === true;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      newSection({ path: m[1]!, order: 2 * i }, { path: m[2]!, order: 2 * i + 1 });
      i += 1;
    } else if (pairAt(i)) {
      const old = { path: unifiedPath(l), order: 2 * i };
      const next = { path: unifiedPath(lines[i + 1]!), order: 2 * (i + 1) };
      if (section === null || section.hunks.length > 0 || section.pair !== null) newSection(old, next);
      section!.pair = { old, new: next };
      i += 2;
    } else if (l.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@.*$/.exec(l);
      if (m === null || section === null) throw new Exit2(`error: parse ${i + 1}`);
      i += 1;
      const start = i;
      while (i < lines.length && !lines[i]!.startsWith('diff --git ') && !pairAt(i) && (lines[i] === '' || /^[ +\-\\]/.test(lines[i]!))) i += 1;
      let end = i;
      while (end > start && lines[end - 1] === '') end -= 1;
      section.hunks.push({ start: Number(m[1]), body: bodyLines(lines.slice(start, end)) });
    } else {
      if (section !== null && section.hunks.length === 0) {
        if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
        if (l.startsWith('rename from ')) {
          section.renameOld = { path: l.slice(12).trim(), order: 2 * i };
        } else if (l.startsWith('rename to ')) {
          section.renameNew = { path: l.slice(10).trim(), order: 2 * i };
        } else if (l.startsWith('new file mode')) section.create = true;
        else if (l.startsWith('deleted file mode')) section.delete = true;
      }
      i += 1;
    }
  }
  return sections.map((s) => unifiedEdit(s, strict));
}

function searchReplaceEdit(path: string, old: string[], next: string[], strict: boolean): Edit {
  return (tree) => {
    safePaths([path]);
    const before = tree.get(path);
    if (old.length === 0) {
      if (before !== null) throw new Fail('exists', path);
      tree.now.set(path, next.length === 0 ? '' : next.join('\n') + '\n');
      return;
    }
    if (before === null) throw new Fail('missing', path);
    const file = new LineFile(before);
    const matches = matchLines(file.lines, old, strict);
    if (matches === null) throw new Fail('no-match', path);
    if (matches.positions.length > 1) throw new Fail('ambiguous', path);
    const at = matches.positions[0]!;
    const filePrefix = leading(file.lines[at]!);
    const patchPrefix = leading(old[0]!);
    const add = matches.tier === 2 ? next.map((l) => reindent(l, filePrefix, patchPrefix)) : next;
    file.lines.splice(at, old.length, ...add);
    tree.now.set(path, file.text());
  };
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let previousPath: string | null = null;
  let previousEnd = -1;
  const marker = (i: number, text: string): boolean => lines[i]?.trimEnd() === text;
  let i = 0;
  while (i < lines.length) {
    if (!marker(i, '<<<<<<< SEARCH')) {
      i += 1;
      continue;
    }
    const search = i;
    let path: string | null = null;
    for (let j = search - 1; j > previousEnd; j -= 1) {
      const l = lines[j]!.trim();
      if (l !== '' && !l.startsWith('```')) {
        path = l;
        break;
      }
    }
    path ??= previousPath;
    if (path === null) throw new Exit2(`error: parse ${search + 1}`);
    let separator = search + 1;
    while (separator < lines.length && !marker(separator, '=======')) separator += 1;
    let end = separator + 1;
    while (end < lines.length && !marker(end, '>>>>>>> REPLACE')) end += 1;
    if (separator === lines.length || end >= lines.length) throw new Exit2(`error: parse ${search + 1}`);
    edits.push(searchReplaceEdit(path, lines.slice(search + 1, separator), lines.slice(separator + 1, end), strict));
    previousPath = path;
    previousEnd = end;
    i = end + 1;
  }
  return edits;
}

interface V4AChunk {
  anchor: string | null;
  end: boolean;
  body: BodyLine[];
}

interface V4ASection {
  kind: 'Add' | 'Delete' | 'Update';
  path: string;
  next?: string;
  lines: string[];
  chunks: V4AChunk[];
}

function v4aEdit(section: V4ASection, strict: boolean): Edit {
  const { path, next } = section;
  return (tree) => {
    safePaths(next === undefined ? [path] : [path, next]);
    const before = tree.get(path);
    if (section.kind === 'Add') {
      if (before !== null) throw new Fail('exists', path);
      tree.now.set(path, section.lines.length === 0 ? '' : section.lines.join('\n') + '\n');
      return;
    }
    if (before === null) throw new Fail('missing', path);
    if (section.kind === 'Delete') {
      tree.now.set(path, null);
      return;
    }
    if (next !== undefined && tree.get(next) !== null) throw new Fail('exists', next);
    const file = new LineFile(before);
    let cursor = 0;
    for (const chunk of section.chunks) {
      if (chunk.anchor !== null) {
        const anchor = matchLines(file.lines, [chunk.anchor], strict, cursor);
        if (anchor === null) throw new Fail('no-match', path);
        cursor = anchor.positions[0]! + 1;
      }
      const old = oldLines(chunk.body);
      let at = chunk.end ? file.lines.length : cursor;
      let tier = 0;
      if (old.length > 0) {
        const matches = matchLines(file.lines, old, strict, cursor, chunk.end);
        if (matches === null) throw new Fail('no-match', path);
        at = matches.positions[0]!;
        tier = matches.tier;
      }
      const add = replacementLines(file.lines, chunk.body, at, tier);
      file.lines.splice(at, old.length, ...add);
      cursor = at + add.length;
    }
    if (next === undefined) tree.now.set(path, file.text());
    else tree.move(path, next, file.text());
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last > first && blank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  const header = (l: string): RegExpExecArray | null => /^\*\*\* (Add|Delete|Update) File: (.*)$/.exec(l);
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i += 1;
      continue;
    }
    const m = header(lines[i]!);
    if (m === null) throw new Exit2(`error: parse ${i + 1}`);
    const sectionLine = i;
    const section: V4ASection = { kind: m[1] as V4ASection['kind'], path: m[2]!.trim(), lines: [], chunks: [] };
    i += 1;
    const start = i;
    while (i < last && header(lines[i]!) === null) i += 1;
    let end = i;
    while (end > start && blank(lines[end - 1]!)) end -= 1;
    if (section.kind === 'Add') {
      for (let j = start; j < end; j += 1) {
        const l = lines[j]!;
        if (l !== '' && !l.startsWith('+')) throw new Exit2(`error: parse ${j + 1}`);
        section.lines.push(l === '' ? '' : l.slice(1));
      }
    } else if (section.kind === 'Delete') {
      if (end > start) throw new Exit2(`error: parse ${start + 1}`);
    } else {
      let j = start;
      if (j < end && lines[j]!.startsWith('*** Move to: ')) {
        section.next = lines[j]!.slice(13).trim();
        j += 1;
      }
      let chunk: V4AChunk | null = null;
      for (; j < end; j += 1) {
        const l = lines[j]!;
        if (l.startsWith('@@')) {
          chunk = { anchor: l.slice(2).trim() || null, end: false, body: [] };
          section.chunks.push(chunk);
        } else if (l === '*** End of File') {
          if (chunk === null) throw new Exit2(`error: parse ${j + 1}`);
          chunk.end = true;
          chunk = null;
        } else if (l === '' || /^[ +\-]/.test(l)) {
          if (chunk === null) {
            if (section.chunks.length > 0) throw new Exit2(`error: parse ${j + 1}`);
            chunk = { anchor: null, end: false, body: [] };
            section.chunks.push(chunk);
          }
          chunk.body.push(l === '' ? { kind: ' ', text: '' } : { kind: l[0] as BodyLine['kind'], text: l.slice(1) });
        } else throw new Exit2(`error: parse ${j + 1}`);
      }
      if (section.chunks.length === 0 && section.next === undefined) throw new Exit2(`error: parse ${sectionLine + 1}`);
    }
    edits.push(v4aEdit(section, strict));
  }
  return edits;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? unifiedEdits(lines, strict) : kind === 'search-replace' ? searchReplaceEdits(lines, strict) : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed = new Map<string, string | null>();
  for (const [p, now] of tree.now) if (tree.original(p) !== now) changed.set(p, now);
  const rows: { path: string; line: string }[] = [];
  const paired = new Set<string>();
  for (const move of tree.moves) {
    if (paired.has(move.old) || paired.has(move.new)) continue;
    if (tree.original(move.old) !== null && tree.get(move.old) === null && tree.original(move.new) === null && tree.get(move.new) !== null) {
      rows.push({ path: move.new, line: `R ${move.old} -> ${move.new}` });
      paired.add(move.old);
      paired.add(move.new);
    }
  }
  for (const [p, now] of changed) {
    if (!paired.has(p)) rows.push({ path: p, line: `${tree.original(p) === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  const byteOrder = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
  rows.sort((a, b) => byteOrder(a.path, b.path));
  for (const p of [...changed.keys()].sort(byteOrder)) {
    const now = changed.get(p)!;
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
