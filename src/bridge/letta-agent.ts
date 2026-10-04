import type {
  LettaAgentClient,
  CreateSessionOptions,
  SDKResultMessage,
  SDKMessage,
} from "@letta-ai/letta-agent-sdk";

export interface LettaTurnRequest {
  /** Host task correlation; never an execution ownership key. */
  taskId?: string;
  /** Dedicated owner-scoped conversation key, not the raw wire context ID. */
  a2aContextId: string;
  messageId: string;
  text: string;
  signal: AbortSignal;
  /** Accepts only safe public activity labels, never reasoning or raw tool/error content. */
  onActivity?(activity: string): void;
}
/** Interruption is a trusted, settled runner outcome, never assistant-prose parsing.
 * Returning it guarantees this turn no longer owns active or uncertain execution.
 * detail is explicitly public text and must not contain credentials/private errors.
 */
export interface LettaTurnResult {
  text: string;
  state?: "completed" | "input_required" | "auth_required";
  detail?: string;
}
export interface LettaTurnRunner {
  runTurn(request: LettaTurnRequest): Promise<LettaTurnResult>;
  /** A settled call is not always proof that remote execution has ended. */
  readonly unresolvedContexts?: readonly string[];
}
export class LettaTurnCancelledError extends Error {
  constructor() {
    super("The Letta turn was cancelled");
    this.name = "LettaTurnCancelledError";
  }
}
export interface SessionExecutionLifecycle {
  /** Durable guard under the context lock, before opening a session. */
  beforeTurn?(request: LettaTurnRequest): void | Promise<void>;
  /** Persist submission intent before any input can be sent. */
  beforeSend?(
    request: LettaTurnRequest,
    correlation: { agentId: string; conversationId: string; otid: string },
  ): void | Promise<void>;
  /** Transport-return observation only; not durable acceptance. */
  sent?(request: LettaTurnRequest): void | Promise<void>;
  observe?(
    request: LettaTurnRequest,
    message: SDKMessage,
  ): void | Promise<void>;
  /** Normal success and all owned cleanup settled; not terminal task persistence. */
  stopped?(request: LettaTurnRequest, eligibleAnswer?: string, canceled?: boolean): void | Promise<void>;
  /** Called after local quarantine is installed; failure leaves it installed. */
  unresolved?(request: LettaTurnRequest): void | Promise<void>;
}
export interface SessionPolicy {
  /** Optional awaited execution journal hooks, all under the context lock. */
  execution?: SessionExecutionLifecycle;
  /** Optional idle-conversation continuity, called under the execution lock.
   * Keys are already owner-scoped by the host. Never fall back to unowned keys.
   * This is not active-task persistence or crash/restart reconciliation.
   * Errors fail closed; set must settle before any input is sent.
   */
  conversationMapping?: {
    get(contextId: string): string | undefined | Promise<string | undefined>;
    set(contextId: string, conversationId: string): void | Promise<void>;
  };
  /** Explicit shared trust domain; this runtime is not a multi-tenant mapper. */
  sharingDomain: string;
  /** Normal runtime options; the application supplies its noninteractive approval policy. */
  sessionOptions: CreateSessionOptions;
}

/** One execution owner, one existing agent, dedicated in-memory context mapping. */
export class AgentSdkTurnRunner implements LettaTurnRunner {
  private readonly conversations = new Map<string, string>();
  private readonly contextTails = new Map<string, Promise<void>>();
  private readonly unresolved = new Set<string>();

  constructor(
    private readonly client: Pick<
      LettaAgentClient,
      "createSession" | "resumeSession"
    >,
    private readonly agentId: string,
    private readonly policy: SessionPolicy,
  ) {
    if (!agentId || !policy.sharingDomain.trim())
      throw new Error(
        "An existing agent and explicit sharing domain are required",
      );
  }

  get unresolvedContexts(): readonly string[] {
    return [...this.unresolved];
  }

  runTurn(request: LettaTurnRequest): Promise<LettaTurnResult> {
    return this.withContextLock(request.a2aContextId, request.signal, () =>
      this.runTurnUnlocked(request),
    );
  }

  private async runTurnUnlocked(
    request: LettaTurnRequest,
  ): Promise<LettaTurnResult> {
    throwIfCancelled(request.signal);
    if (this.unresolved.has(request.a2aContextId))
      throw new Error("Context execution requires reconciliation");
    await this.policy.execution?.beforeTurn?.(request);
    throwIfCancelled(request.signal);
    const known =
      this.conversations.get(request.a2aContextId) ??
      (await this.policy.conversationMapping?.get(request.a2aContextId));
    throwIfCancelled(request.signal);
    const options = { ...this.policy.sessionOptions };
    let sent = false;
    let result: SDKResultMessage | undefined;
    let assistantText = "";
    let assistantKey: string | undefined;
    let sawAssistant = false;
    let selectedAnswer = "";
    let lastActivity: string | undefined;
    const activity = (label: string) => {
      if (request.signal.aborted || label === lastActivity) return;
      lastActivity = label;
      request.onActivity?.(label);
    };
    try {
      {
        await using session = known
          ? this.client.resumeSession(known, options)
          : this.client.createSession(this.agentId, options);
        const abortSession = () => {
          void session.abort().catch(() => undefined);
        };
        request.signal.addEventListener("abort", abortSession, { once: true });
        try {
          const ready = await session.ready();
          throwIfCancelled(request.signal);
          await this.policy.conversationMapping?.set(
            request.a2aContextId,
            ready.conversationId,
          );
          throwIfCancelled(request.signal);
          this.conversations.set(request.a2aContextId, ready.conversationId);
          await this.policy.execution?.beforeSend?.(request, {
            agentId: this.agentId,
            conversationId: ready.conversationId,
            otid: request.messageId,
          });
          throwIfCancelled(request.signal);
          // An ambiguous send must not be retried or followed by another turn.
          sent = true;
          await session.send(request.text, { otid: request.messageId });
          await this.policy.execution?.sent?.(request);
          for await (const message of session.stream()) {
            await this.policy.execution?.observe?.(request, message);
            // Only typed top-level SDK messages are activity evidence. Raw
            // stream_event envelopes (including internal/nested streams) stay private.
            if (message.type === "assistant") {
              // The SDK generates app-server-N/cloud-N per delta without a
              // wire ID. Those are not message boundaries; prefer lineage or
              // keep accumulating, as the SDK's finalAssistantText does.
              const key = /^(app-server|cloud)-[0-9]+$/.test(message.uuid)
                ? (message.otid ?? assistantKey)
                : message.uuid;
              if (assistantKey !== key) assistantText = "";
              assistantKey = key;
              sawAssistant = true;
              assistantText += message.content;
              activity("Generating response");
            } else if (message.type === "reasoning") {
              activity("Thinking");
            } else if (message.type === "tool_call" || message.type === "tool_result") {
              // Like SDK finalAssistantText, discard pre-tool commentary.
              assistantText = "";
              assistantKey = undefined;
              if (message.type === "tool_call") {
                const name = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(message.toolName)
                  ? message.toolName
                  : undefined;
                activity(name ? `Tool requested: ${name}` : "Tool requested");
              } else {
                activity("Tool finished");
              }
            } else if (message.type === "retry") {
              activity("Retrying request");
            } else if (message.type === "result") result = message;
          }
        } finally {
          request.signal.removeEventListener("abort", abortSession);
        }
      }
      // Interpret results only after all owned cleanup has settled. The SDK
      // synthesizes failures on disconnect. The SDK may emit interrupted
      // status before backend cancellation settles, so it is not cancellation proof.
      if (!result)
        throw new Error("The Letta Agent SDK stream ended without a result");
      if (
        !result.success ||
        result.stopReason === "interrupted" ||
        result.stopReason === "requires_approval"
      )
        throw new Error("The Letta turn requires reconciliation");
      // This is the single answer-selection boundary for live publication and
      // durable recovery: final assistant text, or result-only transport fallback.
      selectedAnswer = sawAssistant ? assistantText : (result.result ?? "");
      const canceledDuringCleanup = request.signal.aborted;
      await this.policy.execution?.stopped?.(
        request,
        canceledDuringCleanup ? undefined : selectedAnswer,
        canceledDuringCleanup,
      );
      // Cancellation can arrive while durable stop confirmation is being
      // written. Replace any just-committed answer with the canceled outcome.
      if (!canceledDuringCleanup && request.signal.aborted)
        await this.policy.execution?.stopped?.(request, undefined, true);
    } catch (error) {
      // Includes ambiguous sends, stream/observation errors, and cleanup failures.
      if (sent) {
        this.unresolved.add(request.a2aContextId);
        await this.policy.execution?.unresolved?.(request);
      }
      throw error;
    }
    if (request.signal.aborted) throw new LettaTurnCancelledError();
    return { text: selectedAnswer };
  }

  private async withContextLock<T>(
    contextId: string,
    signal: AbortSignal,
    work: () => Promise<T>,
  ): Promise<T> {
    const previous = this.contextTails.get(contextId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.contextTails.set(contextId, tail);
    try {
      await waitForPreviousTurn(previous, signal);
      return await work();
    } finally {
      release();
      // Preserve the predecessor's barrier when a waiting turn is cancelled.
      void tail.then(() => {
        if (this.contextTails.get(contextId) === tail)
          this.contextTails.delete(contextId);
      });
    }
  }
}
function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new LettaTurnCancelledError();
}
function waitForPreviousTurn(
  previous: Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.reject(new LettaTurnCancelledError());
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(new LettaTurnCancelledError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    previous.then(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
