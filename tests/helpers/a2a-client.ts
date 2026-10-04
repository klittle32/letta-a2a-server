import { ClientFactory, DefaultAgentCardResolver, JsonRpcTransportFactory, type Client } from "@a2a-js/sdk/client";
import { SendMessageRequest } from "@a2a-js/sdk";

/** Small test-only wrapper around the pinned official SDK client. */
export async function testClient(url: string, token?: string): Promise<Client> {
  const fetchImpl: typeof fetch = token
    ? ((input, init) => fetch(input, {
      ...init,
      headers: { ...Object.fromEntries(new Headers(init?.headers)), authorization: `Bearer ${token}` },
    })) as typeof fetch
    : fetch;
  return new ClientFactory({
    cardResolver: new DefaultAgentCardResolver({ fetchImpl }),
    transports: [new JsonRpcTransportFactory({ fetchImpl })],
  }).createFromUrl(url.endsWith("/") ? url : `${url}/`);
}

export function sendRequest(text: string, contextId?: string, returnImmediately = false) {
  return SendMessageRequest.fromJSON({ configuration: { returnImmediately }, message: {
    messageId: crypto.randomUUID(), role: "user", parts: [{ text }],
    ...(contextId ? { contextId } : {}),
  } });
}
