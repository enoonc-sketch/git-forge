// Unit tests for git-forge's git primitives and store logic.
// Run: node --experimental-strip-types --test tests/unit.test.mjs
// (Node 22; the entry itself is stdlib-only, so no install step exists.)

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import {
  hashObject,
  buildTree,
  parseTree,
  buildCommit,
  parseCommit,
  collectReachable,
  encodePktLine,
  pktFlush,
  pktDelim,
  decodePktLines,
  applyDelta,
  readPack,
  writePack,
  diffLines,
  createRepoRecord,
  createIssueIn,
  createPullIn,
  commitFile,
  pullFiles,
  pullMergeable,
  squashMerge,
  flattenTree,
  repoGlobalId,
  issueGlobalId,
  decodeGlobalId,
} from '../app.ts';

test('pkt-line: encode/decode round-trips, flush stops decoding, all=true reads two sections', () => {
  const body = Buffer.concat([
    encodePktLine('want abc\n'),
    encodePktLine('done\n'),
    pktFlush(),
    encodePktLine('have def\n'),
    pktFlush(),
  ]);
  const first = decodePktLines(body);
  assert.equal(first.packets.length, 3); // want, done, flush
  const all = decodePktLines(body, true);
  assert.equal(all.packets.filter((p) => p.kind === 'data').length, 3);
  assert.equal(all.packets.filter((p) => p.kind === 'flush').length, 2);
  const delim = Buffer.concat([encodePktLine('command=fetch\n'), pktDelim(), encodePktLine('done\n'), pktFlush()]);
  const parsed = decodePktLines(delim, true);
  assert.equal(parsed.packets[1].kind, 'delim');
  assert.equal(parsed.packets[2].payload.toString(), 'done\n');
});

test("hashObject: the empty blob has git's well-known id", () => {
  assert.equal(hashObject('blob', Buffer.alloc(0)), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
  assert.equal(hashObject('blob', Buffer.from('hello\n')), 'ce013625030ba8dba906f756967f9e9ca394464a');
});

test('tree: build sorts directories as name/ and parse returns the entries', () => {
  const blobA = hashObject('blob', Buffer.from('a'));
  const blobB = hashObject('blob', Buffer.from('b'));
  const sub = hashObject('tree', buildTree([{ mode: '100644', name: 'x.txt', oid: blobB }]));
  const data = buildTree([
    { mode: '100644', name: 'b.txt', oid: blobA },
    { mode: '40000', name: 'a-dir', oid: sub },
    { mode: '100644', name: 'a.txt', oid: blobA },
  ]);
  const entries = parseTree(data);
  assert.deepEqual(entries.map((e) => e.name), ['a-dir', 'a.txt', 'b.txt']);
  assert.equal(entries[0].mode, '40000');
});

test('commit: build/parse round-trips parents, message and timestamps', () => {
  const tree = hashObject('tree', buildTree([]));
  const data = buildCommit({ tree, parents: ['a'.repeat(40)], message: 'hello\n', timestamp: 1700000000 });
  const view = parseCommit(data);
  assert.equal(view.tree, tree);
  assert.deepEqual(view.parents, ['a'.repeat(40)]);
  assert.equal(view.message, 'hello\n');
  assert.ok(view.author.includes('1700000000 +0000'));
});

test('pack: write/read round-trips a commit graph and verifies the trailer', () => {
  const blob = { type: 'blob', data: Buffer.from('content\n') };
  const blobOid = hashObject('blob', blob.data);
  const tree = { type: 'tree', data: buildTree([{ mode: '100644', name: 'f.txt', oid: blobOid }]) };
  const treeOid = hashObject('tree', tree.data);
  const commit = { type: 'commit', data: buildCommit({ tree: treeOid, message: 'c1\n' }) };
  const commitOid = hashObject('commit', commit.data);
  const pack = writePack([commit, tree, blob]);
  const read = readPack(pack);
  assert.equal(read.objects.size, 3);
  assert.equal(read.deltaCount, 0);
  assert.ok(read.objects.get(commitOid).data.equals(commit.data));
  assert.ok(read.objects.get(blobOid).data.equals(blob.data));
  // A truncated pack is refused.
  assert.throws(() => readPack(pack.subarray(0, pack.length - 5)), /trailer|too short/);
  // Reachability walks commit -> tree -> blob.
  const reachable = collectReachable([commitOid], (oid) => read.objects.get(oid));
  assert.equal(reachable.size, 3);
});

test('delta: applyDelta copies and inserts, and a REF_DELTA pack resolves', () => {
  const base = Buffer.from('hello world, this is the base text.\n'); // 36 bytes
  const baseOid = hashObject('blob', base);
  // Delta: source size 36, target size 42: copy 0..12, insert " brave", copy 12..36.
  const delta = Buffer.concat([
    Buffer.from([36, 42]),
    Buffer.from([0x90, 0x0c]),
    Buffer.from([0x06]),
    Buffer.from(' brave', 'utf8'),
    Buffer.from([0x91, 0x0c, 0x18]),
  ]);
  assert.equal(applyDelta(base, delta).toString('utf8'), 'hello world, brave this is the base text.\n');
  // Hand-build a pack: [full base blob][ref-delta -> base].
  const packObjectHeader = (typeCode, size) => {
    const bytes = [];
    let remaining = size;
    let first = (typeCode << 4) | (remaining & 0x0f);
    remaining = Math.floor(remaining / 16);
    while (remaining > 0) {
      bytes.push(first | 0x80);
      first = remaining & 0x7f;
      remaining = Math.floor(remaining / 128);
    }
    bytes.push(first);
    return Buffer.from(bytes);
  };
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(2, 8);
  const body = Buffer.concat([
    header,
    packObjectHeader(3, base.length),
    deflateSync(base),
    packObjectHeader(7, delta.length),
    Buffer.from(baseOid, 'hex'),
    deflateSync(delta),
  ]);
  const pack = Buffer.concat([body, createHash('sha1').update(body).digest()]);
  const read = readPack(pack);
  assert.equal(read.objects.size, 2);
  assert.equal(read.deltaCount, 1);
  const newOid = hashObject('blob', Buffer.from('hello world, brave this is the base text.\n'));
  assert.ok(read.objects.get(newOid).data.equals(Buffer.from('hello world, brave this is the base text.\n')));
});

test('collectReachable: stopAtParents holds the boundary commit and its tree, not its parents', () => {
  const objects = new Map();
  const add = (type, data) => {
    const oid = hashObject(type, data);
    objects.set(oid, { type, data });
    return oid;
  };
  const blob1 = add('blob', Buffer.from('one\n'));
  const tree1 = add('tree', buildTree([{ mode: '100644', name: 'f.txt', oid: blob1 }]));
  const c1 = add('commit', buildCommit({ tree: tree1, message: 'c1\n' }));
  const blob2 = add('blob', Buffer.from('two\n'));
  const tree2 = add('tree', buildTree([{ mode: '100644', name: 'f.txt', oid: blob2 }]));
  const c2 = add('commit', buildCommit({ tree: tree2, parents: [c1], message: 'c2\n' }));
  const blob3 = add('blob', Buffer.from('three\n'));
  const tree3 = add('tree', buildTree([{ mode: '100644', name: 'f.txt', oid: blob3 }]));
  const c3 = add('commit', buildCommit({ tree: tree3, parents: [c2], message: 'c3\n' }));
  const lookup = (oid) => objects.get(oid);
  const full = collectReachable([c3], lookup);
  assert.ok(full.has(c1) && full.has(c2) && full.has(c3));
  // c3 is a shallow boundary: held with its tree, parents not traversed.
  const stopped = collectReachable([c3], lookup, true, new Set([c3]));
  assert.ok(stopped.has(c3) && stopped.has(tree3) && stopped.has(blob3));
  assert.ok(!stopped.has(c2) && !stopped.has(c1));
  // Stopping at the middle commit keeps it but drops the grandparent.
  const mid = collectReachable([c3], lookup, true, new Set([c2]));
  assert.ok(mid.has(c3) && mid.has(c2) && !mid.has(c1));
});

test('diffLines: added/removed counts follow an LCS diff', () => {
  assert.deepEqual(diffLines('', 'a\nb\n'), { additions: 2, deletions: 0 });
  assert.deepEqual(diffLines('a\nb\n', 'a\nc\n'), { additions: 1, deletions: 1 });
  assert.deepEqual(diffLines('a\n', 'a\n'), { additions: 0, deletions: 0 });
});

test('store: issues share one counter with pull requests; labels are validated', () => {
  const repo = createRepoRecord('unit-test-repo', true, 'test');
  const first = createIssueIn(repo, 'one', 'body', ['bug']);
  assert.ok(!('error' in first) && first.number === 1);
  const bad = createIssueIn(repo, 'two', 'body', ['no-such-label']);
  assert.ok('error' in bad);
  const second = createIssueIn(repo, 'two', 'body', []);
  assert.ok(!('error' in second) && second.number === 2);
});

test('store: squash merge applies the head tree and a conflicting second merge fails', () => {
  const repo = createRepoRecord('unit-merge-repo', true, 'test');
  commitFile(repo, 'main', 'f.txt', Buffer.from('base\n'), 'base');
  repo.refs.set('refs/heads/a', repo.refs.get('refs/heads/main'));
  repo.refs.set('refs/heads/b', repo.refs.get('refs/heads/main'));
  commitFile(repo, 'a', 'f.txt', Buffer.from('aaa\n'), 'a change');
  commitFile(repo, 'b', 'f.txt', Buffer.from('bbb\n'), 'b change');
  const prA = createPullIn(repo, 'A', '', 'a', 'main');
  const prB = createPullIn(repo, 'B', '', 'b', 'main');
  assert.ok(!('error' in prA) && !('error' in prB));
  assert.equal(pullMergeable(repo, prA), 'MERGEABLE');
  const files = pullFiles(repo, prA);
  assert.equal(files.length, 1);
  assert.equal(files[0].filename, 'f.txt');
  assert.equal(files[0].status, 'modified');
  assert.ok(files[0].additions >= 1);
  const sha = squashMerge(repo, prA);
  assert.ok(typeof sha === 'string' && sha.length === 40);
  assert.equal(prA.merged, true);
  assert.equal(prA.state, 'closed');
  // The merged content is on the default branch now.
  const mainTip = repo.refs.get('refs/heads/main');
  const mainTree = parseCommit(repo.objects.get(mainTip).data).tree;
  const mainFiles = flattenTree(repo, mainTree);
  const blob = repo.objects.get(mainFiles.get('f.txt').oid);
  assert.equal(blob.data.toString('utf8'), 'aaa\n');
  // The second pull request now conflicts: same file, different content on both sides.
  assert.equal(pullMergeable(repo, prB), 'CONFLICTING');
  assert.equal(squashMerge(repo, prB), null);
  assert.equal(prB.merged, false);
});

test('global ids: opaque, stable, and round-trip through decodeGlobalId', () => {
  const repo = createRepoRecord('unit-ids-repo', true, 'test');
  const issue = createIssueIn(repo, 'x', 'y', []);
  assert.ok(!('error' in issue));
  const repoId = repoGlobalId(repo);
  assert.notEqual(repoId, String(repo.id));
  assert.equal(repoGlobalId(repo), repoId);
  assert.deepEqual(decodeGlobalId(repoId), { kind: 'R', owner: 'adaiversen', name: 'unit-ids-repo' });
  const issueId = issueGlobalId(repo, issue);
  assert.notEqual(issueId, String(issue.number));
  assert.deepEqual(decodeGlobalId(issueId), { kind: 'I', owner: 'adaiversen', name: 'unit-ids-repo', number: issue.number });
  assert.equal(decodeGlobalId('!!!not-base64!!!'), null);
});
