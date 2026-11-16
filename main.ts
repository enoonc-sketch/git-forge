// Entry point for the forge server.
//
// The harness hands us its own base URL through MAKEFUN_ENV_URL. We start
// the app on a kernel-chosen port, tell the harness which port that is, and
// then sit quietly until the harness says the run is over. Nothing here
// decides when to stop except the harness itself.

import { createApp } from './app.ts';

// How long one HTTP round trip may take before we give up on it.
const REQUEST_TIMEOUT_MS = 30_000;
// Backoff between retries: start small, double each time, never exceed this.
const FIRST_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 2_000;

// Next wait after a failed attempt: double the previous wait, capped.
function growDelay(current: number): number {
  return Math.min(current * 2, MAX_BACKOFF_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// One fetch guarded by a timeout, so a hung harness can never wedge us.
async function timedFetch(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}

// Keep calling `attempt` until it reports success. `attempt` returns true
// when the step is done, and throws a ContractError when the harness
// answered in a way that means our request itself was wrong (those are not
// retried). Any other failure -- network blip, odd status, timeout -- waits
// with exponential backoff and tries again.
class ContractError extends Error {}

async function retryUntilDone(attempt: () => Promise<boolean>): Promise<void> {
  let delay = FIRST_BACKOFF_MS;
  for (;;) {
    try {
      if (await attempt()) return;
    } catch (err) {
      if (err instanceof ContractError) throw err;
      // Anything else is transient: fall through to the backoff below.
    }
    await sleep(delay);
    delay = growDelay(delay);
  }
}

// Tell the harness which port we are listening on. 200 means it recorded
// us; 409 means somebody else already registered, which is fine too.
// 400/405 mean our request broke the contract, so fail loudly instead of
// retrying forever.
async function register(envUrl: string, port: number): Promise<void> {
  await retryUntilDone(async () => {
    const res = await timedFetch(`${envUrl}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port }),
    });
    if (res.status === 200 || res.status === 409) return true;
    if (res.status === 400 || res.status === 405) {
      throw new ContractError(`register rejected with status ${res.status}`);
    }
    return false;
  });
}

// Ask the harness again and again whether the run is finished. A bad
// response, a dropped connection, or a timeout just means "ask later".
async function waitForDone(envUrl: string): Promise<void> {
  await retryUntilDone(async () => {
    const res = await timedFetch(`${envUrl}/done`, { method: 'GET' });
    if (!res.ok) return false;
    const payload: unknown = await res.json();
    return (
      typeof payload === 'object' &&
      payload !== null &&
      (payload as { done?: unknown }).done === true
    );
  });
}

async function main(): Promise<void> {
  const envUrl = process.env.MAKEFUN_ENV_URL;
  if (!envUrl) {
    process.stderr.write('MAKEFUN_ENV_URL is not set; cannot register with the harness.\n');
    process.exit(1);
  }

  // Port 0 lets the kernel pick a free port; 8080 belongs to the harness
  // and must never be claimed by us.
  const server = createApp();
  await new Promise<void>((resolve) => {
    server.listen(0, () => resolve());
  });
  const bound = server.address();
  const port = typeof bound === 'object' && bound !== null ? bound.port : 0;

  await register(envUrl, port);
  await waitForDone(envUrl);

  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

try {
  await main();
  process.exit(0);
} catch (err) {
  process.stderr.write(`entrypoint failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
