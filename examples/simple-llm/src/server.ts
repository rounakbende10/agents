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
  // Current request metrics
  usage?: TokenUsage;
  durationMs?: number;
  timestamp?: string;
  // Cumulative session metrics
  requestCount?: number;
  cumulativeUsage?: TokenUsage;
  cumulativeDurationMs?: number;
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

    // Capture metrics at start (before any async operations)
    const savedMetrics = this.state.metrics;
    console.log(
      "\n[DEBUG] onChatMessage start - savedMetrics:",
      JSON.stringify(savedMetrics)
    );

    // Preserve existing metrics for cumulative tracking
    this.setState({
      messages: this.state.messages,
      loading: true,
      metrics: savedMetrics
    });

    // Collect all tools from MCP servers
    const mcpTools = this.mcp.getAITools();

    // Sanitize tool arguments - remove problematic defaults that LLMs tend to add
    const sanitizeArgs = (args: unknown): unknown => {
      if (typeof args !== "object" || args === null) return args;
      const sanitized: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(
        args as Record<string, unknown>
      )) {
        // Skip numeric 0 for optional fields (e.g., milestone: 0)
        if (value === 0 && ["milestone"].includes(key)) continue;
        // Skip empty arrays for optional fields
        if (
          Array.isArray(value) &&
          value.length === 0 &&
          ["assignees", "labels"].includes(key)
        )
          continue;
        sanitized[key] = value;
      }
      return sanitized;
    };

    // Wrap tools with tracing and sanitization
    const tracedTools: ToolSet = {};
    for (const [toolName, tool] of Object.entries(mcpTools)) {
      tracedTools[toolName] = {
        ...tool,
        execute: async (args: unknown, context: unknown) => {
          // Sanitize args before execution
          const sanitizedArgs = sanitizeArgs(args);

          console.log(
            "\n┌─────────────────────────────────────────────────────────"
          );
          console.log("│ [TOOL CALL]", toolName);
          console.log(
            "├─────────────────────────────────────────────────────────"
          );
          console.log("│ Input (raw):", JSON.stringify(args, null, 2));
          console.log(
            "│ Input (sanitized):",
            JSON.stringify(sanitizedArgs, null, 2)
          );
          console.log(
            "└─────────────────────────────────────────────────────────"
          );

          const result = await tool.execute!(sanitizedArgs, context);

          console.log(
            "\n┌─────────────────────────────────────────────────────────"
          );
          console.log("│ [TOOL RESULT]", toolName);
          console.log(
            "├─────────────────────────────────────────────────────────"
          );
          console.log("│ Output:", JSON.stringify(result, null, 2));
          console.log(
            "└─────────────────────────────────────────────────────────"
          );

          return result;
        }
      };
    }
    this.tools = tracedTools;

    // Create OpenAI client with API key from env
    const openai = createOpenAI({
      apiKey: this.env.OPENAI_API_KEY
    });
    const model = openai("gpt-5-mini");

    const userMessage = this.state.messages[this.state.messages.length - 1];
    console.log("\n╔═════════════════════════════════════════════════════════");
    console.log("║ [LLM] GPT-5-mini");
    console.log("╠═════════════════════════════════════════════════════════");
    console.log(
      "║ User Input:",
      userMessage?.parts?.map((p: any) => p.text).join(" ")
    );
    console.log(
      "║ Available Tools:",
      Object.keys(tracedTools).join(", ") || "(none)"
    );
    console.log("╚═════════════════════════════════════════════════════════");

    // LLM call with MCP tools
    const result = streamText({
      system:
        "You are a helpful assistant. Answer questions directly and concisely. Use the available tools when appropriate to help answer questions.",
      messages: await convertToModelMessages(this.state.messages),
      model,
      tools: tracedTools,
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

    const currentUsage: TokenUsage = usage
      ? {
          inputTokens: usage.inputTokens ?? usage.promptTokens ?? 0,
          outputTokens: usage.outputTokens ?? usage.completionTokens ?? 0,
          totalTokens: usage.totalTokens ?? 0
        }
      : { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

    // Get previous cumulative metrics (use savedMetrics captured at start)
    const prevCumulative = savedMetrics?.cumulativeUsage ?? {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0
    };
    const prevRequestCount = savedMetrics?.requestCount ?? 0;
    const prevCumulativeDuration = savedMetrics?.cumulativeDurationMs ?? 0;
    console.log(
      "[DEBUG] Using prevRequestCount:",
      prevRequestCount,
      "prevCumulative:",
      JSON.stringify(prevCumulative)
    );

    // Calculate new cumulative totals
    const cumulativeUsage: TokenUsage = {
      inputTokens: prevCumulative.inputTokens + currentUsage.inputTokens,
      outputTokens: prevCumulative.outputTokens + currentUsage.outputTokens,
      totalTokens: prevCumulative.totalTokens + currentUsage.totalTokens
    };

    const metrics: RequestMetrics = {
      usage: currentUsage,
      durationMs,
      timestamp: new Date().toISOString(),
      requestCount: prevRequestCount + 1,
      cumulativeUsage,
      cumulativeDurationMs: prevCumulativeDuration + durationMs
    };

    console.log("\n╔═════════════════════════════════════════════════════════");
    console.log("║ [LLM] Response Complete");
    console.log("╠═════════════════════════════════════════════════════════");
    console.log("║ Request #" + metrics.requestCount);
    console.log(
      "║ This Request: in=" +
        currentUsage.inputTokens +
        " out=" +
        currentUsage.outputTokens +
        " total=" +
        currentUsage.totalTokens
    );
    console.log(
      "║ Cumulative: in=" +
        cumulativeUsage.inputTokens +
        " out=" +
        cumulativeUsage.outputTokens +
        " total=" +
        cumulativeUsage.totalTokens
    );
    console.log(
      "║ Duration: " +
        durationMs +
        "ms (total: " +
        metrics.cumulativeDurationMs +
        "ms)"
    );
    console.log("╚═════════════════════════════════════════════════════════");

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
