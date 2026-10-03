import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Task, TaskState } from "@a2a-js/sdk";
import {
  A2AInvocationError,
  A2AInvocationCancelledError,
  type A2AInvocation,
  type A2AInvoker,
} from "../src/client/a2a-invoker.js";
import { FileContextStore, MemoryContextStore, type ContextStore } from "../src/client/context-store.js";
import { A2AToolService } from "../src/client/tool-service.js";

const url = "http://peer.test/";
const scope = "local-scope";
const bindFor = (localScope: string) => JSON.stringify(["a2a-binding", localScope, url]);
const bind = bindFor(scope);
const exec = (context: string) => JSON.stringify(["a2a-execution", url, context]);
const result = Task.fromJSON({ id: "task-new", contextId: "context-new", status: { state: TaskState.TASK_STATE_COMPLETED } });
const prior = Task.fromJSON({ id: "task-prior", contextId: "context-existing", status: { state: TaskState.TASK_STATE_COMPLETED } });

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function invoker(invoke: A2AInvoker["invoke"], calls: { value: number }) {
  return {
    async invoke(input: A2AInvocation) { calls.value++; return invoke(input); },
    async getTask() { return prior; },
    async cancelTask() { return prior; },
    async connect() { throw new Error("unused"); },
    stream() { throw new Error("unused"); },
    subscribe() { throw new Error("unused"); },
  } as unknown as A2AInvoker;
}

class DelayedStore implements ContextStore {
  readonly base: FileContextStore;
  constructor(readonly path: string, readonly hold: (key: string, value: string) => Promise<void>) { this.base = new FileContextStore(path); }
  get(key: string) { return this.base.get(key); }
  async set(key: string, value: string) { await this.hold(key, value); await this.base.set(key, value); }
  withLock<T>(key: string, signal: AbortSignal, work: () => Promise<T>) { return this.base.withLock(key, signal, work); }
}

function request(signal: AbortSignal, extras: Record<string, unknown> = {}) {
  return { target: "peer", message: "hello", localScope: scope, signal, ...extras } as const;
}

async function withTempRoot<T>(prefix: string, work: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  try { return await work(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test("cancellation during first binding journal save restores durable state and queues later work", async () => withTempRoot("a2a-outbound-cancel-", async (root) => {
  const entered = deferred<string>();
  const release = deferred();
  const saveFinished = deferred();
  const store = new DelayedStore(join(root, "contexts.json"), async (key, value) => {
    if (key === bind && JSON.parse(value).submissionUnknown) {
      entered.resolve(value);
      await release.promise;
      saveFinished.resolve();
    }
  });
  const calls = { value: 0 };
  const service = new A2AToolService({ peer: url }, invoker(async () => result, calls), store);
  const caller = new AbortController();
  let secondResult: "resolved" | "rejected" | undefined;
  let secondError: unknown;
  try {
    const first = service.invoke(request(caller.signal));
    const journal = await entered.promise;
    caller.abort(new Error("caller canceled"));
    await expect(first).rejects.toBeInstanceOf(A2AInvocationCancelledError);
    const second = service.invoke(request(new AbortController().signal)).then(
      () => { secondResult = "resolved"; },
      (error) => { secondResult = "rejected"; secondError = error; },
    );
    expect(secondResult).toBeUndefined();
    release.resolve();
    await saveFinished.promise;
    await service.drain(caller.signal);
    await second;
    expect(journal).toContain('"submissionUnknown":true');
    expect(calls.value).toBe(1);
    expect(secondResult).toBe("resolved");
    expect(secondError).toBeUndefined();
    expect((await store.base.get(bind))!).not.toContain('"submissionUnknown":true');
    // The queued call ran only after restoration and was admitted.
    expect(calls.value).toBe(1);
    const reopened = new A2AToolService({ peer: url }, invoker(async () => result, calls), new FileContextStore(join(root, "contexts.json")));
    try {
      await expect(reopened.invoke(request(new AbortController().signal))).resolves.toEqual(result);
      expect(calls.value).toBe(2);
    } finally { reopened.close(); }
  } finally {
    release.resolve();
    await service.drain(caller.signal);
    service.close();
  }
}));

test.each(["cancel", "deadline"] as const)("existing-context second journal save restores both prior records after %s", async (mode) => withTempRoot("a2a-outbound-existing-", async (root) => {
  const path = join(root, "contexts.json");
  const base = new FileContextStore(path);
  const priorBinding = JSON.stringify({ contextId: "context-existing", taskId: "task-prior", state: TaskState.TASK_STATE_COMPLETED, pending: false });
  const priorExecution = priorBinding;
  await base.set(bind, priorBinding);
  await base.set(exec("context-existing"), priorExecution);
  const entered = deferred();
  const release = deferred();
  let gated = false;
  const store = new DelayedStore(path, async (key, value) => {
    if (key === exec("context-existing") && JSON.parse(value).submissionUnknown && !gated) {
      gated = true;
      entered.resolve();
      await release.promise;
    }
  });
  const calls = { value: 0 };
  const service = new A2AToolService({ peer: url }, invoker(async (input) => {
    if (mode === "deadline") await new Promise<void>((resolve) => input.signal.addEventListener("abort", () => resolve(), { once: true }));
    return Task.fromJSON({ id: "task-next", contextId: "context-existing", status: { state: TaskState.TASK_STATE_COMPLETED } });
  }, calls), store, { timeoutMs: mode === "deadline" ? 100 : 5_000 });
  const caller = new AbortController();
  try {
    const pending = service.invoke(request(caller.signal, { contextId: "context-existing" }));
    await entered.promise;
    if (mode === "cancel") caller.abort(new Error("caller canceled"));
    await expect(pending).rejects.toBeInstanceOf(mode === "cancel" ? A2AInvocationCancelledError : A2AInvocationError);
    release.resolve();
    await service.drain(caller.signal);
    expect(calls.value).toBe(0);
    const reopened = new FileContextStore(path);
    expect(await reopened.get(bind)).toBe(priorBinding);
    expect(await reopened.get(exec("context-existing"))).toBe(priorExecution);
    const next = new A2AToolService({ peer: url }, invoker(async () => Task.fromJSON({ id: "task-next", contextId: "context-existing", status: { state: TaskState.TASK_STATE_COMPLETED } }), calls), reopened);
    try {
      await expect(next.invoke(request(new AbortController().signal, { contextId: "context-existing" }))).resolves.toBeDefined();
      expect(calls.value).toBe(1);
    } finally { next.close(); }
  } finally {
    release.resolve();
    await service.drain(caller.signal);
    service.close();
  }
}));

test("typed pre-submit failures restore prior state", async () => {
  const store = new MemoryContextStore();
  const calls = { value: 0 };
  const service = new A2AToolService({ peer: url }, invoker(async () => {
    throw new A2AInvocationError("local pre-submit failure", { submissionAttempted: false });
  }, calls), store);
  try {
    await expect(service.invoke(request(new AbortController().signal, { localScope: "typed-scope" }))).rejects.toBeInstanceOf(A2AInvocationError);
    expect(await store.get(bindFor("typed-scope"))).toBe("{}");
    expect(calls.value).toBe(1);
  } finally { service.close(); }
});

test("rollback retains the binding lock until restoration is persisted", async () => {
  const base = new MemoryContextStore();
  const journalStarted = deferred();
  const releaseJournal = deferred();
  const rollbackStarted = deferred();
  const releaseRollback = deferred();
  const secondQueued = deferred();
  const events: string[] = [];
  let bindingLocks = 0;
  let journalHeld = false;
  let rollbackHeld = false;
  const store: ContextStore = {
    get: (key) => base.get(key),
    withLock(key, signal, work) {
      const second = key === bind && ++bindingLocks === 2;
      if (second) secondQueued.resolve();
      return base.withLock(key, signal, async () => {
        if (second) events.push("second entered");
        return work();
      });
    },
    async set(key, value) {
      if (key === bind && !journalHeld && JSON.parse(value).submissionUnknown) {
        journalHeld = true;
        journalStarted.resolve();
        await releaseJournal.promise;
      }
      if (key === bind && journalHeld && !rollbackHeld && value === "{}") {
        rollbackHeld = true;
        events.push("rollback started");
        rollbackStarted.resolve();
        await releaseRollback.promise;
        await base.set(key, value);
        events.push("restored");
        return;
      }
      await base.set(key, value);
    },
  };
  const calls = { value: 0 };
  const service = new A2AToolService({ peer: url }, invoker(async () => result, calls), store);
  const caller = new AbortController();
  try {
    const first = service.invoke(request(caller.signal));
    await journalStarted.promise;
    caller.abort();
    await expect(first).rejects.toBeInstanceOf(A2AInvocationCancelledError);
    releaseJournal.resolve();
    await rollbackStarted.promise;
    const second = service.invoke(request(new AbortController().signal));
    void second.catch(() => undefined);
    await secondQueued.promise;
    // Let queued microtasks run while rollback is deliberately blocked.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(events).toEqual(["rollback started"]);
    expect(calls.value).toBe(0);
    releaseRollback.resolve();
    await expect(second).resolves.toEqual(result);
    expect(events).toEqual(["rollback started", "restored", "second entered"]);
    expect(calls.value).toBe(1);
  } finally {
    releaseJournal.resolve();
    releaseRollback.resolve();
    await service.drain(caller.signal);
    service.close();
  }
});

test.each(["binding", "execution"] as const)("a rejected %s journal write restores a provably unsent operation", async (failedRecord) => withTempRoot("a2a-outbound-write-fail-", async (root) => {
  const base = new FileContextStore(join(root, "contexts.json"));
  const previous = JSON.stringify({ contextId: "context-existing", taskId: "task-prior", state: TaskState.TASK_STATE_COMPLETED, pending: false });
  await base.set(bind, previous);
  await base.set(exec("context-existing"), previous);
  let rejected = false;
  const failKey = failedRecord === "binding" ? bind : exec("context-existing");
  const store: ContextStore = {
    get: (key) => base.get(key),
    withLock: (key, signal, work) => base.withLock(key, signal, work),
    async set(key, value) {
      await base.set(key, value);
      // A store can reject after its write commits, such as during lock release.
      if (!rejected && key === failKey && JSON.parse(value).submissionUnknown) {
        rejected = true;
        throw new Error("journal save failed after commit");
      }
    },
  };
  const calls = { value: 0 };
  const service = new A2AToolService({ peer: url }, invoker(async () => prior, calls), store);
  try {
    await expect(service.invoke(request(new AbortController().signal))).rejects.toThrow("journal save failed");
    expect(calls.value).toBe(0);
    expect(await base.get(bind)).toBe(previous);
    expect(await base.get(exec("context-existing"))).toBe(previous);
    await expect(service.invoke(request(new AbortController().signal))).resolves.toEqual(prior);
    expect(calls.value).toBe(1);
  } finally { service.close(); }
}));

test.each(["generic", "typed"] as const)("entered custom invoker %s failure remains quarantined through new_context", async (kind) => {
  const store = new MemoryContextStore();
  const calls = { value: 0 };
  const service = new A2AToolService({ peer: url }, invoker(async () => {
    if (kind === "typed") throw new A2AInvocationError("possible send", { submissionAttempted: true });
    throw new Error("transport failed after possible send");
  }, calls), store);
  try {
    await expect(service.invoke(request(new AbortController().signal, { localScope: "ambiguous-scope" }))).rejects.toBeInstanceOf(A2AInvocationError);
    expect(JSON.parse((await store.get(bindFor("ambiguous-scope")))!).submissionUnknown).toBe(true);
    await expect(service.invoke(request(new AbortController().signal, { newContext: true, localScope: "ambiguous-scope" }))).rejects.toThrow("Unknown A2A submission");
    expect(calls.value).toBe(1);
  } finally { service.close(); }
});

test("restoration failure stays conservative and service drain waits for journal persistence", async () => withTempRoot("a2a-outbound-restore-fail-", async (root) => {
  const entered = deferred();
  const release = deferred();
  const base = new FileContextStore(join(root, "contexts.json"));
  const store: ContextStore = {
    get: (key) => base.get(key),
    async set(key, value) {
      if (key === bind && JSON.parse(value).submissionUnknown) { entered.resolve(); await release.promise; await base.set(key, value); }
      else if (key === bind) throw new Error("restore failed");
      else await base.set(key, value);
    },
    withLock: (key, signal, work) => base.withLock(key, signal, work),
  };
  const calls = { value: 0 };
  const service = new A2AToolService({ peer: url }, invoker(async () => result, calls), store);
  const caller = new AbortController();
  try {
    const pending = service.invoke(request(caller.signal));
    await entered.promise;
    caller.abort(new Error("cancel"));
    await expect(pending).rejects.toBeInstanceOf(A2AInvocationCancelledError);
    let drained = false;
    const closing = service.drain(caller.signal).then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    release.resolve();
    await closing;
    expect(drained).toBe(true);
    expect(calls.value).toBe(0);
    expect(JSON.parse((await base.get(bind))!).submissionUnknown).toBe(true);
  } finally {
    release.resolve();
    await service.drain(caller.signal);
    service.close();
  }
}));
