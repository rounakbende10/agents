import { routeAgentRequest, Agent, callable, type Connection } from "agents";
import {
  streamText,
  type UIMessage,
  convertToModelMessages,
  readUIMessageStream,
  generateId,
  stepCountIs,
  type ToolSet
} from "ai";
import { createOpenAI } from "@ai-sdk/openai";

type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

type RequestMetrics = {
  usage?: TokenUsage;
  durationMs?: number;
  timestamp?: string;
};

type State = {
  messages: UIMessage[];
  loading: boolean;
  metrics?: RequestMetrics;
};

export class Simplechat extends Agent<Env, State> {
  tools: ToolSet = {};
  lastMessageRepliedTo: string | undefined;

  initialState: State = {
    messages: [],
    loading: false,
    metrics: undefined
  };

  async onStart() {
    this.lastMessageRepliedTo =
      this.state.messages[this.state.messages.length - 1]?.id;
  }

  @callable({
    description: "Add an MCP server to the agent"
  })
  addMcp({ name, url }: { name: string; url: string }) {
    void this.addMcpServer(name, url, "http://localhost:5175")
      .then(() => {
        console.log("mcpServer added", name, url);
      })
      .catch((error) => {
        console.error("mcpServer addition failed", error);
      });
  }

  @callable({
    description: "Remove an MCP server from the agent"
  })
  removeMcp(id: string) {
    void this.removeMcpServer(id);
  }

  async onStateUpdate(state: State, source: Connection | "server") {
    if (source === "server") {
      return;
    }
    if (
      state.messages.length > 0 &&
      this.lastMessageRepliedTo !==
        state.messages[state.messages.length - 1]?.id
    ) {
      await this.onChatMessage();
      this.lastMessageRepliedTo = state.messages[state.messages.length - 1]?.id;
    }
  }

  async onChatMessage() {
    const startTime = Date.now();
    this.setState({
      messages: this.state.messages,
      loading: true,
      metrics: undefined
    });

    // Collect all tools from MCP servers
    const allTools = {
      ...this.mcp.getAITools()
    };
    this.tools = allTools;

    // Create OpenAI client with API key from env
    const openai = createOpenAI({
      apiKey: this.env.OPENAI_API_KEY
    });
    const model = openai("gpt-5-mini");

    // LLM call with MCP tools
    const result = streamText({
      system:
        "You are a helpful assistant. Answer questions directly and concisely. Use the available tools when appropriate to help answer questions.",
      messages: await convertToModelMessages(this.state.messages),
      model,
      tools: allTools,
      onError: (error) => {
        console.error("error", error);
      },
      stopWhen: stepCountIs(10)
    });

    for await (const uiMessage of readUIMessageStream<UIMessage>({
      stream: result.toUIMessageStream({
        generateMessageId: generateId
      }),
      onError: (error) => {
        console.error("error", error);
      }
    })) {
      this.setState({
        messages: updateMessages(this.state.messages, uiMessage),
        loading: this.state.loading
      });
    }

    // Capture metrics after completion
    const durationMs = Date.now() - startTime;
    const usage = await result.usage;

    const metrics: RequestMetrics = {
      usage: usage
        ? {
            inputTokens: usage.inputTokens ?? usage.promptTokens ?? 0,
            outputTokens: usage.outputTokens ?? usage.completionTokens ?? 0,
            totalTokens: usage.totalTokens ?? 0
          }
        : undefined,
      durationMs,
      timestamp: new Date().toISOString()
    };

    this.setState({
      messages: this.state.messages,
      loading: false,
      metrics
    });
  }
}

function updateMessages(messages: UIMessage[], newMessage: UIMessage) {
  const finalMessages = [];
  let updated = false;
  for (const message of messages) {
    if (message.id === newMessage.id) {
      finalMessages.push(newMessage);
      updated = true;
    } else {
      finalMessages.push(message);
    }
  }
  if (!updated) {
    finalMessages.push(newMessage);
  }

  return finalMessages;
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
