import { McpServer } from "@modelcontextprotocol/server";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

export interface ToolCallResult {
  isError: boolean;
  text: string;
  /** Parsed JSON body when the tool returned JSON, otherwise undefined. */
  json: any;
  /** Raw content blocks (text, image, …) exactly as the server returned them. */
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
}

/** A type alias (not an interface) so it stays assignable to the SDK result type with its index signature. */
export type ElicitationReply = {
  action: "accept" | "decline" | "cancel";
  content?: Record<string, string | number | boolean | string[]>;
};

export interface HarnessOptions {
  /** When set, the client declares form elicitation and answers every elicitation request with this function. */
  elicitation?: (message: string) => ElicitationReply | Promise<ElicitationReply>;
}

export interface Harness {
  call(name: string, args?: Record<string, unknown>): Promise<ToolCallResult>;
  listTools(): Promise<string[]>;
  annotations(name: string): Promise<Record<string, unknown> | undefined>;
  toolMeta(name: string): Promise<Record<string, unknown> | undefined>;
  description(name: string): Promise<string | undefined>;
  /** Messages of every elicitation the server asked for, in order. */
  readonly elicitations: string[];
  close(): Promise<void>;
}

/** Spin up an McpServer with the given registrations and talk to it over an in-memory transport. */
export async function connectHarness(register: (server: McpServer) => void, options: HarnessOptions = {}): Promise<Harness> {
  const server = new McpServer({ name: "test-server", version: "0.0.0" });
  register(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "test-client", version: "0.0.0" },
    options.elicitation ? { capabilities: { elicitation: { form: {} } } } : {},
  );
  const elicitations: string[] = [];
  if (options.elicitation) {
    const answer = options.elicitation;
    client.setRequestHandler("elicitation/create", async (request) => {
      const message = (request.params as { message: string }).message;
      elicitations.push(message);
      return answer(message);
    });
  }
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const tool = async (name: string) => (await client.listTools()).tools.find((t) => t.name === name);

  return {
    elicitations,
    async call(name, args = {}) {
      try {
        const res = await client.callTool({ name, arguments: args });
        const content = res.content as ToolCallResult["content"];
        const text = content[0]?.text ?? "";
        let json: any;
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
        return { isError: res.isError === true, text, json, content };
      } catch (err) {
        return { isError: true, text: err instanceof Error ? err.message : String(err), json: undefined, content: [] };
      }
    },
    async listTools() {
      const res = await client.listTools();
      return res.tools.map((t) => t.name).sort();
    },
    async annotations(name) {
      const res = await client.listTools();
      return res.tools.find((t) => t.name === name)?.annotations as Record<string, unknown> | undefined;
    },
    async toolMeta(name) {
      return (await tool(name))?._meta as Record<string, unknown> | undefined;
    },
    async description(name) {
      return (await tool(name))?.description;
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}
