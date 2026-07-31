import test from "node:test";
import assert from "node:assert/strict";

import {
  POLL_INTERVAL_MS,
  createRefreshGate,
  deepEqual,
  refresh,
  startPolling,
  type PollTimers,
  type RefreshGate,
  type RefreshMode,
  type RefreshSinks,
} from "./poll.ts";

/**
 * Tests for the stale-while-revalidate poll helper.
 *
 * ⚠️ NO FROZEN CLOCK ANYWHERE IN HERE. An earlier test in this repo hung forever because it combined
 * a `now: () => 0` with a poll loop. `refresh` has no clock at all, and `startPolling` takes its
 * timers by injection so a test advances them by hand rather than waiting on a real one.
 */

interface Recorder<T> {
  sinks: RefreshSinks<T>;
  /** Ordered log of every sink call, which is what the flicker bug is actually about. */
  calls: string[];
  data: T;
  isLoading: boolean;
  isRefreshing: boolean;
  error: string | null;
}

function recorder<T>(initial: T): Recorder<T> {
  const r: Recorder<T> = {
    calls: [],
    data: initial,
    isLoading: false,
    isRefreshing: false,
    error: null,
    sinks: {
      setData: (next) => {
        r.calls.push(`setData(${JSON.stringify(next)})`);
        r.data = next;
      },
      setLoading: (v) => {
        r.calls.push(`setLoading(${v})`);
        r.isLoading = v;
      },
      setRefreshing: (v) => {
        r.calls.push(`setRefreshing(${v})`);
        r.isRefreshing = v;
      },
      setError: (v) => {
        r.calls.push(`setError(${v === null ? "null" : JSON.stringify(v)})`);
        r.error = v;
      },
    },
  };
  return r;
}

function run<T>(r: Recorder<T>, mode: RefreshMode, load: () => Promise<T>) {
  return refresh<T>({
    mode,
    sinks: r.sinks,
    load,
    previous: () => r.data,
    message: (err) => (err instanceof Error ? err.message : "boom"),
  });
}

const A = [{ cid: "a", title: "one" }];
const B = [
  { cid: "a", title: "one" },
  { cid: "b", title: "two" },
];

// ---------------------------------------------------------------- cold vs background

test("a COLD load raises isLoading, a background one does not", async () => {
  const cold = recorder<typeof A>([]);
  await run(cold, "cold", async () => A);
  assert.deepEqual(cold.calls, [
    "setLoading(true)",
    "setError(null)",
    `setData(${JSON.stringify(A)})`,
    "setError(null)",
    "setLoading(false)",
  ]);

  const bg = recorder<typeof A>(A);
  await run(bg, "background", async () => B);
  assert.deepEqual(bg.calls, [
    "setRefreshing(true)",
    `setData(${JSON.stringify(B)})`,
    "setError(null)",
    "setRefreshing(false)",
  ]);
  // ⛔ THE FLICKER ASSERTION. Not one loading transition, and no empty commit, on a background pass.
  assert.ok(!bg.calls.some((c) => c.startsWith("setLoading")));
});

test("a background refresh NEVER empties the list before fetching", async () => {
  const r = recorder<typeof A>(A);
  let dataDuringFetch: unknown;
  await run(r, "background", async () => {
    // Sampled at the moment the old code had already called setThreads([]) + setIsLoading(true).
    dataDuringFetch = r.data;
    return B;
  });
  assert.deepEqual(dataDuringFetch, A, "the list must still be populated while the fetch is in air");
});

test("the background flag is raised and lowered around the fetch", async () => {
  const r = recorder<typeof A>(A);
  let flagDuringFetch = false;
  await run(r, "background", async () => {
    flagDuringFetch = r.isRefreshing;
    return B;
  });
  assert.equal(flagDuringFetch, true);
  assert.equal(r.isRefreshing, false);
  assert.equal(r.isLoading, false);
});

test("mode is explicit, never inferred from emptiness — an empty list can poll in background", async () => {
  // The guard against the "infer background from an empty array" shortcut: a genuinely empty list
  // that polls would otherwise alternate between the two behaviours forever.
  const r = recorder<typeof A>([]);
  await run(r, "background", async () => []);
  assert.ok(!r.calls.some((c) => c.startsWith("setLoading")));
  assert.ok(!r.calls.some((c) => c.startsWith("setData")), "nothing changed, nothing committed");
});

// ---------------------------------------------------------------- failure keeps last good data

test("a FAILED background refresh keeps the last good data", async () => {
  const r = recorder<typeof A>(A);
  await run(r, "background", async () => {
    throw new Error("rpc exploded");
  });
  assert.deepEqual(r.data, A, "content the user is reading must survive a failed poll");
  assert.ok(!r.calls.some((c) => c.startsWith("setData")));
  assert.equal(r.error, "rpc exploded");
  assert.equal(r.isRefreshing, false);
});

test("a FAILED cold load also leaves data alone, and reports", async () => {
  const r = recorder<typeof A>([]);
  await run(r, "cold", async () => {
    throw new Error("nope");
  });
  assert.ok(!r.calls.some((c) => c.startsWith("setData")));
  assert.equal(r.error, "nope");
  assert.equal(r.isLoading, false, "the loading flag must come down even on the failure path");
});

test("refresh never rejects — callers are fire-and-forget", async () => {
  const r = recorder<typeof A>(A);
  await assert.doesNotReject(() =>
    run(r, "background", async () => {
      throw new Error("still handled");
    })
  );
});

test("a non-Error throw still produces a message", async () => {
  const r = recorder<typeof A>(A);
  await refresh({
    mode: "background",
    sinks: r.sinks,
    load: async () => {
      throw "a bare string";
    },
    previous: () => r.data,
  });
  assert.equal(r.error, "Failed to load");
  assert.deepEqual(r.data, A);
});

test("a good refresh after a failure clears the error", async () => {
  const r = recorder<typeof A>(A);
  await run(r, "background", async () => {
    throw new Error("transient");
  });
  assert.equal(r.error, "transient");
  await run(r, "background", async () => B);
  assert.equal(r.error, null);
  assert.deepEqual(r.data, B);
});

test("onError sees the raw throw and runs before the error is committed", async () => {
  const r = recorder<typeof A>(A);
  const seen: unknown[] = [];
  const boom = new Error("raw");
  await refresh({
    mode: "background",
    sinks: r.sinks,
    load: async () => {
      throw boom;
    },
    previous: () => r.data,
    onError: (err) => {
      seen.push(err);
      assert.equal(r.error, null, "onError runs before setError");
    },
  });
  assert.deepEqual(seen, [boom]);
});

// ---------------------------------------------------------------- the equality skip

test("an identical result is not committed at all", async () => {
  const r = recorder<typeof A>(A);
  const before = r.data;
  // A FRESH array of FRESH objects, exactly what a poll produces from a re-decode.
  await run(r, "background", async () => A.map((t) => ({ ...t })));
  assert.ok(
    !r.calls.some((c) => c.startsWith("setData")),
    "identical data must not be handed to React — every row would re-render"
  );
  assert.equal(r.data, before, "object identity preserved, so memoised rows stay mounted");
});

test("a changed result IS committed", async () => {
  const r = recorder<typeof A>(A);
  await run(r, "background", async () => B);
  assert.deepEqual(r.data, B);
});

test("a real emptying is committed — an empty result is data, not a failure", async () => {
  const r = recorder<typeof A>(A);
  await run(r, "background", async () => []);
  assert.deepEqual(r.data, []);
});

test("a custom equality wins over deepEqual", async () => {
  const r = recorder<typeof A>(A);
  await refresh({
    mode: "background",
    sinks: r.sinks,
    load: async () => B,
    previous: () => r.data,
    equal: () => true, // "nothing ever changes"
  });
  assert.deepEqual(r.data, A);
});

test("previous() is read at compare time, not at spec time", async () => {
  // Guards the stale-closure trap: a hook that passed a captured useState value instead of a ref
  // would compare against data from two polls ago.
  const r = recorder<typeof A>([]);
  const spec = {
    mode: "background" as const,
    sinks: r.sinks,
    load: async () => A,
    previous: () => r.data,
  };
  await refresh(spec); // [] -> A, commits
  r.calls.length = 0;
  await refresh(spec); // A -> A, must skip
  assert.ok(!r.calls.some((c) => c.startsWith("setData")));
});

// ---------------------------------------------------------------- a just-published item appears

/** A deferred promise, so a test can resolve two overlapping fetches in a chosen order. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test("adding an item is never equal to the previous list, so a post-write reload always commits", () => {
  // The specific question behind switching the post-write reload to "background": could the
  // deep-equal skip suppress the commit that adds the reply the user just wrote? It cannot —
  // deepEqual bails on length before it compares any element.
  const before = [{ cid: "a", content: "one" }];
  const after = [...before, { cid: "b", content: "two" }];
  assert.ok(!deepEqual(before, after));
  // Also true for the empty-to-first-reply case, which is the most common publish of all.
  assert.ok(!deepEqual([], [{ cid: "a", content: "one" }]));
});

test("a post-write reload commits the new item on a BACKGROUND load", async () => {
  const existing = [{ cid: "a", content: "one" }];
  const withNew = [...existing, { cid: "b", content: "just published" }];
  const r = recorder(existing);
  await run(r, "background", async () => withNew);
  assert.deepEqual(r.data, withNew);
  assert.ok(!r.calls.some((c) => c.startsWith("setLoading")), "and without a loading flash");
});

test("an in-flight poll that resolves LATE cannot roll back a just-published item", async () => {
  // ⛔ THE REGRESSION THIS GUARDS. Poll starts first with a pre-write snapshot; the post-write
  // reload starts second and resolves FIRST; then the poll resolves with stale data. Without the
  // gate it commits, and the reply the user just wrote disappears for up to 30 seconds — silently,
  // because the write itself succeeded.
  const stale = [{ cid: "a", content: "one" }];
  const fresh = [...stale, { cid: "b", content: "just published" }];
  const r = recorder(stale);
  const gate: RefreshGate = createRefreshGate();

  const pollFetch = deferred<typeof stale>();
  const writeFetch = deferred<typeof stale>();

  const base = {
    sinks: r.sinks,
    previous: () => r.data,
    gate,
  };
  // 1. the poll enters the gate first
  const poll = refresh({ ...base, mode: "background" as const, load: () => pollFetch.promise });
  // 2. the post-write reload enters second
  const write = refresh({ ...base, mode: "background" as const, load: () => writeFetch.promise });

  // 3. the reload resolves first, with the new reply
  writeFetch.resolve(fresh);
  await write;
  assert.deepEqual(r.data, fresh);

  // 4. the poll resolves last, carrying the PRE-WRITE snapshot
  pollFetch.resolve(stale);
  await poll;

  assert.deepEqual(r.data, fresh, "the superseded poll must not roll the list back");
  assert.equal(r.isRefreshing, false, "and both refreshes must still lower the flag");
});

test("without a gate the stale poll DOES clobber — the gate is what prevents it", async () => {
  // Documents the default, so nobody assumes ordering they did not ask for.
  const stale = [{ cid: "a", content: "one" }];
  const fresh = [...stale, { cid: "b", content: "just published" }];
  const r = recorder(stale);
  const pollFetch = deferred<typeof stale>();
  const base = { sinks: r.sinks, previous: () => r.data };

  const poll = refresh({ ...base, mode: "background" as const, load: () => pollFetch.promise });
  await refresh({ ...base, mode: "background" as const, load: async () => fresh });
  assert.deepEqual(r.data, fresh);

  pollFetch.resolve(stale);
  await poll;
  assert.deepEqual(r.data, stale, "ungated, the older result wins simply by finishing last");
});

test("a superseded COLD load still lowers isLoading — no stuck spinner", async () => {
  // Gating the finally block would leave this true forever, because the newer refresh raised and
  // lowers only its OWN flag.
  const r = recorder<{ cid: string }[]>([]);
  const gate = createRefreshGate();
  const slow = deferred<{ cid: string }[]>();
  const base = { sinks: r.sinks, previous: () => r.data, gate };

  const cold = refresh({ ...base, mode: "cold" as const, load: () => slow.promise });
  assert.equal(r.isLoading, true);
  await refresh({ ...base, mode: "background" as const, load: async () => [{ cid: "a" }] });

  slow.resolve([{ cid: "zzz" }]);
  await cold;
  assert.equal(r.isLoading, false, "the superseded cold load must still clear its own flag");
  assert.deepEqual(r.data, [{ cid: "a" }], "but must not commit its stale data");
});

test("a superseded FAILURE does not overwrite a newer success's cleared error", async () => {
  const r = recorder([{ cid: "a" }]);
  const gate = createRefreshGate();
  const failing = deferred<{ cid: string }[]>();
  const seen: unknown[] = [];
  const base = { sinks: r.sinks, previous: () => r.data, gate };

  const old = refresh({
    ...base,
    mode: "background" as const,
    load: () => failing.promise.then(() => Promise.reject(new Error("stale failure"))),
    onError: (err) => seen.push(err),
  });
  await refresh({ ...base, mode: "background" as const, load: async () => [{ cid: "a" }, { cid: "b" }] });

  failing.resolve([]);
  await old;
  assert.equal(r.error, null, "a superseded error must not surface over a newer success");
  assert.equal(seen.length, 1, "but diagnostics still see it");
});

// ---------------------------------------------------------------- polling

test("startPolling ticks on the interval and stops on cleanup", () => {
  // A hand-advanced fake timer. No real clock, no frozen clock, no waiting.
  let nextId = 1;
  const registered = new Map<number, { handler: () => void; ms: number }>();
  const timers: PollTimers = {
    setInterval: (handler, ms) => {
      const id = nextId++;
      registered.set(id, { handler, ms });
      return id;
    },
    clearInterval: (id) => void registered.delete(id),
  };
  const advance = () => registered.forEach((t) => t.handler());

  let ticks = 0;
  const stop = startPolling(() => ticks++, { timers });

  assert.equal([...registered.values()][0].ms, POLL_INTERVAL_MS);
  advance();
  advance();
  assert.equal(ticks, 2);

  stop();
  advance();
  assert.equal(ticks, 2, "cleanup must actually clear the interval");
});

test("startPolling honours an explicit interval", () => {
  let captured = -1;
  const timers: PollTimers = {
    setInterval: (_handler, ms) => {
      captured = ms;
      return 1;
    },
    clearInterval: () => {},
  };
  startPolling(() => {}, { intervalMs: 5000, timers });
  assert.equal(captured, 5000);
});

test("POLL_INTERVAL_MS is the 30s the hooks documented", () => {
  assert.equal(POLL_INTERVAL_MS, 30000);
});

// ---------------------------------------------------------------- deepEqual

test("deepEqual over the shapes these hooks actually produce", () => {
  assert.ok(deepEqual([], []));
  assert.ok(deepEqual(A, A.map((t) => ({ ...t }))));
  assert.ok(!deepEqual(A, B));
  assert.ok(!deepEqual([{ a: 1 }], [{ a: 2 }]));
  assert.ok(!deepEqual([{ a: 1 }], [{ a: 1, b: 2 }]));
  // ⚠️ `{ a: undefined }` is a DIFFERENT shape from `{}` — a display name that resolved to undefined
  // is not the same as one that was never looked up.
  assert.ok(!deepEqual({ a: undefined }, {}));
  assert.ok(deepEqual({ a: undefined }, { a: undefined }));
  // replyCounts is a Record<string, number>.
  assert.ok(deepEqual({ x: 1, y: 2 }, { y: 2, x: 1 }), "key order is not data");
  assert.ok(!deepEqual({ x: 1 }, { x: 1, y: 0 }));
  // A bigint survives a round trip through the head decode in some paths.
  assert.ok(deepEqual({ n: 1n }, { n: 1n }));
  assert.ok(!deepEqual({ n: 1n }, { n: 2n }));
  assert.ok(!deepEqual(null, {}));
  assert.ok(!deepEqual([1], { 0: 1 }));
  assert.ok(deepEqual(NaN, NaN), "a NaN that did not change has not changed");
  assert.ok(deepEqual([{ a: [1, { b: null }] }], [{ a: [1, { b: null }] }]));
  assert.ok(!deepEqual([{ a: [1, { b: null }] }], [{ a: [1, { b: 0 }] }]));
});
