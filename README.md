# git-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/enoonc-sketch/git-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/enoonc-sketch/git-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node.js process: git smart HTTP (protocol v2 and v0), REST v3, GraphQL v4 and MCP, over one in-memory store. Clone, push, branch, tag, shallow fetch and deepen; repositories, issues, comments, labels, pull requests, squash merges with conflict detection; the same objects readable over every surface. No dependencies, no install step, no network, no wall clock — every run replays byte-for-byte.

## Run it

```sh
node --experimental-strip-types main.ts
```

Requires Node.js 22 or later. There is nothing to install: the program imports `node:http` and its own `app.ts` only, and the trial has no package manager and no internet. The platform runs `node /bot/main.ts` on Node 22, which strips TypeScript types on its own.

## The lifecycle (main.ts)

The env is a server the harness starts beside yours. Its origin is in `MAKEFUN_ENV_URL` (`http://store:8080` in a trial).

1. **Bind an ephemeral port.** `server.listen(0)` lets the kernel pick one; read it with `server.address().port`. Never bind 8080: that is the env's port, and on the one-pod layout it is on the same loopback.
2. **Register.** `POST $MAKEFUN_ENV_URL/register` with `{"port": <the port you bound>}`, as JSON. The env records the address the request came from plus that port as your base URL and dials it from then on. The first register wins: a later one is answered `409` and does not move the base URL.
3. **Wait for done.** `GET $MAKEFUN_ENV_URL/done` answers at once with `{"done":false}` while the suite runs and `{"done":true}` once its export is written. Poll it with a short backoff; never hold a request open, and never exit before it says `true`.
4. **Exit 0** when it does. Closing the server first is tidy; the harness stops the env afterwards, and the env's export is what the scorer reads.

A failed poll or register is retried with a short exponential backoff. If `MAKEFUN_ENV_URL` is unset there is nothing to talk to, so `main.ts` exits 1 at once.

## The surface

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}`: the env's boot probe, called twice |
| `GET /api/v3/` | 200, `X-Oauth-Scopes: repo, read:org`, a JSON API root |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents, issues, comments, labels, pull requests, files, merges |
| `POST /api/graphql` | GitHub GraphQL v4: viewer, repository, issues, pull requests, mutations, `__type` introspection, batched operations, opaque global ids |
| `POST /mcp` | Model Context Protocol over streamable HTTP (2026-07-28): `server/discover`, `initialize`, `tools/list`, `tools/call` — `create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request` |
| `/<owner>/<repo>.git/...` | git smart HTTP: `info/refs`, `git-upload-pack` (v2 and v0), `git-receive-pack` (v0) |
| anything else | 404 `{"message":"Not Found"}` |

The env presents every API call with `Authorization: Bearer $MAKEFUN_SHOP_TOKEN` (the same token is in your environment); `/healthz` is the boot probe and takes none. A missing or wrong token is refused with 401; a repository under another owner is 404, never 403; every reply is `application/json` with a non-empty `X-GitHub-Request-Id`.

## Scores (practice trials, local)

- Sealed suite (`sdk/run.ts`): **120/120 checks** — feature 600, agent 200.
- `grade-local`, 3 practice trials: **865 mean** (861–869), replay matched byte-for-byte on all three, 3/3 stores working.
- Unit tests: `node --experimental-strip-types --test tests/unit.test.mjs` — 11/11.

## Rules and limits

The rules, the scoring weights, the deadline and the prizes are on the contest page: **https://make.fun/bounty/github-core-clone-01** (its Rules section). In short: Node 22 only, no dependencies at run time, no internet and no `git` binary in the trial; your repository is mounted read-only at `/bot` and you may write under `/tmp` only. The trial's CPU, memory and process limits are the rules'; its wall budget is 900 seconds.

## Layout

- `main.ts`: the lifecycle above. Keep it as it is.
- `app.ts`: the server — git primitives (pack reading/writing, deltas, pkt-lines), the in-memory store, REST v3, GraphQL v4 and MCP.
- `tests/unit.test.mjs`: unit tests for the git primitives and the store (pkt-lines, hashing, trees, commits, packs, deltas, squash merge, global ids).
- `package.json`, `tsconfig.json`, `LICENSE` (MIT): the entry's metadata and licence.

---

<sub>Entered on [make.fun](https://make.fun/?ref=cs36dnd5&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
