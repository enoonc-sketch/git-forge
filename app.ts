// git-forge: a GitHub-compatible git forge — git smart HTTP (protocol v2 + v0),
// REST v3, GraphQL v4 and MCP — on one in-memory store, Node stdlib only.
//
// The scenario the suite drives this with is fixed (kit wire.ts SCENARIO_SEED):
// viewer adaiversen (id 1000), teammate quinnkeller, stranger olgabauer,
// org faint-meadow-org, default branch main, the six default labels below.
// No wall clock and no randomness anywhere in a response: every timestamp is
// the fixed FIXED_NOW, every id is a counter or a hash, so a replay is byte
// identical to the live run.

import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { deflateSync, inflateSync } from 'node:zlib';

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const STRANGER_LOGIN = 'olgabauer';
export const DEFAULT_BRANCH = 'main';
export const DEFAULT_LABELS: readonly string[] = Object.freeze([
  'bug',
  'enhancement',
  'documentation',
  'question',
  'good first issue',
  'help wanted',
]);
/** The one timestamp every created_at/updated_at/merged_at carries. */
export const FIXED_NOW = '2026-11-16T00:00:00Z';
export const FIXED_EPOCH = 1700000000;
export const SERVER_IDENTITY = 'ada iversen <adaiversen@example.invalid>';
export const ZERO_OID = '0'.repeat(40);
const EMPTY_SET: ReadonlySet<string> = new Set();
export const PKT_LINE_MAX = 65520;
export const FORGE_NAME = 'git-forge';
export const FORGE_VERSION = '0.1.0';

const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const SHOP_TOKEN = TOKEN === '' ? 'test-token' : TOKEN;

// ---------------------------------------------------------------------------
// git primitives (ported from the kit's git-client.ts wire format)
// ---------------------------------------------------------------------------

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const HEX40 = /^[0-9a-f]{40}$/;

export function isOid(value: string): boolean {
  return HEX40.test(value);
}

export function hashObject(type: ObjType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0) throw new Error('tree entry has no name terminator');
    if (nul + 21 > data.length) throw new Error('tree entry has a truncated object id');
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headerText = data.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

export function parseTag(data: Buffer): { object: string; type: ObjType; tag: string; tagger: string; message: string } {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  const type = headers.get('type') ?? '';
  return {
    object: headers.get('object') ?? '',
    type: (type === 'commit' || type === 'tree' || type === 'blob' || type === 'tag' ? type : 'commit') as ObjType,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

export function buildCommit(fields: {
  tree: string;
  parents?: readonly string[];
  message: string;
  author?: string;
  committer?: string;
  timestamp?: number;
}): Buffer {
  const timestamp = fields.timestamp ?? FIXED_EPOCH;
  const who = `${fields.author ?? SERVER_IDENTITY} ${timestamp} +0000`;
  const committer = `${fields.committer ?? SERVER_IDENTITY} ${timestamp} +0000`;
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${who}`, `committer ${committer}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

/** Every object reachable from `roots`: commit -> tree + parents, tree -> entries, tag -> target. */
export function collectReachable(
  roots: Iterable<string>,
  lookup: (oid: string) => GitObject | undefined,
  allowMissing = false,
  // Commits in this set are included with their trees, but their parents are
  // NOT traversed: they are shallow boundaries the other side already holds
  // as shallow commits (their history is not held).
  stopAtParents: ReadonlySet<string> = EMPTY_SET,
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isOid(root)) queue.push(root);
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object) {
      if (allowMissing) continue;
      throw new Error(`object ${oid} is missing from the store`);
    }
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      if (!stopAtParents.has(oid)) {
        for (const parent of commit.parents) queue.push(parent);
      }
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        queue.push(entry.oid);
      }
    }
  }
  return seen;
}

// --- pkt-lines ---

export function encodePktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > PKT_LINE_MAX - 4) throw new Error('pkt-line payload over maximum');
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export const pktFlush = (): Buffer => Buffer.from('0000', 'ascii');
export const pktDelim = (): Buffer => Buffer.from('0001', 'ascii');

export type Pkt = { kind: 'flush' | 'delim' | 'data'; payload?: Buffer };

/** Decode a whole buffer of pkt-lines; `rest` is the bytes after the final flush (the pack).
 * With `all`, flush packets do not stop decoding (a v0 fetch has two sections). */
export function decodePktLines(bytes: Buffer, all = false): { packets: Pkt[]; rest: Buffer } {
  const packets: Pkt[] = [];
  let offset = 0;
  while (offset + 4 <= bytes.length) {
    const head = bytes.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) break;
    const length = Number.parseInt(head, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      if (!all) break;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      offset += 4;
      continue;
    }
    if (length < 4 || length > PKT_LINE_MAX || offset + length > bytes.length) break;
    packets.push({ kind: 'data', payload: bytes.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, rest: bytes.subarray(offset) };
}

// --- packfiles ---

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start]!;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buffer[offset++]!;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start]!;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buffer[offset++]!;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset++]!;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++]!;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += delta[offset++]! * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += delta[offset++]! * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

export interface PackReadResult {
  objects: Map<string, GitObject>;
  deltaCount: number;
}

/** Read a packfile (version 2), resolving OFS/REF deltas; bases may come from `resolveBase`. */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): PackReadResult {
  const buffer = pack;
  if (buffer.length < 32) throw new Error(`pack is ${buffer.length} bytes, too short`);
  if (buffer.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = buffer.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = buffer.readUInt32BE(8);
  const trailerStart = buffer.length - 20;
  const trailer = buffer.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(buffer.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack trailer checksum mismatch');

  interface RawEntry {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    resolvedType?: ObjType;
    resolved?: Buffer;
    oid?: string;
  }
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(buffer, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(buffer, offset);
      offset = base.next;
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      entry.baseOid = buffer.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(buffer.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) throw new Error('pack entry size mismatch after inflate');
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error('pack has stray bytes before its trailer');

  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, RawEntry>();
  const resolving = new Set<number>();
  let deltaCount = 0;
  const resolve = (entry: RawEntry): { type: ObjType; data: Buffer; oid: string } => {
    if (entry.resolved && entry.resolvedType && entry.oid) {
      return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    }
    if (resolving.has(entry.offset)) throw new Error('delta cycle in pack');
    resolving.add(entry.offset);
    let type: ObjType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error('ofs-delta base is not in the pack');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const baseEntry = resolvedByOid.get(entry.baseOid!);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = resolveBase?.(entry.baseOid!);
        if (!external) throw new Error(`ref-delta base ${entry.baseOid} is not available`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode]!;
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (entry.typeCode === 6 || entry.typeCode === 7) deltaCount += 1;
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return { objects, deltaCount };
}

function writePackObjectHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile from plain objects (no deltas); trailer is SHA-1 over everything before it. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// ---------------------------------------------------------------------------
// the store: one process, in-memory, shared by git, REST, GraphQL and MCP
// ---------------------------------------------------------------------------

export interface Comment {
  id: number;
  body: string;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  seq: number;
}

export interface PullFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

export interface Pull {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  comments: Comment[];
  seq: number;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Issue[];
  pulls: Pull[];
  labels: Map<string, { name: string; color: string; description: string }>;
  nextNumber: number;
  nextComment: number;
  seq: number;
}

const repos = new Map<string, Repo>(); // key `${owner}/${name}`
let nextRepoId = 1;
let nextRepoSeq = 1;
let nextGlobalSeq = 1;
let requestCounter = 1;

export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

export function getRepo(owner: string, name: string): Repo | undefined {
  return repos.get(repoKey(owner, name));
}

export function createRepoRecord(name: string, priv: boolean, description: string): Repo {
  const repo: Repo = {
    id: nextRepoId,
    owner: VIEWER_LOGIN,
    name,
    description,
    private: priv,
    defaultBranch: DEFAULT_BRANCH,
    objects: new Map(),
    refs: new Map(),
    issues: [],
    pulls: [],
    labels: new Map(),
    nextNumber: 1,
    nextComment: 1,
    seq: nextRepoSeq,
  };
  nextRepoId += 1;
  nextRepoSeq += 1;
  for (const label of DEFAULT_LABELS) {
    repo.labels.set(label, { name: label, color: 'ededed', description: '' });
  }
  repos.set(repoKey(VIEWER_LOGIN, name), repo);
  return repo;
}

export function deleteRepoRecord(repo: Repo): void {
  repos.delete(repoKey(repo.owner, repo.name));
}

export function listViewerRepos(): Repo[] {
  return [...repos.values()]
    .filter((repo) => repo.owner === VIEWER_LOGIN)
    .sort((a, b) => a.seq - b.seq);
}

export function lookupObject(repo: Repo, oid: string): GitObject | undefined {
  return repo.objects.get(oid);
}

export function putObject(repo: Repo, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

// --- trees ---

/** The tree oid at `path`'s parent, walking down from `rootTree` ('' when missing). */
export function flattenTree(repo: Repo, treeOid: string): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (oid: string, prefix: string): void => {
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, '');
  return out;
}

export function treeAtCommit(repo: Repo, commitOid: string): string {
  const object = repo.objects.get(commitOid);
  if (!object || object.type !== 'commit') return '';
  return parseCommit(object.data).tree;
}

/** Build a new tree from `baseTree` ('' for none) with `path` set to `blobOid`. */
export function setPathInTree(repo: Repo, baseTree: string, path: string, blobOid: string | null): string {
  const segments = path.split('/').filter((part) => part !== '');
  const build = (treeOid: string, depth: number): string => {
    const entries = new Map<string, TreeEntry>();
    if (treeOid !== '') {
      const object = repo.objects.get(treeOid);
      if (object && object.type === 'tree') {
        for (const entry of parseTree(object.data)) entries.set(entry.name, entry);
      }
    }
    const name = segments[depth]!;
    if (depth === segments.length - 1) {
      if (blobOid === null) entries.delete(name);
      else entries.set(name, { mode: '100644', name, oid: blobOid });
    } else {
      const child = entries.get(name);
      const childOid = child && child.mode === '40000' ? child.oid : '';
      const next = build(childOid, depth + 1);
      const childObject = repo.objects.get(next);
      const empty = childObject && childObject.type === 'tree' && parseTree(childObject.data).length === 0;
      if (empty) entries.delete(name);
      else entries.set(name, { mode: '40000', name, oid: next });
    }
    const data = buildTree([...entries.values()]);
    return putObject(repo, 'tree', data);
  };
  return build(baseTree, 0);
}

/** Commit `path` -> `content` on `branch` (creating the branch from the default tip when new). */
export function commitFile(
  repo: Repo,
  branch: string,
  path: string,
  content: Buffer,
  message: string,
): { commitSha: string; contentSha: string } {
  const ref = `refs/heads/${branch}`;
  let parent = repo.refs.get(ref);
  if (parent === undefined && branch !== repo.defaultBranch) parent = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const baseTree = parent !== undefined ? treeAtCommit(repo, parent) : '';
  const blobOid = putObject(repo, 'blob', content);
  const treeOid = setPathInTree(repo, baseTree, path, blobOid);
  const commitData = buildCommit({
    tree: treeOid,
    parents: parent !== undefined ? [parent] : [],
    message: message.endsWith('\n') ? message : `${message}\n`,
  });
  const commitSha = putObject(repo, 'commit', commitData);
  repo.refs.set(ref, commitSha);
  return { commitSha, contentSha: blobOid };
}

/** Delete `path` on `branch`, committing the removal. */
export function deleteFile(repo: Repo, branch: string, path: string, message: string): string {
  const ref = `refs/heads/${branch}`;
  const parent = repo.refs.get(ref);
  if (parent === undefined) throw new Error('branch has no commits');
  const baseTree = treeAtCommit(repo, parent);
  const treeOid = setPathInTree(repo, baseTree, path, null);
  const commitData = buildCommit({
    tree: treeOid,
    parents: [parent],
    message: message.endsWith('\n') ? message : `${message}\n`,
  });
  const commitSha = putObject(repo, 'commit', commitData);
  repo.refs.set(ref, commitSha);
  return commitSha;
}

/** Commits reachable from `tip`, newest first (depth-first, parents in order). */
export function commitsFrom(repo: Repo, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (oid: string): void => {
    if (seen.has(oid)) return;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') return;
    seen.add(oid);
    out.push(oid);
    for (const parent of parseCommit(object.data).parents) visit(parent);
  };
  visit(tip);
  return out;
}

/** The first common ancestor of two commits, or null. */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const fromA = new Set(commitsFrom(repo, a));
  for (const oid of commitsFrom(repo, b)) if (fromA.has(oid)) return oid;
  return null;
}

/** True when `ancestor` is reachable from `tip` (or equal). */
export function isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  return commitsFrom(repo, tip).includes(ancestor);
}

// --- line diff (for pull file counts) ---

export function diffLines(oldText: string, newText: string): { additions: number; deletions: number } {
  const splitLines = (text: string): string[] => {
    if (text === '') return [];
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop(); // a trailing newline ends a line, it is not one
    return lines;
  };
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  // LCS on lines (files here are small).
  const m = oldLines.length;
  const n = newLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i]![j] = oldLines[i] === newLines[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  return { additions: n - dp[0]![0]!, deletions: m - dp[0]![0]! };
}

/** Files changed between the merge-base of `head` and `base` and the head tip. */
export function pullFiles(repo: Repo, pull: Pull): PullFile[] {
  const headTip = repo.refs.get(`refs/heads/${pull.head}`) ?? pull.headSha;
  const baseTip = repo.refs.get(`refs/heads/${pull.base}`) ?? pull.baseSha;
  const base = mergeBase(repo, headTip, baseTip);
  const baseTree = base !== null ? treeAtCommit(repo, base) : '';
  const headTree = treeAtCommit(repo, headTip);
  const baseFiles = flattenTree(repo, baseTree);
  const headFiles = flattenTree(repo, headTree);
  const files: PullFile[] = [];
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of [...paths].sort()) {
    const before = baseFiles.get(path);
    const after = headFiles.get(path);
    if (before && !after) {
      const oldText = repo.objects.get(before.oid)?.data.toString('utf8') ?? '';
      const counts = diffLines(oldText, '');
      files.push({ filename: path, status: 'removed', additions: 0, deletions: counts.deletions, changes: counts.deletions });
    } else if (!before && after) {
      const newText = repo.objects.get(after.oid)?.data.toString('utf8') ?? '';
      const counts = diffLines('', newText);
      files.push({ filename: path, status: 'added', additions: counts.additions, deletions: 0, changes: counts.additions });
    } else if (before && after && before.oid !== after.oid) {
      const oldText = repo.objects.get(before.oid)?.data.toString('utf8') ?? '';
      const newText = repo.objects.get(after.oid)?.data.toString('utf8') ?? '';
      const counts = diffLines(oldText, newText);
      files.push({
        filename: path,
        status: 'modified',
        additions: counts.additions,
        deletions: counts.deletions,
        changes: counts.additions + counts.deletions,
      });
    }
  }
  return files;
}

/** 'MERGEABLE' | 'CONFLICTING' — the three-way test a squash-apply runs. */
export function pullMergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' {
  if (pull.merged) return 'MERGEABLE';
  const headTip = repo.refs.get(`refs/heads/${pull.head}`) ?? pull.headSha;
  const baseTip = repo.refs.get(`refs/heads/${pull.base}`) ?? pull.baseSha;
  const base = mergeBase(repo, headTip, baseTip);
  if (base === null) return 'CONFLICTING';
  const baseFiles = flattenTree(repo, treeAtCommit(repo, base));
  const headFiles = flattenTree(repo, treeAtCommit(repo, headTip));
  const tipFiles = flattenTree(repo, treeAtCommit(repo, baseTip));
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys(), ...tipFiles.keys()]);
  for (const path of paths) {
    const b = baseFiles.get(path)?.oid ?? null;
    const h = headFiles.get(path)?.oid ?? null;
    const t = tipFiles.get(path)?.oid ?? null;
    if (h === t) continue;
    if (b === h) continue;
    if (b === t) continue;
    return 'CONFLICTING';
  }
  return 'MERGEABLE';
}

/** Squash-merge `pull` onto its base tip; null when the three-way apply conflicts. */
export function squashMerge(repo: Repo, pull: Pull): string | null {
  if (pullMergeable(repo, pull) === 'CONFLICTING') return null;
  const headTip = repo.refs.get(`refs/heads/${pull.head}`) ?? pull.headSha;
  const baseTip = repo.refs.get(`refs/heads/${pull.base}`) ?? pull.baseSha;
  const base = mergeBase(repo, headTip, baseTip);
  const baseFiles = base !== null ? flattenTree(repo, treeAtCommit(repo, base)) : new Map();
  const headFiles = flattenTree(repo, treeAtCommit(repo, headTip));
  const tipFiles = flattenTree(repo, treeAtCommit(repo, baseTip));
  let treeOid = treeAtCommit(repo, baseTip);
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of paths) {
    const b = baseFiles.get(path)?.oid ?? null;
    const h = headFiles.get(path)?.oid ?? null;
    const t = tipFiles.get(path)?.oid ?? null;
    if (h === t) continue;
    if (b === h) continue; // head unchanged: keep tip
    // b === t (or b null): take head's version (h may be null = deleted)
    treeOid = setPathInTree(repo, treeOid, path, h);
  }
  const commitData = buildCommit({
    tree: treeOid,
    parents: [baseTip],
    message: `${pull.title}\n`,
  });
  const mergeSha = putObject(repo, 'commit', commitData);
  repo.refs.set(`refs/heads/${pull.base}`, mergeSha);
  pull.merged = true;
  pull.mergedAt = FIXED_NOW;
  pull.mergeCommitSha = mergeSha;
  pull.state = 'closed';
  return mergeSha;
}

// --- global ids (opaque, stable, deterministic) ---

function b64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

function unb64url(text: string): string {
  return Buffer.from(text, 'base64url').toString('utf8');
}

export function repoGlobalId(repo: Repo): string {
  return b64url(`R:${repo.owner}/${repo.name}`);
}

export function issueGlobalId(repo: Repo, issue: Issue): string {
  return b64url(`I:${repo.owner}/${repo.name}:${issue.number}`);
}

export function pullGlobalId(repo: Repo, pull: Pull): string {
  return b64url(`P:${repo.owner}/${repo.name}:${pull.number}`);
}

export function commentGlobalId(repo: Repo, issue: { number: number }, comment: Comment): string {
  return b64url(`C:${repo.owner}/${repo.name}:${issue.number}:${comment.id}`);
}

export type GlobalId =
  | { kind: 'R'; owner: string; name: string }
  | { kind: 'I'; owner: string; name: string; number: number }
  | { kind: 'P'; owner: string; name: string; number: number }
  | { kind: 'C'; owner: string; name: string; number: number; comment: number };

export function decodeGlobalId(id: string): GlobalId | null {
  try {
    const text = unb64url(id);
    const parts = text.split(':');
    if (parts[0] === 'R' && parts.length === 2) {
      const [owner, name] = parts[1]!.split('/');
      if (owner && name) return { kind: 'R', owner, name };
    }
    if (parts[0] === 'I' && parts.length === 3) {
      const [owner, name] = parts[1]!.split('/');
      const number = Number(parts[2]);
      if (owner && name && Number.isInteger(number)) return { kind: 'I', owner, name, number };
    }
    if (parts[0] === 'P' && parts.length === 3) {
      const [owner, name] = parts[1]!.split('/');
      const number = Number(parts[2]);
      if (owner && name && Number.isInteger(number)) return { kind: 'P', owner, name, number };
    }
    if (parts[0] === 'C' && parts.length === 4) {
      const [owner, name] = parts[1]!.split('/');
      const number = Number(parts[2]);
      const comment = Number(parts[3]);
      if (owner && name && Number.isInteger(number) && Number.isInteger(comment)) {
        return { kind: 'C', owner, name, number, comment };
      }
    }
  } catch {
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

const JSON_TYPE = 'application/json; charset=utf-8';

function nextRequestId(): string {
  const id = requestCounter;
  requestCounter += 1;
  return `req-${id}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = status === 204 ? '' : `${JSON.stringify(body)}\n`;
  const headers: Record<string, string> = {
    'content-type': JSON_TYPE,
    'x-github-request-id': nextRequestId(),
    ...extra,
  };
  if (text !== '') headers['content-length'] = String(Buffer.byteLength(text));
  res.writeHead(status, headers);
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': String(body.length),
    'x-github-request-id': nextRequestId(),
  });
  res.end(body);
}

function errJson(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > 64 * 1024 * 1024) throw new Error('request body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/** Parse a JSON body: empty -> {}; malformed non-empty -> null (caller answers 400). */
function parseJsonBody(body: Buffer): unknown {
  const text = body.toString('utf8').trim();
  if (text === '') return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization ?? '';
  const match = /^Bearer (.+)$/.exec(header);
  return match ? match[1]! : null;
}

function authed(req: IncomingMessage): boolean {
  return bearerToken(req) === SHOP_TOKEN;
}

function urlOf(req: IncomingMessage): URL {
  try {
    return new URL(req.url ?? '/', 'http://entry');
  } catch {
    return new URL('/', 'http://entry');
  }
}

function pageParams(url: URL): { page: number; perPage: number } {
  const page = Math.max(1, Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
  const perPage = Math.min(100, Math.max(1, Number.parseInt(url.searchParams.get('per_page') ?? '30', 10) || 30));
  return { page, perPage };
}

/** Slice `items` to the requested page and build a GitHub `Link` header ('' when one page). */
function paginate<T>(req: IncomingMessage, url: URL, items: readonly T[]): { page: T[]; link: string } {
  const { page, perPage } = pageParams(url);
  const total = items.length;
  const start = (page - 1) * perPage;
  const pageItems = items.slice(start, start + perPage);
  const host = req.headers.host ?? '127.0.0.1';
  const base = `http://${host}${url.pathname}`;
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  const linkFor = (p: number): string => `<${base}?page=${p}&per_page=${perPage}>`;
  const parts: string[] = [];
  if (page < lastPage) parts.push(`${linkFor(page + 1)}; rel="next"`);
  if (lastPage > 1) parts.push(`${linkFor(lastPage)}; rel="last"`);
  return { page: [...pageItems], link: parts.join(', ') };
}

function linkHeader(link: string): Record<string, string> {
  return link === '' ? {} : { link };
}

// --- REST shapes ---

function userJson(): Record<string, unknown> {
  return {
    login: VIEWER_LOGIN,
    id: VIEWER_ID,
    node_id: b64url(`U:${VIEWER_LOGIN}`),
    avatar_url: '',
    type: 'User',
    site_admin: false,
    name: VIEWER_NAME,
    email: VIEWER_EMAIL,
    html_url: `https://example.invalid/${VIEWER_LOGIN}`,
    url: '/api/v3/user',
  };
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: repoGlobalId(repo),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER_ID : 1002, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    created_at: FIXED_NOW,
    updated_at: FIXED_NOW,
    pushed_at: FIXED_NOW,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: repo.id * 100000 + issue.number,
    node_id: issueGlobalId(repo, issue),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? 'ededed', description: label?.description ?? '' };
    }),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    assignees: [],
    comments: issue.comments.length,
    created_at: FIXED_NOW,
    updated_at: FIXED_NOW,
    closed_at: issue.state === 'closed' ? FIXED_NOW : null,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  const headSha = repo.refs.get(`refs/heads/${pull.head}`) ?? pull.headSha;
  const baseSha = repo.refs.get(`refs/heads/${pull.base}`) ?? pull.baseSha;
  return {
    id: repo.id * 100000 + pull.number,
    node_id: pullGlobalId(repo, pull),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    head: { ref: pull.head, sha: headSha, label: `${repo.owner}:${pull.head}` },
    base: { ref: pull.base, sha: baseSha, label: `${repo.owner}:${pull.base}` },
    merged: pull.merged,
    mergeable: pullMergeable(repo, pull) === 'MERGEABLE',
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    assignees: [],
    created_at: FIXED_NOW,
    updated_at: FIXED_NOW,
    closed_at: pull.state === 'closed' ? FIXED_NOW : null,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

/** Shared issue creation (REST + GraphQL + MCP): 422 on an unknown label. */
export function createIssueIn(repo: Repo, title: string, body: string, labels: readonly string[]): Issue | { error: string } {
  for (const label of labels) {
    if (!repo.labels.has(label)) return { error: `Label '${label}' does not exist` };
  }
  const issue: Issue = {
    number: repo.nextNumber,
    title,
    body,
    state: 'open',
    labels: [...labels],
    comments: [],
    seq: nextGlobalSeq,
  };
  repo.nextNumber += 1;
  nextGlobalSeq += 1;
  repo.issues.push(issue);
  return issue;
}

/** Shared pull-request creation: 422 on a missing branch or a duplicate open PR. */
export function createPullIn(
  repo: Repo,
  title: string,
  body: string,
  head: string,
  base: string,
): Pull | { error: string } {
  const headTip = repo.refs.get(`refs/heads/${head}`);
  const baseTip = repo.refs.get(`refs/heads/${base}`);
  if (headTip === undefined) return { error: `Head branch '${head}' does not exist` };
  if (baseTip === undefined) return { error: `Base branch '${base}' does not exist` };
  for (const existing of repo.pulls) {
    if (existing.state === 'open' && existing.head === head && existing.base === base) {
      return { error: 'A pull request already exists for this head and base' };
    }
  }
  const pull: Pull = {
    number: repo.nextNumber,
    title,
    body,
    state: 'open',
    head,
    base,
    headSha: headTip,
    baseSha: baseTip,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    comments: [],
    seq: nextGlobalSeq,
  };
  repo.nextNumber += 1;
  nextGlobalSeq += 1;
  repo.pulls.push(pull);
  return pull;
}

// --- REST router ---

/** Resolve `/repos/{owner}/{repo}` from path segments; 404s (never 403) on a foreign owner. */
function resolveRepo(res: ServerResponse, owner: string, name: string): Repo | null {
  const repo = getRepo(owner, name);
  if (repo === undefined) {
    errJson(res, 404, 'Not Found');
    return null;
  }
  return repo;
}

async function handleRest(req: IncomingMessage, res: ServerResponse, url: URL, body: Buffer): Promise<boolean> {
  const method = req.method ?? 'GET';
  const path = url.pathname;
  const scopes = { 'x-oauth-scopes': 'repo, read:org, user' };
  if (!authed(req)) {
    errJson(res, 401, 'Requires authentication');
    return true;
  }
  // The API root.
  if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, scopes);
    return true;
  }
  if (method === 'GET' && path === '/api/v3/meta') {
    sendJson(res, 200, { installed_version: FORGE_VERSION, verifiable_password_authentication: true }, scopes);
    return true;
  }
  if (method === 'GET' && path === '/api/v3/user') {
    sendJson(res, 200, userJson(), scopes);
    return true;
  }
  // POST /user/repos
  if (path === '/api/v3/user/repos' && method === 'POST') {
    const parsed = parseJsonBody(body);
    if (parsed === null) {
      errJson(res, 400, 'Problems parsing JSON');
      return true;
    }
    const input = isRecord(parsed) ? parsed : {};
    const name = typeof input.name === 'string' ? input.name : '';
    if (name === '') {
      errJson(res, 422, 'name is required');
      return true;
    }
    if (getRepo(VIEWER_LOGIN, name) !== undefined) {
      errJson(res, 422, 'Repository already exists');
      return true;
    }
    const repo = createRepoRecord(name, input.private === true, typeof input.description === 'string' ? input.description : '');
    sendJson(res, 201, repoJson(repo), scopes);
    return true;
  }
  // GET /user/repos (paginated)
  if (path === '/api/v3/user/repos' && method === 'GET') {
    const { page, link } = paginate(req, url, listViewerRepos());
    sendJson(res, 200, page.map(repoJson), { ...scopes, ...linkHeader(link) });
    return true;
  }
  // /repos/{owner}/{name}[/...]
  const match = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)(?:\/(.*))?$/.exec(path);
  if (match === null) return false;
  const owner = decodeURIComponent(match[1]!);
  const name = decodeURIComponent(match[2]!);
  const rest = match[3] ?? '';
  const segments = rest === '' ? [] : rest.split('/').map((s) => decodeURIComponent(s));

  // GET/PATCH/DELETE /repos/{o}/{r}
  if (segments.length === 0) {
    if (method === 'GET') {
      const repo = resolveRepo(res, owner, name);
      if (repo === null) return true;
      sendJson(res, 200, repoJson(repo), scopes);
      return true;
    }
    if (method === 'PATCH') {
      const repo = resolveRepo(res, owner, name);
      if (repo === null) return true;
      const parsed = parseJsonBody(body);
      if (parsed === null) {
        errJson(res, 400, 'Problems parsing JSON');
        return true;
      }
      if (isRecord(parsed) && typeof parsed.description === 'string') repo.description = parsed.description;
      if (isRecord(parsed) && typeof parsed.default_branch === 'string') repo.defaultBranch = parsed.default_branch;
      sendJson(res, 200, repoJson(repo), scopes);
      return true;
    }
    if (method === 'DELETE') {
      const repo = resolveRepo(res, owner, name);
      if (repo === null) return true;
      deleteRepoRecord(repo);
      sendJson(res, 204, null, scopes);
      return true;
    }
    return false;
  }

  const repo = resolveRepo(res, owner, name);
  if (repo === null) return true;

  // GET /branches
  if (segments[0] === 'branches' && segments.length === 1 && method === 'GET') {
    const branches = [...repo.refs.keys()]
      .filter((ref) => ref.startsWith('refs/heads/'))
      .map((ref) => ref.slice('refs/heads/'.length))
      .sort()
      .map((branch) => ({ name: branch, commit: { sha: repo.refs.get(`refs/heads/${branch}`) }, protected: false }));
    sendJson(res, 200, branches, scopes);
    return true;
  }
  // GET /branches/{branch}
  if (segments[0] === 'branches' && segments.length === 2 && method === 'GET') {
    const sha = repo.refs.get(`refs/heads/${segments[1]}`);
    if (sha === undefined) {
      errJson(res, 404, 'Branch not found');
      return true;
    }
    sendJson(res, 200, { name: segments[1], commit: { sha }, protected: false }, scopes);
    return true;
  }
  // GET /commits
  if (segments[0] === 'commits' && segments.length === 1 && method === 'GET') {
    const shaParam = url.searchParams.get('sha');
    const refName = shaParam ?? repo.defaultBranch;
    let tip = repo.refs.get(`refs/heads/${refName}`);
    if (tip === undefined && isOid(refName)) tip = refName;
    if (tip === undefined || repo.objects.get(tip) === undefined) {
      errJson(res, 404, 'No commits found');
      return true;
    }
    const commits = commitsFrom(repo, tip).map((sha) => {
      const view = parseCommit(repo.objects.get(sha)!.data);
      return {
        sha,
        commit: {
          // GitHub's API shows the message without the trailing newline that
          // commit objects store; the stored bytes stay untouched.
          message: view.message.endsWith('\n') ? view.message.slice(0, -1) : view.message,
          author: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: FIXED_NOW },
          committer: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: FIXED_NOW },
          tree: { sha: view.tree },
        },
        author: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
        committer: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
        parents: view.parents.map((p) => ({ sha: p })),
      };
    });
    const { page, link } = paginate(req, url, commits);
    sendJson(res, 200, page, { ...scopes, ...linkHeader(link) });
    return true;
  }
  // POST /git/refs
  if (segments[0] === 'git' && segments[1] === 'refs' && segments.length === 2 && method === 'POST') {
    const parsed = parseJsonBody(body);
    if (parsed === null) {
      errJson(res, 400, 'Problems parsing JSON');
      return true;
    }
    const ref = isRecord(parsed) && typeof parsed.ref === 'string' ? parsed.ref : '';
    const sha = isRecord(parsed) && typeof parsed.sha === 'string' ? parsed.sha : '';
    if (!ref.startsWith('refs/') || !isOid(sha) || repo.objects.get(sha) === undefined) {
      errJson(res, 422, 'Invalid ref or sha');
      return true;
    }
    repo.refs.set(ref, sha);
    sendJson(res, 201, { ref, object: { sha, type: repo.objects.get(sha)!.type } }, scopes);
    return true;
  }
  // GET /git/refs/heads/{branch}
  if (segments[0] === 'git' && segments[1] === 'refs' && segments[2] === 'heads' && segments.length === 4 && method === 'GET') {
    const sha = repo.refs.get(`refs/heads/${segments[3]}`);
    if (sha === undefined) {
      errJson(res, 404, 'Reference not found');
      return true;
    }
    sendJson(res, 200, { ref: `refs/heads/${segments[3]}`, object: { sha, type: 'commit' } }, scopes);
    return true;
  }
  // GET /labels, POST /labels
  if (segments[0] === 'labels' && segments.length === 1) {
    if (method === 'GET') {
      sendJson(res, 200, [...repo.labels.values()], scopes);
      return true;
    }
    if (method === 'POST') {
      const parsed = parseJsonBody(body);
      if (parsed === null) {
        errJson(res, 400, 'Problems parsing JSON');
        return true;
      }
      const labelName = isRecord(parsed) && typeof parsed.name === 'string' ? parsed.name : '';
      if (labelName === '') {
        errJson(res, 422, 'name is required');
        return true;
      }
      const label = {
        name: labelName,
        color: isRecord(parsed) && typeof parsed.color === 'string' ? parsed.color : 'ededed',
        description: isRecord(parsed) && typeof parsed.description === 'string' ? parsed.description : '',
      };
      repo.labels.set(labelName, label);
      sendJson(res, 201, label, scopes);
      return true;
    }
    return false;
  }
  // /contents/{path...}
  if (segments[0] === 'contents') {
    const contentPath = segments.slice(1).join('/');
    return handleContents(req, res, url, body, repo, contentPath, scopes);
  }
  // /issues[/...]
  if (segments[0] === 'issues') {
    return handleIssues(req, res, url, body, repo, segments.slice(1), scopes);
  }
  // /pulls[/...]
  if (segments[0] === 'pulls') {
    return handlePulls(req, res, url, body, repo, segments.slice(1), scopes);
  }
  return false;
}

// --- contents ---

async function handleContents(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  body: Buffer,
  repo: Repo,
  contentPath: string,
  scopes: Record<string, string>,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const refParam = url.searchParams.get('ref');
  const branch = refParam ?? repo.defaultBranch;
  const tip = repo.refs.get(`refs/heads/${branch}`);
  const treeOid = tip !== undefined ? treeAtCommit(repo, tip) : '';

  if (method === 'GET') {
    if (tip === undefined) {
      errJson(res, 404, 'Not Found');
      return true;
    }
    const files = flattenTree(repo, treeOid);
    const exact = files.get(contentPath);
    if (exact !== undefined) {
      const data = repo.objects.get(exact.oid)?.data ?? Buffer.alloc(0);
      sendJson(
        res,
        200,
        {
          type: 'file',
          encoding: 'base64',
          size: data.length,
          name: contentPath.split('/').pop() ?? contentPath,
          path: contentPath,
          content: data.toString('base64'),
          sha: exact.oid,
        },
        scopes,
      );
      return true;
    }
    // Directory: immediate children of contentPath.
    const prefix = contentPath === '' ? '' : `${contentPath}/`;
    const children = new Map<string, { type: 'file' | 'dir'; name: string; path: string; sha: string }>();
    for (const [path, entry] of files) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const first = rest.split('/')[0]!;
      if (rest.includes('/')) {
        if (!children.has(first)) {
          // Find the subtree oid for the directory entry.
          let dirTree = treeOid;
          const dirPath = prefix + first;
          const segments = dirPath.split('/');
          let oid = treeOid;
          for (const segment of segments) {
            const object = repo.objects.get(oid);
            if (!object || object.type !== 'tree') {
              oid = '';
              break;
            }
            const found = parseTree(object.data).find((e) => e.name === segment);
            oid = found?.oid ?? '';
            if (oid === '') break;
          }
          dirTree = oid;
          children.set(first, { type: 'dir', name: first, path: dirPath, sha: dirTree });
        }
      } else {
        children.set(first, { type: 'file', name: first, path, sha: entry.oid });
      }
    }
    if (children.size === 0) {
      errJson(res, 404, 'Not Found');
      return true;
    }
    sendJson(res, 200, [...children.values()].sort((a, b) => (a.name < b.name ? -1 : 1)), scopes);
    return true;
  }

  if (method === 'PUT') {
    const parsed = parseJsonBody(body);
    if (parsed === null) {
      errJson(res, 400, 'Problems parsing JSON');
      return true;
    }
    if (!isRecord(parsed) || typeof parsed.content !== 'string' || typeof parsed.message !== 'string') {
      errJson(res, 422, 'content and message are required');
      return true;
    }
    const putBranch = typeof parsed.branch === 'string' ? parsed.branch : repo.defaultBranch;
    const putTip = repo.refs.get(`refs/heads/${putBranch}`);
    const putTree = putTip !== undefined ? treeAtCommit(repo, putTip) : '';
    const putFiles = flattenTree(repo, putTree);
    const existing = putFiles.get(contentPath);
    const givenSha = typeof parsed.sha === 'string' ? parsed.sha : undefined;
    if (existing !== undefined) {
      if (givenSha === undefined) {
        errJson(res, 422, 'sha was not supplied');
        return true;
      }
      if (givenSha !== existing.oid) {
        errJson(res, 409, 'sha does not match the current blob');
        return true;
      }
    } else if (givenSha !== undefined) {
      errJson(res, 409, 'sha does not match the current blob');
      return true;
    }
    const content = Buffer.from(parsed.content.replace(/[\r\n\t ]+/g, ''), 'base64');
    const result = commitFile(repo, putBranch, contentPath, content, parsed.message);
    sendJson(
      res,
      existing !== undefined ? 200 : 201,
      {
        content: { name: contentPath.split('/').pop(), path: contentPath, sha: result.contentSha, size: content.length, encoding: 'base64' },
        commit: { sha: result.commitSha, message: parsed.message },
      },
      scopes,
    );
    return true;
  }

  if (method === 'DELETE') {
    const parsed = parseJsonBody(body);
    if (parsed === null) {
      errJson(res, 400, 'Problems parsing JSON');
      return true;
    }
    // The branch may arrive in the body (GitHub's API) or in ?ref=.
    const deleteBranch = isRecord(parsed) && typeof parsed.branch === 'string' ? parsed.branch : branch;
    const deleteTip = repo.refs.get(`refs/heads/${deleteBranch}`);
    if (deleteTip === undefined) {
      errJson(res, 404, 'Not Found');
      return true;
    }
    const files = flattenTree(repo, treeAtCommit(repo, deleteTip));
    const existing = files.get(contentPath);
    if (existing === undefined) {
      errJson(res, 404, 'Not Found');
      return true;
    }
    const givenSha = isRecord(parsed) && typeof parsed.sha === 'string' ? parsed.sha : undefined;
    if (givenSha !== undefined && givenSha !== existing.oid) {
      errJson(res, 409, 'sha does not match the current blob');
      return true;
    }
    const message = isRecord(parsed) && typeof parsed.message === 'string' ? parsed.message : 'Delete file';
    const commitSha = deleteFile(repo, deleteBranch, contentPath, message);
    sendJson(res, 200, { commit: { sha: commitSha, message } }, scopes);
    return true;
  }
  return false;
}

// --- issues ---

async function handleIssues(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  body: Buffer,
  repo: Repo,
  segments: string[],
  scopes: Record<string, string>,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  // POST /issues, GET /issues
  if (segments.length === 0) {
    if (method === 'POST') {
      const parsed = parseJsonBody(body);
      if (parsed === null) {
        errJson(res, 400, 'Problems parsing JSON');
        return true;
      }
      if (!isRecord(parsed) || typeof parsed.title !== 'string' || parsed.title === '') {
        errJson(res, 422, 'title is required');
        return true;
      }
      const labels = Array.isArray(parsed.labels) ? parsed.labels.filter((l): l is string => typeof l === 'string') : [];
      const created = createIssueIn(repo, parsed.title, typeof parsed.body === 'string' ? parsed.body : '', labels);
      if ('error' in created) {
        errJson(res, 422, created.error);
        return true;
      }
      sendJson(res, 201, issueJson(repo, created), scopes);
      return true;
    }
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      const sort = url.searchParams.get('sort') ?? 'created';
      const direction = url.searchParams.get('direction') ?? 'desc';
      let list = repo.issues.filter((issue) => state === 'all' || issue.state === state);
      if (sort === 'created') {
        list = [...list].sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      }
      const { page, link } = paginate(req, url, list);
      sendJson(res, 200, page.map((issue) => issueJson(repo, issue)), { ...scopes, ...linkHeader(link) });
      return true;
    }
    return false;
  }
  const number = Number(segments[0]);
  if (!Number.isInteger(number)) return false;
  const issue = repo.issues.find((entry) => entry.number === number);
  // /issues/{n}/comments
  if (segments.length === 2 && segments[1] === 'comments') {
    if (issue === undefined) {
      errJson(res, 404, 'Not Found');
      return true;
    }
    if (method === 'POST') {
      const parsed = parseJsonBody(body);
      if (parsed === null) {
        errJson(res, 400, 'Problems parsing JSON');
        return true;
      }
      if (!isRecord(parsed) || typeof parsed.body !== 'string') {
        errJson(res, 422, 'body is required');
        return true;
      }
      const comment: Comment = { id: repo.nextComment, body: parsed.body };
      repo.nextComment += 1;
      issue.comments.push(comment);
      sendJson(res, 201, { id: comment.id, node_id: commentGlobalId(repo, issue, comment), body: comment.body, user: { login: VIEWER_LOGIN, id: VIEWER_ID } }, scopes);
      return true;
    }
    if (method === 'GET') {
      sendJson(
        res,
        200,
        issue.comments.map((comment) => ({ id: comment.id, node_id: commentGlobalId(repo, issue, comment), body: comment.body, user: { login: VIEWER_LOGIN, id: VIEWER_ID } })),
        scopes,
      );
      return true;
    }
    return false;
  }
  // /issues/{n}
  if (segments.length === 1) {
    if (issue === undefined) {
      errJson(res, 404, 'Not Found');
      return true;
    }
    if (method === 'GET') {
      sendJson(res, 200, issueJson(repo, issue), scopes);
      return true;
    }
    if (method === 'PATCH') {
      const parsed = parseJsonBody(body);
      if (parsed === null) {
        errJson(res, 400, 'Problems parsing JSON');
        return true;
      }
      if (isRecord(parsed)) {
        if (typeof parsed.title === 'string') issue.title = parsed.title;
        if (typeof parsed.body === 'string') issue.body = parsed.body;
        if (parsed.state === 'open' || parsed.state === 'closed') issue.state = parsed.state;
      }
      sendJson(res, 200, issueJson(repo, issue), scopes);
      return true;
    }
    return false;
  }
  return false;
}

// --- pulls ---

async function handlePulls(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  body: Buffer,
  repo: Repo,
  segments: string[],
  scopes: Record<string, string>,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  // POST /pulls, GET /pulls
  if (segments.length === 0) {
    if (method === 'POST') {
      const parsed = parseJsonBody(body);
      if (parsed === null) {
        errJson(res, 400, 'Problems parsing JSON');
        return true;
      }
      if (!isRecord(parsed) || typeof parsed.title !== 'string' || typeof parsed.head !== 'string' || typeof parsed.base !== 'string') {
        errJson(res, 422, 'title, head and base are required');
        return true;
      }
      const created = createPullIn(repo, parsed.title, typeof parsed.body === 'string' ? parsed.body : '', parsed.head, parsed.base);
      if ('error' in created) {
        errJson(res, 422, created.error);
        return true;
      }
      sendJson(res, 201, pullJson(repo, created), scopes);
      return true;
    }
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      const list = repo.pulls.filter((pull) => state === 'all' || pull.state === state);
      const ordered = [...list].sort((a, b) => b.seq - a.seq);
      const { page, link } = paginate(req, url, ordered);
      sendJson(res, 200, page.map((pull) => pullJson(repo, pull)), { ...scopes, ...linkHeader(link) });
      return true;
    }
    return false;
  }
  const number = Number(segments[0]);
  if (!Number.isInteger(number)) return false;
  const pull = repo.pulls.find((entry) => entry.number === number);
  // PUT /pulls/{n}/merge
  if (segments.length === 2 && segments[1] === 'merge') {
    if (method !== 'PUT') return false;
    if (pull === undefined) {
      errJson(res, 404, 'Not Found');
      return true;
    }
    if (pull.merged) {
      errJson(res, 405, 'Pull request has already been merged');
      return true;
    }
    const sha = squashMerge(repo, pull);
    if (sha === null) {
      errJson(res, 405, 'Merge conflict');
      return true;
    }
    sendJson(res, 200, { merged: true, sha, message: `Merged pull request #${pull.number}` }, scopes);
    return true;
  }
  // GET /pulls/{n}/files
  if (segments.length === 2 && segments[1] === 'files') {
    if (method !== 'GET') return false;
    if (pull === undefined) {
      errJson(res, 404, 'Not Found');
      return true;
    }
    sendJson(res, 200, pullFiles(repo, pull), scopes);
    return true;
  }
  // GET /pulls/{n}
  if (segments.length === 1 && method === 'GET') {
    if (pull === undefined) {
      errJson(res, 404, 'Not Found');
      return true;
    }
    sendJson(res, 200, pullJson(repo, pull), scopes);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// GraphQL v4: a small parser + executor for the fixed gh documents
// ---------------------------------------------------------------------------

interface GqlArg {
  [key: string]: unknown;
}

interface GqlField {
  alias: string | null;
  name: string;
  args: GqlArg;
  children: GqlField[];
  fragmentType: string | null;
}

interface GqlOperation {
  kind: 'query' | 'mutation';
  name: string | null;
  variables: Record<string, unknown>;
  fields: GqlField[];
}

function gqlTokenize(source: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push('...');
      i += 3;
      continue;
    }
    if ('{}():[]!=$@'.includes(ch)) {
      tokens.push(ch);
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          out += source[j + 1];
          j += 2;
        } else {
          out += source[j];
          j += 1;
        }
      }
      tokens.push(JSON.stringify(out));
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < source.length && /[A-Za-z0-9_\-.]/.test(source[j]!)) j += 1;
    tokens.push(source.slice(i, j));
    i = j;
  }
  return tokens;
}

class GqlParser {
  private tokens: string[];
  private pos = 0;
  private variables: Record<string, unknown>;

  constructor(source: string, variables: Record<string, unknown>) {
    this.tokens = gqlTokenize(source);
    this.variables = variables;
  }

  private peek(): string | undefined {
    return this.tokens[this.pos];
  }

  private next(): string {
    const token = this.tokens[this.pos];
    this.pos += 1;
    return token ?? '';
  }

  private expect(token: string): void {
    if (this.next() !== token) throw new Error(`expected ${token} in GraphQL document`);
  }

  parseOperation(): GqlOperation {
    let kind: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const first = this.peek();
    if (first === 'query' || first === 'mutation') {
      kind = this.next() as 'query' | 'mutation';
      const maybeName = this.peek();
      if (maybeName !== undefined && maybeName !== '(' && maybeName !== '{') name = this.next();
    }
    // Variable definitions: ($x: Type!, ...)
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')' && this.peek() !== undefined) this.next();
      this.expect(')');
    }
    const fields = this.parseSelectionSet();
    return { kind, name, variables: this.variables, fields };
  }

  private parseSelectionSet(): GqlField[] {
    this.expect('{');
    const fields: GqlField[] = [];
    while (this.peek() !== '}' && this.peek() !== undefined) {
      fields.push(...this.parseField());
    }
    this.expect('}');
    return fields;
  }

  private parseField(): GqlField[] {
    if (this.peek() === '...') {
      this.next();
      let fragmentType: string | null = null;
      if (this.peek() === 'on') {
        this.next();
        fragmentType = this.next();
      } else {
        // Named fragment spread: skip the name; fragments are not used by the suite.
        this.next();
        return [];
      }
      const children = this.parseSelectionSet();
      return children.map((child) => ({ ...child, fragmentType }));
    }
    let name = this.next();
    let alias: string | null = null;
    if (this.peek() === ':') {
      this.next();
      alias = name;
      name = this.next();
    }
    const args: GqlArg = {};
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')' && this.peek() !== undefined) {
        const argName = this.next();
        this.expect(':');
        args[argName] = this.parseValue();
      }
      this.expect(')');
    }
    const children = this.peek() === '{' ? this.parseSelectionSet() : [];
    return [{ alias, name, args, children, fragmentType: null }];
  }

  private parseValue(): unknown {
    const token = this.next();
    if (token === '$') {
      const name = this.next();
      return this.variables[name] ?? null;
    }
    if (token === '[') {
      const list: unknown[] = [];
      while (this.peek() !== ']' && this.peek() !== undefined) list.push(this.parseValue());
      this.expect(']');
      return list;
    }
    if (token === '{') {
      const object: Record<string, unknown> = {};
      while (this.peek() !== '}' && this.peek() !== undefined) {
        const key = this.next();
        this.expect(':');
        object[key] = this.parseValue();
      }
      this.expect('}');
      return object;
    }
    if (token.startsWith('"')) return JSON.parse(token) as string;
    if (token === 'true') return true;
    if (token === 'false') return false;
    if (token === 'null') return null;
    const number = Number(token);
    if (token !== '' && !Number.isNaN(number)) return number;
    return token; // enum literal
  }
}

// --- introspection tables ---

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'author', 'createdAt', 'updatedAt', 'closedAt', 'labels', 'comments', 'url', 'repository', 'locked', 'assignees', 'milestone', 'reactions', 'timelineItems', 'participants', 'stateReason', 'titleHTML', 'bodyHTML', 'bodyText', 'closed'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'commits', 'reviews', 'reviewDecision', 'additions', 'deletions', 'changedFiles', 'isDraft', 'locked', 'url', 'author', 'createdAt', 'updatedAt', 'closedAt', 'mergedAt', 'mergeCommit', 'labels', 'assignees', 'milestone', 'participants', 'repository', 'resourcePath'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'hasProjectsEnabled', 'hasWikiEnabled', 'isPrivate', 'isArchived', 'isFork', 'description', 'url', 'homepageUrl', 'createdAt', 'updatedAt', 'pushedAt', 'issue', 'issues', 'pullRequest', 'pullRequests', 'labels', 'milestones', 'branches', 'refs', 'licenseInfo', 'languages', 'stargazerCount', 'forkCount', 'watchers', 'diskUsage', 'visibility', 'sshUrl', 'cloneUrl'],
  User: ['id', 'login', 'name', 'email', 'avatarUrl', 'url', 'company', 'location', 'bio', 'createdAt', 'updatedAt'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt', 'url'],
  Ref: ['name', 'target', 'prefix'],
  Label: ['id', 'name', 'color', 'description'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
};

const TYPE_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['CODE', 'COMMIT', 'DISCUSSION', 'ISSUE', 'LABEL', 'MILESTONE', 'PACKAGE', 'PROJECT', 'REPOSITORY', 'TOPIC', 'USER', 'WIKI'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['COMMENTS', 'CREATED_AT', 'UPDATED_AT'],
  OrderDirection: ['ASC', 'DESC'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

// --- execution ---

type GqlValue = Record<string, unknown> | unknown[] | string | number | boolean | null;

interface GqlObject {
  __typename: string;
  data: Record<string, unknown>;
}

class GqlExecutor {
  errors: Array<{ message: string }> = [];

  private fieldError(typeName: string, field: string): void {
    this.errors.push({ message: `Cannot query field "${field}" on type "${typeName}".` });
  }

  execute(operation: GqlOperation): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const field of operation.fields) {
      const key = field.alias ?? field.name;
      out[key] = this.rootField(operation, field);
    }
    return out;
  }

  private rootField(operation: GqlOperation, field: GqlField): unknown {
    if (field.name === 'viewer') {
      const obj: GqlObject = { __typename: 'User', data: { login: VIEWER_LOGIN } };
      return this.select(obj, field.children);
    }
    if (field.name === 'repository') {
      const owner = field.args.owner as string;
      const name = field.args.name as string;
      const repo = getRepo(owner, name);
      if (repo === undefined) return null;
      return this.select({ __typename: 'Repository', data: { repo } }, field.children);
    }
    if (field.name === 'node') {
      const id = field.args.id as string;
      const decoded = decodeGlobalId(id);
      if (decoded === null || decoded.kind !== 'R') return null;
      const repo = getRepo(decoded.owner, decoded.name);
      if (repo === undefined) return null;
      return this.select({ __typename: 'Repository', data: { repo } }, field.children);
    }
    if (field.name === '__type') {
      const name = field.args.name as string;
      return this.typeObject(name, field.children);
    }
    if (field.name === '__schema') {
      return this.select({ __typename: '__Schema', data: {} }, field.children);
    }
    if (operation.kind === 'mutation') return this.mutationField(field);
    this.fieldError('Query', field.name);
    return null;
  }

  private mutationField(field: GqlField): unknown {
    const input = (isRecord(field.args.input) ? field.args.input : {}) as Record<string, unknown>;
    if (field.name === 'createIssue') {
      const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
      if (decoded === null || decoded.kind !== 'R') {
        this.errors.push({ message: 'createIssue: unknown repositoryId' });
        return null;
      }
      const repo = getRepo(decoded.owner, decoded.name);
      if (repo === undefined) {
        this.errors.push({ message: 'createIssue: unknown repository' });
        return null;
      }
      const created = createIssueIn(repo, String(input.title ?? ''), typeof input.body === 'string' ? input.body : '', []);
      if ('error' in created) {
        this.errors.push({ message: created.error });
        return null;
      }
      const obj: GqlObject = { __typename: 'CreateIssuePayload', data: { issue: { repo, issue: created } } };
      return this.select(obj, field.children);
    }
    if (field.name === 'closeIssue') {
      const decoded = decodeGlobalId(String(input.issueId ?? ''));
      if (decoded === null || decoded.kind !== 'I') {
        this.errors.push({ message: 'closeIssue: unknown issueId' });
        return null;
      }
      const repo = getRepo(decoded.owner, decoded.name);
      const issue = repo?.issues.find((entry) => entry.number === decoded.number);
      if (repo === undefined || issue === undefined) {
        this.errors.push({ message: 'closeIssue: unknown issue' });
        return null;
      }
      issue.state = 'closed';
      const obj: GqlObject = { __typename: 'CloseIssuePayload', data: { issue: { repo, issue } } };
      return this.select(obj, field.children);
    }
    if (field.name === 'createPullRequest') {
      const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
      if (decoded === null || decoded.kind !== 'R') {
        this.errors.push({ message: 'createPullRequest: unknown repositoryId' });
        return null;
      }
      const repo = getRepo(decoded.owner, decoded.name);
      if (repo === undefined) {
        this.errors.push({ message: 'createPullRequest: unknown repository' });
        return null;
      }
      const created = createPullIn(
        repo,
        String(input.title ?? ''),
        '',
        String(input.headRefName ?? ''),
        String(input.baseRefName ?? ''),
      );
      if ('error' in created) {
        this.errors.push({ message: created.error });
        return null;
      }
      const obj: GqlObject = { __typename: 'CreatePullRequestPayload', data: { pullRequest: { repo, pull: created } } };
      return this.select(obj, field.children);
    }
    if (field.name === 'mergePullRequest') {
      const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
      if (decoded === null || decoded.kind !== 'P') {
        this.errors.push({ message: 'mergePullRequest: unknown pullRequestId' });
        return null;
      }
      const repo = getRepo(decoded.owner, decoded.name);
      const pull = repo?.pulls.find((entry) => entry.number === decoded.number);
      if (repo === undefined || pull === undefined) {
        this.errors.push({ message: 'mergePullRequest: unknown pull request' });
        return null;
      }
      if (pull.merged) {
        this.errors.push({ message: 'mergePullRequest: pull request is already merged' });
        return null;
      }
      const sha = squashMerge(repo, pull);
      if (sha === null) {
        this.errors.push({ message: 'mergePullRequest: merge conflict' });
        return null;
      }
      const obj: GqlObject = { __typename: 'MergePullRequestPayload', data: { pullRequest: { repo, pull } } };
      return this.select(obj, field.children);
    }
    if (field.name === 'addComment') {
      const decoded = decodeGlobalId(String(input.subjectId ?? ''));
      if (decoded === null || (decoded.kind !== 'I' && decoded.kind !== 'P')) {
        this.errors.push({ message: 'addComment: unknown subjectId' });
        return null;
      }
      const repo = getRepo(decoded.owner, decoded.name);
      // Issues and pull requests share one number space; a comment may target either.
      const subject =
        decoded.kind === 'I'
          ? repo?.issues.find((entry) => entry.number === decoded.number)
          : repo?.pulls.find((entry) => entry.number === decoded.number);
      if (repo === undefined || subject === undefined) {
        this.errors.push({ message: 'addComment: unknown subject' });
        return null;
      }
      const comment: Comment = { id: repo.nextComment, body: String(input.body ?? '') };
      repo.nextComment += 1;
      subject.comments.push(comment);
      const obj: GqlObject = {
        __typename: 'AddCommentPayload',
        data: { commentEdge: { node: { repo, issue: subject, comment } } },
      };
      return this.select(obj, field.children);
    }
    this.fieldError('Mutation', field.name);
    return null;
  }

  private typeObject(name: string, children: GqlField[]): Record<string, unknown> | null {
    const fields = TYPE_FIELDS[name];
    const enums = TYPE_ENUM_VALUES[name];
    if (fields === undefined && enums === undefined) return null;
    const data: Record<string, unknown> = { kind: enums !== undefined ? 'ENUM' : 'OBJECT', name, description: null };
    for (const child of children) {
      if (child.name === 'fields') {
        data.fields = (fields ?? []).map((fieldName) => ({ name: fieldName, description: null }));
      } else if (child.name === 'enumValues') {
        data.enumValues = (enums ?? []).map((value) => ({ name: value, description: null }));
      } else if (child.name === 'name') {
        data.name = name;
      } else if (child.name === 'kind') {
        data.kind = enums !== undefined ? 'ENUM' : 'OBJECT';
      } else if (child.name === 'description') {
        data.description = null;
      }
    }
    return data;
  }

  /** Select `children` of an object value. */
  private select(obj: GqlObject, children: GqlField[]): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const field of children) {
      if (field.fragmentType !== null && field.fragmentType !== obj.__typename) continue;
      const key = field.alias ?? field.name;
      out[key] = this.objectField(obj, field);
    }
    return out;
  }

  private objectField(obj: GqlObject, field: GqlField): unknown {
    const data = obj.data;
    switch (obj.__typename) {
      case 'User': {
        if (field.name === 'login') return data.login ?? VIEWER_LOGIN;
        if (field.name === 'id') return b64url(`U:${VIEWER_LOGIN}`);
        if (field.name === 'name') return VIEWER_NAME;
        if (field.name === 'email') return VIEWER_EMAIL;
        this.fieldError('User', field.name);
        return null;
      }
      case 'Repository': {
        const repo = data.repo as Repo;
        switch (field.name) {
          case 'id':
            return repoGlobalId(repo);
          case 'databaseId':
            return repo.id;
          case 'name':
            return repo.name;
          case 'nameWithOwner':
            return `${repo.owner}/${repo.name}`;
          case 'owner':
            return this.select({ __typename: 'User', data: { login: repo.owner } }, field.children);
          case 'defaultBranchRef': {
            const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
            if (tip === undefined) return null;
            return this.select({ __typename: 'Ref', data: { name: repo.defaultBranch } }, field.children);
          }
          case 'viewerPermission':
            return 'ADMIN';
          case 'hasIssuesEnabled':
            return true;
          case 'issue': {
            const number = field.args.number as number;
            const issue = repo.issues.find((entry) => entry.number === number);
            if (issue === undefined) return null;
            return this.select({ __typename: 'Issue', data: { repo, issue } }, field.children);
          }
          case 'issues':
            return this.issueConnection(repo, field);
          case 'pullRequests':
            return this.pullConnection(repo, field, false);
          case 'pullRequest': {
            const number = field.args.number as number;
            const pull = repo.pulls.find((entry) => entry.number === number);
            if (pull === undefined) return null;
            return this.select({ __typename: 'PullRequest', data: { repo, pull } }, field.children);
          }
          default:
            this.fieldError('Repository', field.name);
            return null;
        }
      }
      case 'Issue': {
        const repo = data.repo as Repo;
        const issue = data.issue as Issue;
        switch (field.name) {
          case 'id':
            return issueGlobalId(repo, issue);
          case 'number':
            return issue.number;
          case 'title':
            return issue.title;
          case 'state':
            return issue.state === 'open' ? 'OPEN' : 'CLOSED';
          case 'body':
            return issue.body;
          default:
            this.fieldError('Issue', field.name);
            return null;
        }
      }
      case 'PullRequest': {
        const repo = data.repo as Repo;
        const pull = data.pull as Pull;
        switch (field.name) {
          case 'id':
            return pullGlobalId(repo, pull);
          case 'number':
            return pull.number;
          case 'title':
            return pull.title;
          case 'body':
            return pull.body;
          case 'state':
            return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
          case 'merged':
            return pull.merged;
          case 'headRefName':
            return pull.head;
          case 'baseRefName':
            return pull.base;
          case 'mergeable':
            return pullMergeable(repo, pull);
          case 'files': {
            const first = typeof field.args.first === 'number' ? field.args.first : 10;
            const nodes = pullFiles(repo, pull).slice(0, first);
            const out: Record<string, unknown> = {};
            for (const child of field.children) {
              if (child.name === 'nodes') {
                out.nodes = nodes.map((file) =>
                  this.select({ __typename: 'PullRequestChangedFile', data: { path: file.filename } }, child.children),
                );
              } else if (child.name === 'totalCount') {
                out.totalCount = nodes.length;
              }
            }
            return out;
          }
          default:
            this.fieldError('PullRequest', field.name);
            return null;
        }
      }
      case 'PullRequestChangedFile': {
        if (field.name === 'path') return data.path as string;
        this.fieldError('PullRequestChangedFile', field.name);
        return null;
      }
      case 'Ref': {
        if (field.name === 'name') return data.name as string;
        this.fieldError('Ref', field.name);
        return null;
      }
      case 'CreateIssuePayload':
      case 'CloseIssuePayload': {
        if (field.name === 'issue') {
          const issue = data.issue as { repo: Repo; issue: Issue };
          return this.select({ __typename: 'Issue', data: issue }, field.children);
        }
        this.fieldError(obj.__typename, field.name);
        return null;
      }
      case 'CreatePullRequestPayload':
      case 'MergePullRequestPayload': {
        if (field.name === 'pullRequest') {
          const pull = data.pullRequest as { repo: Repo; pull: Pull };
          return this.select({ __typename: 'PullRequest', data: pull }, field.children);
        }
        this.fieldError(obj.__typename, field.name);
        return null;
      }
      case 'AddCommentPayload': {
        if (field.name === 'commentEdge') {
          const edge = data.commentEdge as { node: { repo: Repo; issue: Issue; comment: Comment } };
          const out: Record<string, unknown> = {};
          for (const child of field.children) {
            if (child.name === 'node') {
              out.node = this.select({ __typename: 'IssueComment', data: edge.node }, child.children);
            } else if (child.name === 'cursor') {
              out.cursor = '';
            }
          }
          return out;
        }
        this.fieldError(obj.__typename, field.name);
        return null;
      }
      case 'IssueComment': {
        const repo = data.repo as Repo;
        const issue = data.issue as Issue;
        const comment = data.comment as Comment;
        if (field.name === 'id') return commentGlobalId(repo, issue, comment);
        if (field.name === 'body') return comment.body;
        this.fieldError('IssueComment', field.name);
        return null;
      }
      default: {
        this.fieldError(obj.__typename, field.name);
        return null;
      }
    }
  }

  private issueConnection(repo: Repo, field: GqlField): Record<string, unknown> {
    const first = typeof field.args.first === 'number' ? field.args.first : 30;
    const states = Array.isArray(field.args.states) ? (field.args.states as string[]) : ['OPEN'];
    const orderBy = isRecord(field.args.orderBy) ? field.args.orderBy : {};
    const direction = orderBy.direction === 'ASC' ? 'ASC' : 'DESC';
    const after = typeof field.args.after === 'string' ? field.args.after : null;
    let list = repo.issues.filter((issue) => {
      const state = issue.state === 'open' ? 'OPEN' : 'CLOSED';
      return states.includes(state);
    });
    list = [...list].sort((a, b) => (direction === 'ASC' ? a.seq - b.seq : b.seq - a.seq));
    let start = 0;
    if (after !== null) {
      try {
        const decoded = unb64url(after);
        const index = Number(decoded.slice('cursor:'.length));
        if (Number.isInteger(index)) start = index + 1;
      } catch {
        start = 0;
      }
    }
    const page = list.slice(start, start + first);
    const out: Record<string, unknown> = {};
    for (const child of field.children) {
      if (child.name === 'nodes') {
        out.nodes = page.map((issue) => this.select({ __typename: 'Issue', data: { repo, issue } }, child.children));
      } else if (child.name === 'pageInfo') {
        const endIndex = start + page.length - 1;
        const info: Record<string, unknown> = {};
        for (const infoChild of child.children) {
          if (infoChild.name === 'hasNextPage') info.hasNextPage = start + page.length < list.length;
          else if (infoChild.name === 'hasPreviousPage') info.hasPreviousPage = start > 0;
          else if (infoChild.name === 'endCursor') {
            info.endCursor = page.length === 0 ? null : b64url(`cursor:${endIndex}`);
          } else if (infoChild.name === 'startCursor') {
            info.startCursor = page.length === 0 ? null : b64url(`cursor:${start}`);
          }
        }
        out.pageInfo = info;
      } else if (child.name === 'totalCount') {
        out.totalCount = list.length;
      }
    }
    return out;
  }

  private pullConnection(repo: Repo, field: GqlField, _all: boolean): Record<string, unknown> {
    const first = typeof field.args.first === 'number' ? field.args.first : 30;
    const states = Array.isArray(field.args.states) ? (field.args.states as string[]) : ['OPEN'];
    const list = repo.pulls
      .filter((pull) => {
        const state = pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
        return states.includes(state);
      })
      .sort((a, b) => b.seq - a.seq)
      .slice(0, first);
    const out: Record<string, unknown> = {};
    for (const child of field.children) {
      if (child.name === 'nodes') {
        out.nodes = list.map((pull) => this.select({ __typename: 'PullRequest', data: { repo, pull } }, child.children));
      } else if (child.name === 'pageInfo') {
        out.pageInfo = { hasNextPage: false, hasPreviousPage: false, endCursor: null, startCursor: null };
      } else if (child.name === 'totalCount') {
        out.totalCount = list.length;
      }
    }
    return out;
  }
}

function runGraphQLOperation(query: string, variables: Record<string, unknown>): { data: Record<string, unknown> | null; errors?: Array<{ message: string }> } {
  const executor = new GqlExecutor();
  try {
    const operation = new GqlParser(query, variables).parseOperation();
    const data = executor.execute(operation);
    if (executor.errors.length > 0) return { data, errors: executor.errors };
    return { data };
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
}

async function handleGraphQL(req: IncomingMessage, res: ServerResponse, body: Buffer): Promise<boolean> {
  if ((req.method ?? 'GET') !== 'POST') {
    errJson(res, 405, 'Method Not Allowed');
    return true;
  }
  if (!authed(req)) {
    errJson(res, 401, 'Requires authentication');
    return true;
  }
  const parsed = parseJsonBody(body);
  if (parsed === null) {
    errJson(res, 400, 'Problems parsing JSON');
    return true;
  }
  if (Array.isArray(parsed)) {
    // Batched operations: one result per document, in order.
    const results = parsed.map((entry) => {
      if (!isRecord(entry) || typeof entry.query !== 'string') {
        return { data: null, errors: [{ message: 'each batched entry needs a query string' }] };
      }
      const variables = isRecord(entry.variables) ? (entry.variables as Record<string, unknown>) : {};
      return runGraphQLOperation(entry.query, variables);
    });
    sendJson(res, 200, results);
    return true;
  }
  if (!isRecord(parsed) || typeof parsed.query !== 'string') {
    errJson(res, 400, 'query is required');
    return true;
  }
  const variables = isRecord(parsed.variables) ? (parsed.variables as Record<string, unknown>) : {};
  sendJson(res, 200, runGraphQLOperation(parsed.query, variables));
  return true;
}

// ---------------------------------------------------------------------------
// MCP (Model Context Protocol, Streamable HTTP, modern 2026-07-28 era)
// ---------------------------------------------------------------------------

const MCP_REVISIONS: readonly string[] = Object.freeze([
  '2026-07-28',
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
]);

interface McpToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string }>;
    required: string[];
  };
}

// One fixed array, built once: two tools/list calls answer byte-identical JSON.
const MCP_TOOLS: readonly McpToolDef[] = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
]);

function mcpToolResult(payload: unknown, isError = false): Record<string, unknown> {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return {
    content: [{ type: 'text', text }],
    structuredContent: isRecord(payload) || Array.isArray(payload) ? payload : { result: payload },
    isError,
  };
}

function mcpCallTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = MCP_TOOLS.find((entry) => entry.name === name);
  if (tool === undefined) {
    // Unknown tool: the caller maps this to a JSON-RPC error; signal it with a marker.
    return { __mcpError: -32602, __mcpMessage: `Unknown tool: ${name}` };
  }
  const missing = tool.inputSchema.required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
  if (missing.length > 0) {
    return mcpToolResult(`Missing required argument: ${missing.join(', ')}`, true);
  }
  const str = (key: string): string => String(args[key] ?? '');
  if (name === 'create_repo') {
    const repoName = str('name');
    if (getRepo(VIEWER_LOGIN, repoName) !== undefined) {
      return mcpToolResult(`Repository ${repoName} already exists`, true);
    }
    const repo = createRepoRecord(repoName, args.private === true, typeof args.description === 'string' ? args.description : '');
    return mcpToolResult(repoJson(repo));
  }
  const owner = str('owner');
  const repoName = str('repo');
  const repo = getRepo(owner, repoName);
  if (name === 'get_repo') {
    if (repo === undefined) return mcpToolResult(`Repository ${owner}/${repoName} not found`, true);
    return mcpToolResult(repoJson(repo));
  }
  if (repo === undefined) return mcpToolResult(`Repository ${owner}/${repoName} not found`, true);
  if (name === 'create_issue') {
    const created = createIssueIn(repo, str('title'), typeof args.body === 'string' ? args.body : '', []);
    if ('error' in created) return mcpToolResult(created.error, true);
    return mcpToolResult(issueJson(repo, created));
  }
  if (name === 'list_issues') {
    const state = typeof args.state === 'string' ? args.state : 'open';
    const list = repo.issues
      .filter((issue) => state === 'all' || issue.state === state)
      .map((issue) => issueJson(repo, issue));
    return mcpToolResult(list);
  }
  if (name === 'create_pull_request') {
    const created = createPullIn(repo, str('title'), typeof args.body === 'string' ? args.body : '', str('head'), str('base'));
    if ('error' in created) return mcpToolResult(created.error, true);
    return mcpToolResult(pullJson(repo, created));
  }
  if (name === 'merge_pull_request') {
    const number = Number(args.pull_number);
    const pull = repo.pulls.find((entry) => entry.number === number);
    if (pull === undefined) return mcpToolResult(`Pull request #${number} not found`, true);
    if (pull.merged) return mcpToolResult(`Pull request #${number} is already merged`, true);
    const sha = squashMerge(repo, pull);
    if (sha === null) return mcpToolResult(`Pull request #${number} has a merge conflict`, true);
    return mcpToolResult({ merged: true, number, state: 'closed', sha, message: `Merged pull request #${number}` });
  }
  return mcpToolResult(`Tool ${name} is not implemented`, true);
}

async function handleMcp(req: IncomingMessage, res: ServerResponse, body: Buffer): Promise<boolean> {
  const method = req.method ?? 'GET';
  if (method === 'DELETE') {
    // A legacy session goodbye; nothing is held.
    sendJson(res, 200, {});
    return true;
  }
  if (method !== 'POST') {
    errJson(res, 405, 'Method Not Allowed');
    return true;
  }
  if (!authed(req)) {
    // Authentication is decided before any tool exists.
    res.writeHead(401, { 'content-type': JSON_TYPE, 'x-github-request-id': nextRequestId() });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Requires authentication' } }));
    return true;
  }
  const text = body.toString('utf8');
  let parsed: unknown = null;
  try {
    parsed = text.trim() === '' ? null : (JSON.parse(text) as unknown);
  } catch {
    parsed = null;
  }
  if (parsed === null || !isRecord(parsed)) {
    // Not JSON: HTTP 400 with JSON-RPC -32700 (the id is recovered when readable).
    const idMatch = /"id"\s*:\s*("[^"]*"|\d+)/.exec(text);
    let id: unknown = null;
    if (idMatch) {
      const raw = idMatch[1]!;
      id = raw.startsWith('"') ? raw.slice(1, -1) : Number(raw);
    }
    res.writeHead(400, { 'content-type': JSON_TYPE, 'x-github-request-id': nextRequestId() });
    res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32700, message: 'Parse error' } }));
    return true;
  }
  const id = parsed.id ?? null;
  const rpcMethod = typeof parsed.method === 'string' ? parsed.method : '';
  const params = isRecord(parsed.params) ? parsed.params : {};
  const reply = (payload: Record<string, unknown>): void => {
    sendJson(res, 200, { jsonrpc: '2.0', id, ...payload });
  };
  const rpcError = (code: number, message: string): void => {
    reply({ error: { code, message } });
  };
  if (rpcMethod === 'server/discover') {
    reply({
      result: {
        supportedVersions: [...MCP_REVISIONS],
        serverInfo: { name: FORGE_NAME, version: FORGE_VERSION },
        capabilities: { tools: {} },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: FORGE_NAME, version: FORGE_VERSION } },
      },
    });
    return true;
  }
  if (rpcMethod === 'initialize') {
    const requested = typeof (params as Record<string, unknown>).protocolVersion === 'string' ? (params as Record<string, unknown>).protocolVersion as string : '';
    reply({
      result: {
        protocolVersion: MCP_REVISIONS.includes(requested) ? requested : '2026-07-28',
        capabilities: { tools: {} },
        serverInfo: { name: FORGE_NAME, version: FORGE_VERSION },
      },
    });
    return true;
  }
  if (rpcMethod === 'notifications/initialized' || rpcMethod.startsWith('notifications/')) {
    // A notification carries no id and expects no result.
    res.writeHead(202, { 'content-type': JSON_TYPE, 'x-github-request-id': nextRequestId() });
    res.end('');
    return true;
  }
  if (rpcMethod === 'tools/list') {
    reply({ result: { tools: MCP_TOOLS } });
    return true;
  }
  if (rpcMethod === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
    const result = mcpCallTool(toolName, args);
    if ('__mcpError' in result) {
      rpcError(result.__mcpError as number, String(result.__mcpMessage ?? 'Unknown tool'));
      return true;
    }
    reply({ result });
    return true;
  }
  if (rpcMethod === 'ping') {
    reply({ result: {} });
    return true;
  }
  rpcError(-32601, `Method not found: ${rpcMethod}`);
  return true;
}

// ---------------------------------------------------------------------------
// git smart HTTP
// ---------------------------------------------------------------------------

function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  const refs: Array<{ name: string; oid: string }> = [];
  for (const [name, oid] of repo.refs) refs.push({ name, oid });
  refs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return refs;
}

/** Peel a ref to its commit: tag objects resolve through, commits stay. */
function peelToCommit(repo: Repo, oid: string): string | null {
  let current = oid;
  for (let depth = 0; depth < 10; depth += 1) {
    const object = repo.objects.get(current);
    if (!object) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      current = parseTag(object.data).object;
      continue;
    }
    return null;
  }
  return null;
}

function uploadPackCapsV0(): string {
  return 'symref=HEAD:refs/heads/main side-band-64k shallow thin-pack ofs-delta multi_ack agent=git-forge/0.1.0';
}

function receivePackCapsV0(): string {
  return 'report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=git-forge/0.1.0';
}

function advertisementV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const parts: Buffer[] = [encodePktLine(`# service=${service}\n`), pktFlush()];
  const caps = service === 'git-upload-pack' ? uploadPackCapsV0() : receivePackCapsV0();
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headTip = repo.refs.get('refs/heads/main');
    const lines: string[] = [];
    if (headTip !== undefined) lines.push(`${headTip} HEAD\0${caps}\n`);
    for (const ref of refs) {
      lines.push(`${ref.oid} ${ref.name}\n`);
      const object = repo.objects.get(ref.oid);
      if (object && object.type === 'tag') {
        const peeled = peelToCommit(repo, ref.oid);
        if (peeled !== null) lines.push(`${peeled} ${ref.name}^{}\n`);
      }
    }
    if (headTip === undefined) {
      // No main yet: caps ride the first ref line.
      if (lines.length > 0) lines[0] = `${lines[0]!.replace(/\n$/, '')}\0${caps}\n`;
      else lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
    }
    for (const line of lines) parts.push(encodePktLine(line));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function advertisementV2(): Buffer {
  const lines = [
    'version 2\n',
    'agent=git-forge/0.1.0\n',
    'ls-refs=unborn\n',
    'fetch=shallow\n',
    'object-format=sha1\n',
  ];
  const parts = lines.map((line) => encodePktLine(line));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

async function handleGitInfoRefs(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  owner: string,
  name: string,
): Promise<boolean> {
  if (!authed(req)) {
    errJson(res, 401, 'Requires authentication');
    return true;
  }
  const repo = getRepo(owner, name);
  if (repo === undefined) {
    errJson(res, 404, 'Not Found');
    return true;
  }
  const service = url.searchParams.get('service');
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    errJson(res, 404, 'Not Found');
    return true;
  }
  const wantsV2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '') === 'version=2';
  const contentType =
    service === 'git-upload-pack' ? 'application/x-git-upload-pack-advertisement' : 'application/x-git-receive-pack-advertisement';
  const body = wantsV2 ? advertisementV2() : advertisementV0(repo, service);
  sendRaw(res, 200, body, contentType);
  return true;
}

interface FetchSelection {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
}

/** Objects to send for `wants`, minus what `haves` reach, honoring `depth` generations. */
function selectFetchObjects(repo: Repo, wants: string[], haves: string[], shallowBefore: string[], depth: number | null): FetchSelection {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  // A have that is also a shallow boundary is held only as a shallow commit:
  // its tree is held, its parents are not, so they must still be delivered.
  const haveReachable = collectReachable(haves, lookup, true, new Set(shallowBefore));
  // Commit generations from the wants (0 = the wants themselves).
  const commitDepth = new Map<string, number>();
  const queue: Array<{ oid: string; depth: number }> = [];
  for (const want of wants) {
    const object = repo.objects.get(want);
    if (!object) continue;
    if (object.type === 'tag') {
      const target = parseTag(object.data).object;
      queue.push({ oid: target, depth: 0 });
      commitDepth.set(want, 0);
    } else if (object.type === 'commit') {
      queue.push({ oid: want, depth: 0 });
    }
  }
  const includedCommits = new Set<string>();
  while (queue.length) {
    const { oid, depth: d } = queue.shift()!;
    if (commitDepth.has(oid) && commitDepth.get(oid)! <= d) continue;
    commitDepth.set(oid, d);
    includedCommits.add(oid);
    if (depth !== null && d + 1 >= depth) continue;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push({ oid: parent, depth: d + 1 });
  }
  // Roots for the object walk: wanted tag objects plus the included commits.
  const roots: string[] = [];
  for (const want of wants) {
    const object = repo.objects.get(want);
    if (object && object.type === 'tag') roots.push(want);
  }
  for (const oid of includedCommits) roots.push(oid);
  let reachable: Set<string>;
  if (depth === null) {
    reachable = collectReachable(roots, lookup, true);
  } else {
    // Only the trees/blobs of included commits (not of excluded parents).
    reachable = new Set<string>();
    for (const root of roots) {
      const object = repo.objects.get(root);
      if (!object) continue;
      reachable.add(root);
      if (object.type === 'tag') {
        const target = parseTag(object.data).object;
        if (includedCommits.has(target)) reachable.add(target);
      }
      if (object.type === 'commit' && includedCommits.has(root)) {
        const tree = parseCommit(object.data).tree;
        for (const oid of collectReachable([tree], lookup, true)) reachable.add(oid);
      }
    }
  }
  const objects: GitObject[] = [];
  for (const oid of reachable) {
    if (haveReachable.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object) objects.push(object);
  }
  // Shallow boundary: included commits whose parents were cut off (depth-limited only).
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (depth !== null) {
    for (const oid of includedCommits) {
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents;
      const cut = parents.some((parent) => !includedCommits.has(parent));
      if (cut || parents.length === 0) shallow.push(oid);
    }
    for (const boundary of shallowBefore) {
      if (includedCommits.has(boundary)) {
        const object = repo.objects.get(boundary);
        if (object && object.type === 'commit') {
          const parents = parseCommit(object.data).parents;
          if (parents.some((parent) => includedCommits.has(parent))) unshallow.push(boundary);
        }
      }
    }
  }
  return { objects, shallow, unshallow };
}

/** Split pack bytes into sideband band-1 pkt-lines (each <= 65520 bytes on the wire). */
function sidebandPack(pack: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  const CHUNK = PKT_LINE_MAX - 5; // 4 header bytes + 1 band byte
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    packets.push(encodePktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  return packets;
}

async function handleGitUploadPack(
  req: IncomingMessage,
  res: ServerResponse,
  body: Buffer,
  owner: string,
  name: string,
): Promise<boolean> {
  if (!authed(req)) {
    errJson(res, 401, 'Requires authentication');
    return true;
  }
  const repo = getRepo(owner, name);
  if (repo === undefined) {
    errJson(res, 404, 'Not Found');
    return true;
  }
  const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
  const { packets } = decodePktLines(body, true);
  const lines = packets.filter((p) => p.kind === 'data').map((p) => p.payload!.toString('utf8').replace(/\n$/, ''));
  if (lines.length === 0 || (!lines[0]!.startsWith('command=') && !lines[0]!.startsWith('want '))) {
    sendRaw(res, 400, Buffer.from('bad request', 'utf8'), 'text/plain');
    return true;
  }
  if (isV2 && lines[0] === 'command=ls-refs') {
    // v2 ls-refs
    let peel = false;
    let symrefs = false;
    let unborn = false;
    const prefixes: string[] = [];
    for (const line of lines.slice(1)) {
      if (line === 'peel') peel = true;
      else if (line === 'symrefs') symrefs = true;
      else if (line === 'unborn') unborn = true;
      else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
    }
    const out: Buffer[] = [];
    const headTip = repo.refs.get('refs/heads/main');
    const matches = (refName: string): boolean => prefixes.length === 0 || prefixes.some((p) => refName.startsWith(p));
    if (prefixes.length === 0) {
      if (headTip !== undefined) {
        out.push(encodePktLine(`${headTip} HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n`));
      } else if (unborn) {
        out.push(encodePktLine(`unborn HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n`));
      }
    }
    for (const ref of sortedRefs(repo)) {
      if (!matches(ref.name)) continue;
      let line = `${ref.oid} ${ref.name}`;
      if (peel) {
        const object = repo.objects.get(ref.oid);
        if (object && object.type === 'tag') {
          const peeled = peelToCommit(repo, ref.oid);
          if (peeled !== null) line += ` peeled:${peeled}`;
        }
      }
      out.push(encodePktLine(`${line}\n`));
    }
    out.push(pktFlush());
    sendRaw(res, 200, Buffer.concat(out), 'application/x-git-upload-pack-result');
    return true;
  }
  // fetch (v2 command=fetch, or v0 want lines)
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowBefore: string[] = [];
  let depth: number | null = null;
  if (isV2) {
    for (const line of lines.slice(1)) {
      if (line.startsWith('want ')) wants.push(line.slice(5).trim());
      else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
      else if (line.startsWith('shallow ')) shallowBefore.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) depth = Number(line.slice(7).trim());
    }
  } else {
    let seenFlush = false;
    for (const packet of packets) {
      if (packet.kind === 'flush') {
        seenFlush = true;
        continue;
      }
      if (packet.kind !== 'data') continue;
      const line = packet.payload!.toString('utf8').replace(/\n$/, '');
      if (!seenFlush) {
        if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0]!);
        else if (line.startsWith('shallow ')) shallowBefore.push(line.slice(8).trim());
        else if (line.startsWith('deepen ')) depth = Number(line.slice(7).trim());
      } else {
        if (line.startsWith('have ')) haves.push(line.slice(5).trim());
      }
    }
  }
  const selection = selectFetchObjects(repo, wants, haves, shallowBefore, depth);
  const pack = selection.objects.length > 0 ? writePack(selection.objects) : null;
  if (isV2) {
    const out: Buffer[] = [];
    out.push(encodePktLine('acknowledgments\n'));
    const acked = haves.find((have) => {
      for (const want of wants) if (isAncestor(repo, have, want) || have === want) return true;
      return false;
    });
    if (acked !== undefined) {
      out.push(encodePktLine(`ACK ${acked}\n`));
      out.push(encodePktLine('ready\n'));
    } else {
      out.push(encodePktLine('NAK\n'));
    }
    out.push(pktFlush());
    if (selection.shallow.length > 0 || selection.unshallow.length > 0) {
      out.push(encodePktLine('shallow-info\n'));
      for (const oid of selection.shallow) out.push(encodePktLine(`shallow ${oid}\n`));
      for (const oid of selection.unshallow) out.push(encodePktLine(`unshallow ${oid}\n`));
      out.push(pktFlush());
    }
    if (pack !== null) {
      out.push(encodePktLine('packfile\n'));
      out.push(...sidebandPack(pack));
      out.push(pktFlush());
    }
    sendRaw(res, 200, Buffer.concat(out), 'application/x-git-upload-pack-result');
    return true;
  }
  // v0 fetch: NAK/ACK + shallow lines as bare packets, then the sideband pack.
  const out: Buffer[] = [];
  const acked = haves.find((have) => {
    for (const want of wants) if (isAncestor(repo, have, want) || have === want) return true;
    return false;
  });
  if (acked !== undefined) out.push(encodePktLine(`ACK ${acked}\n`));
  else out.push(encodePktLine('NAK\n'));
  for (const oid of selection.shallow) out.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of selection.unshallow) out.push(encodePktLine(`unshallow ${oid}\n`));
  if (pack !== null) out.push(...sidebandPack(pack));
  sendRaw(res, 200, Buffer.concat(out), 'application/x-git-upload-pack-result');
  return true;
}

async function handleGitReceivePack(
  req: IncomingMessage,
  res: ServerResponse,
  body: Buffer,
  owner: string,
  name: string,
): Promise<boolean> {
  if (!authed(req)) {
    errJson(res, 401, 'Requires authentication');
    return true;
  }
  const repo = getRepo(owner, name);
  if (repo === undefined) {
    errJson(res, 404, 'Not Found');
    return true;
  }
  const { packets, rest } = decodePktLines(body);
  const commandLines = packets.filter((p) => p.kind === 'data').map((p) => p.payload!.toString('utf8'));
  if (commandLines.length === 0) {
    sendRaw(res, 400, Buffer.from('bad request', 'utf8'), 'text/plain');
    return true;
  }
  interface Command {
    oldOid: string;
    newOid: string;
    ref: string;
  }
  const commands: Command[] = [];
  for (const line of commandLines) {
    const clean = line.replace(/\n$/, '');
    const nul = clean.indexOf('\0');
    const head = nul >= 0 ? clean.slice(0, nul) : clean;
    const parts = head.split(' ');
    if (parts.length < 3 || !isOid(parts[0]!) || !isOid(parts[1]!)) continue;
    commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts.slice(2).join(' ') });
  }
  // Store the pack first: a refused ref still unpacks.
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (rest.length > 0) {
    try {
      const read = readPack(rest, (oid) => repo.objects.get(oid));
      for (const [oid, object] of read.objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : String(err);
    }
  }
  const reportLines: string[] = [];
  if (!unpackOk) {
    reportLines.push(`unpack ${unpackDetail}\n`);
    for (const command of commands) reportLines.push(`ng ${command.ref} unpack failed\n`);
  } else {
    reportLines.push('unpack ok\n');
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      const evaluate = (): string | null => {
        if (command.newOid === ZERO_OID) {
          // Delete.
          if (current === undefined) return command.oldOid === ZERO_OID ? null : 'non-fast-forward';
          if (command.oldOid !== ZERO_OID && command.oldOid !== current) return 'non-fast-forward';
          return null;
        }
        const object = repo.objects.get(command.newOid);
        if (object === undefined) return 'missing object';
        if (command.oldOid === ZERO_OID) {
          if (current !== undefined) return 'non-fast-forward';
          return null;
        }
        if (current === undefined || command.oldOid !== current) return 'non-fast-forward';
        if (command.ref.startsWith('refs/heads/')) {
          if (object.type !== 'commit') return 'non-fast-forward';
          if (!isAncestor(repo, current, command.newOid)) return 'non-fast-forward';
        }
        return null;
      };
      const reason = evaluate();
      if (reason === null) {
        if (command.newOid === ZERO_OID) repo.refs.delete(command.ref);
        else repo.refs.set(command.ref, command.newOid);
        reportLines.push(`ok ${command.ref}\n`);
      } else {
        reportLines.push(`ng ${command.ref} ${reason}\n`);
      }
    }
  }
  const inner = Buffer.concat([...reportLines.map((line) => encodePktLine(line)), pktFlush()]);
  const firstLine = commandLines[0] ?? '';
  const wantsSideband = firstLine.includes('side-band-64k');
  let out: Buffer;
  if (wantsSideband) {
    const packetsOut: Buffer[] = [];
    const CHUNK = PKT_LINE_MAX - 5;
    for (let offset = 0; offset < inner.length; offset += CHUNK) {
      const slice = inner.subarray(offset, Math.min(inner.length, offset + CHUNK));
      packetsOut.push(encodePktLine(Buffer.concat([Buffer.from([1]), slice])));
    }
    packetsOut.push(pktFlush());
    out = Buffer.concat(packetsOut);
  } else {
    out = inner;
  }
  sendRaw(res, 200, out, 'application/x-git-receive-pack-result');
  return true;
}

// ---------------------------------------------------------------------------
// the server
// ---------------------------------------------------------------------------

export function createApp(): ReturnType<typeof createServer> {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const url = urlOf(req);
        const path = url.pathname;
        const method = req.method ?? 'GET';
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }
        // Every request body is consumed, including a DELETE's: an unread body
        // would corrupt the next request on a keep-alive connection.
        const body = await readBody(req);
        // Git smart HTTP: /{owner}/{repo}.git/...
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.*)$/.exec(path);
        if (gitMatch !== null) {
          const owner = decodeURIComponent(gitMatch[1]!);
          const name = decodeURIComponent(gitMatch[2]!);
          const tail = gitMatch[3]!;
          if (tail === 'info/refs' && method === 'GET') {
            await handleGitInfoRefs(req, res, url, owner, name);
            return;
          }
          if (tail === 'git-upload-pack' && method === 'POST') {
            await handleGitUploadPack(req, res, body, owner, name);
            return;
          }
          if (tail === 'git-receive-pack' && method === 'POST') {
            await handleGitReceivePack(req, res, body, owner, name);
            return;
          }
          errJson(res, 404, 'Not Found');
          return;
        }
        // GraphQL v4.
        if (path === '/api/graphql') {
          await handleGraphQL(req, res, body);
          return;
        }
        // MCP.
        if (path === '/mcp') {
          await handleMcp(req, res, body);
          return;
        }
        // REST v3.
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          const handled = await handleRest(req, res, url, body);
          if (handled) return;
          errJson(res, 404, 'Not Found');
          return;
        }
        errJson(res, 404, 'Not Found');
      } catch (err) {
        // A request must never take the server down with it.
        try {
          errJson(res, 500, err instanceof Error ? err.message : String(err));
        } catch {
          // The response is already gone; nothing left to do.
        }
      }
    })();
  });
}
