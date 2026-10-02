import type { AnyAgentTool } from "@letta-ai/letta-agent-sdk";
import {
  getA2AToolDefinitions,
  readA2AArguments,
  resolveA2AScope,
  runA2ATool,
  type A2AScopeGetter,
  type A2AToolClient,
  type A2AToolResult,
} from "./tool-operations.js";

export interface CreateA2AToolsOptions {
  client: A2AToolClient;
  getScope: A2AScopeGetter;
  /** Required: SDK 0.8.3 does not forward a per-call signal to execute. */
  signal: AbortSignal;
  closeTimeoutMs?: number;
}
export interface A2AToolGroup {
  tools: AnyAgentTool[];
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

/**
 * A session-owned tool group. Closing it never closes the shared client.
 * SDK 0.8.3 serializes only tool name/label/description/parameters, not the
 * shared approval/parallel flags. Approval remains the session host's policy;
 * this adapter neither installs an allow callback nor changes permission mode.
 */
export function createA2ATools(options: CreateA2AToolsOptions): A2AToolGroup {
  if (!options.signal || typeof options.signal.addEventListener !== "function")
    throw new Error("An owner lifecycle AbortSignal is required");
  const closeTimeoutMs = options.closeTimeoutMs ?? 5000;
  if (!Number.isFinite(closeTimeoutMs) || closeTimeoutMs <= 0)
    throw new Error("closeTimeoutMs must be positive and finite");
  const owner = new AbortController();
  const abort = () => owner.abort();
  if (options.signal.aborted) abort();
  else options.signal.addEventListener("abort", abort, { once: true });
  const active = new Set<Promise<A2AToolResult>>();
  // Cloud delivery can repeat the same SDK tool call. Keep its original outcome
  // (including uncertainty) for this session, never submit it again.
  const calls = new Map<string, { binding: string; pending: Promise<A2AToolResult> }>();
  // Caller-facing timeout/cancellation results can precede persistence and lock
  // release. Keep the exact original signals for service-owned work tracking.
  const usedSignals = new Set<AbortSignal>();
  let closing: Promise<void> | undefined;

  function close(): Promise<void> {
    if (closing) return closing;
    owner.abort();
    options.signal.removeEventListener("abort", abort);
    closing = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              `A2A tool cleanup incomplete: caller or underlying work did not settle after ${closeTimeoutMs}ms`,
            ),
          ),
        closeTimeoutMs,
      );
      Promise.allSettled([...active])
        .then(() =>
          Promise.all(
            [...usedSignals].map((signal) => options.client.drain(signal)),
          ),
        )
        .then(
          () => {
            clearTimeout(timer);
            usedSignals.clear();
            calls.clear();
            resolve();
          },
          () => {
            clearTimeout(timer);
            reject(
              new Error(
                "A2A tool cleanup incomplete: local operation drain failed",
              ),
            );
          },
        );
    });
    return closing;
  }

  const tools: AnyAgentTool[] = getA2AToolDefinitions(options.client).map(
    (definition) => ({
      ...definition,
      label: definition.name,
      async execute(toolCallId: string, args: unknown, signal?: AbortSignal) {
        const refuse = (error: string) => ({
          content: [{ type: "text" as const, text: JSON.stringify({ status: "error", error }) }],
          isError: true,
        });
        if (owner.signal.aborted || signal?.aborted)
          return refuse("A2A tool owner or caller is closed or canceled; no new submission attempted");
        let binding: string;
        try {
          if (typeof toolCallId !== "string" || !toolCallId.trim()) throw new Error("Missing call ID");
          binding = JSON.stringify([
            definition.name,
            resolveA2AScope(options.getScope),
            readA2AArguments(definition.name, args),
          ]);
        } catch {
          return refuse("Invalid SDK tool-call ID, arguments, or ready scope");
        }
        const previous = calls.get(toolCallId);
        if (previous && previous.binding !== binding)
          return refuse("SDK tool-call ID was reused with different arguments, tool, or scope");
        const combined = signal
          ? AbortSignal.any([owner.signal, signal])
          : owner.signal;
        let pending = previous?.pending;
        if (!pending) {
          const deferred = Promise.withResolvers<A2AToolResult>();
          pending = deferred.promise;
          // Bind before dispatch, including synchronous/reentrant callbacks.
          calls.set(toolCallId, { binding, pending });
          usedSignals.add(combined);
          active.add(pending);
          void runA2ATool(definition.name, args, {
            client: options.client,
            getScope: options.getScope,
            signal: combined,
          }).then(deferred.resolve, deferred.reject);
        }
        try {
          const result = await pending;
          return {
            content: [{ type: "text" as const, text: result.content }],
            isError: result.isError,
          };
        } finally {
          active.delete(pending);
        }
      },
    }),
  );
  return { tools, close, [Symbol.asyncDispose]: close };
}
