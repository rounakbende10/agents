import { routeAgentRequest, Agent, callable, type Connection } from "agents";

import { getSchedulePrompt } from "agents/schedule";

import { experimental_codemode as codemode } from "@cloudflare/codemode/ai";
import {
  streamText,
  type UIMessage,
  stepCountIs,
  convertToModelMessages,
  type ToolSet,
  readUIMessageStream,
  generateId
} from "ai";
import { openai } from "@ai-sdk/openai";
import { tools } from "./tools";
import { env, WorkerEntrypoint } from "cloudflare:workers";

// export this WorkerEntryPoint that lets you
// reroute function calls back to a caller
export { CodeModeProxy } from "@cloudflare/codemode/ai";

// inline this until enable_ctx_exports is supported by default
declare global {
  interface ExecutionContext<Props = unknown> {
    readonly exports: Cloudflare.Exports;
    readonly props: Props;
  }

  interface DurableObjectState<Props = unknown> {
    readonly exports: Cloudflare.Exports;
    readonly props: Props;
  }
}

// OpenAI - Using GPT-5-mini for better task decomposition
const model = openai("gpt-5-mini");

// Global outbound handler as a WorkerEntrypoint for Vite plugin compatibility
export class globalOutbound extends WorkerEntrypoint {
  async fetch(
    input: string | URL | RequestInfo,
    init?: RequestInit<CfProperties<unknown>> | undefined
  ): Promise<Response> {
    const url = new URL(
      typeof input === "string"
        ? input
        : typeof input === "object" && "url" in input
          ? input.url
          : input.toString()
    );
    if (url.hostname === "example.com" && url.pathname === "/sub-path") {
      return new Response("Not allowed", { status: 403 });
    }
    return fetch(input, init);
  }
}

type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

type RequestMetrics = {
  // Current request metrics
  usage?: TokenUsage;
  codemodeUsage?: TokenUsage;
  durationMs?: number;
  timestamp?: string;
  // Cumulative metrics across all requests in session
  requestCount?: number;
  cumulativeUsage?: TokenUsage;
  cumulativeDurationMs?: number;
  // Codemode-specific metrics
  codemodeCallCount?: number;
  retryCount?: number;
};

type State = {
  messages: UIMessage<typeof tools>[];
  loading: boolean;
  metrics?: RequestMetrics;
};

export class Codemode extends Agent<Env, State> {
  /**
   * Handles incoming chat messages and manages the response stream
   */
  tools: ToolSet = {};

  observability = undefined;

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
    void this.addMcpServer(name, url, "http://localhost:5173")
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

  callTool(functionName: string, args: unknown[]) {
    return this.tools[functionName]?.execute?.(args, {
      abortSignal: new AbortController().signal,
      toolCallId: "123",
      messages: []
    });
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
    // Collect all tools, including MCP tools
    const startTime = Date.now();
    this.setState({
      messages: this.state.messages,
      loading: true,
      metrics: undefined
    });
    const allTools = {
      ...tools,
      ...this.mcp.getAITools()
    };

    this.tools = allTools;

    const { prompt: codemodePrompt, tools: wrappedTools } = await codemode({
      prompt: `You are a helpful assistant that can do various tasks using the codemode tool.

TASK BATCHING: The codemode tool generates JavaScript that can execute multiple tool calls, loops, and data transformations. Batch related operations together to minimize calls.

GUIDELINES:
- Operations on the same service/API → batch into one codemode call
- Fetch data + use that data → batch together (the code can store results in variables)
- Sequential dependencies → batch together (code handles the flow)
- Unrelated services → separate codemode calls

NEVER skip any part of the user's request. When in doubt, include the task.

${getSchedulePrompt({ date: new Date() })}
`,
      tools: allTools,
      globalOutbound: env.globalOutbound,
      loader: env.LOADER,
      proxy: this.ctx.exports.CodeModeProxy({
        props: {
          binding: "Codemode",
          name: this.name,
          callback: "callTool"
        }
      })
    });

    const userMessage = this.state.messages[this.state.messages.length - 1];
    console.log("\n╔═════════════════════════════════════════════════════════");
    console.log("║ [MAIN LLM] GPT-5-mini");
    console.log("╠═════════════════════════════════════════════════════════");
    console.log(
      "║ User Input:",
      userMessage?.parts?.map((p: any) => p.text).join(" ")
    );
    console.log("║ Available Tools:", Object.keys(wrappedTools).join(", "));
    console.log("╚═════════════════════════════════════════════════════════");

    const result = streamText({
      system: codemodePrompt,

      messages: await convertToModelMessages(this.state.messages),
      model,
      // tools: allTools,
      tools: wrappedTools,

      onError: (error) => {
        console.error("error", error);
      },
      // onFinish: ({response}) => {
      //   this.setState({ messages: this.state.messages, loading: false });
      // },

      stopWhen: stepCountIs(10)
    });

    for await (const uiMessage of readUIMessageStream<UIMessage<typeof tools>>({
      stream: result.toUIMessageStream({
        generateMessageId: generateId
      }),
      onError: (error) => {
        console.error("error", error);
      }
    })) {
      // console.log("Current message state:", uiMessage);
      this.setState({
        messages: updateMessages(this.state.messages, uiMessage),
        loading: this.state.loading
      });
    }

    // Capture metrics after completion
    const durationMs = Date.now() - startTime;
    const usage = await result.usage;

    // Extract and ACCUMULATE codemodeUsage from ALL codemode tool calls
    let codemodeUsage: TokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0
    };
    let codemodeCallCount = 0;
    let retryCount = 0;

    for (const msg of this.state.messages) {
      if (msg.role === "assistant" && msg.parts) {
        for (const part of msg.parts) {
          const toolPart = part as any;

          // Check for tool output format
          if (
            toolPart.type?.startsWith("tool-") &&
            toolPart.output?.codemodeUsage
          ) {
            const usage = toolPart.output.codemodeUsage;
            codemodeUsage.inputTokens += usage.inputTokens ?? 0;
            codemodeUsage.outputTokens += usage.outputTokens ?? 0;
            codemodeUsage.totalTokens += usage.totalTokens ?? 0;
            codemodeCallCount += toolPart.output.codemodeCallCount ?? 0;
            retryCount += toolPart.output.retryCount ?? 0;
          }

          // Check for tool-invocation format
          if (
            part.type === "tool-invocation" &&
            toolPart.toolInvocation?.result?.codemodeUsage
          ) {
            const usage = toolPart.toolInvocation.result.codemodeUsage;
            codemodeUsage.inputTokens += usage.inputTokens ?? 0;
            codemodeUsage.outputTokens += usage.outputTokens ?? 0;
            codemodeUsage.totalTokens += usage.totalTokens ?? 0;
            codemodeCallCount +=
              toolPart.toolInvocation.result.codemodeCallCount ?? 0;
            retryCount += toolPart.toolInvocation.result.retryCount ?? 0;
          }
        }
      }
    }

    // Convert to undefined if no codemode usage was found
    const hasCodemodeUsage = codemodeUsage.totalTokens > 0;

    // Calculate cumulative metrics
    const prevMetrics = this.state.metrics;
    const prevRequestCount = prevMetrics?.requestCount ?? 0;
    const prevCumulative = prevMetrics?.cumulativeUsage ?? {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0
    };

    const currentUsage: TokenUsage = {
      inputTokens:
        (usage?.inputTokens ?? 0) + (codemodeUsage?.inputTokens ?? 0),
      outputTokens:
        (usage?.outputTokens ?? 0) + (codemodeUsage?.outputTokens ?? 0),
      totalTokens: (usage?.totalTokens ?? 0) + (codemodeUsage?.totalTokens ?? 0)
    };

    const metrics: RequestMetrics = {
      usage: usage
        ? {
            inputTokens: usage.inputTokens ?? 0,
            outputTokens: usage.outputTokens ?? 0,
            totalTokens: usage.totalTokens ?? 0
          }
        : undefined,
      codemodeUsage: hasCodemodeUsage ? codemodeUsage : undefined,
      durationMs,
      timestamp: new Date().toISOString(),
      // Cumulative metrics
      requestCount: prevRequestCount + 1,
      cumulativeUsage: {
        inputTokens: prevCumulative.inputTokens + currentUsage.inputTokens,
        outputTokens: prevCumulative.outputTokens + currentUsage.outputTokens,
        totalTokens: prevCumulative.totalTokens + currentUsage.totalTokens
      },
      cumulativeDurationMs:
        (prevMetrics?.cumulativeDurationMs ?? 0) + durationMs,
      // Codemode-specific
      codemodeCallCount,
      retryCount
    };

    console.log("\n╔═════════════════════════════════════════════════════════");
    console.log("║ [MAIN LLM] Response Complete");
    console.log("╠═════════════════════════════════════════════════════════");
    console.log(
      "║ Main LLM Tokens: in=" +
        (metrics.usage?.inputTokens ?? 0) +
        " out=" +
        (metrics.usage?.outputTokens ?? 0) +
        " total=" +
        (metrics.usage?.totalTokens ?? 0)
    );
    if (metrics.codemodeUsage) {
      console.log(
        "║ Codemode Tokens: in=" +
          metrics.codemodeUsage.inputTokens +
          " out=" +
          metrics.codemodeUsage.outputTokens +
          " total=" +
          metrics.codemodeUsage.totalTokens
      );
    }
    console.log("║ Duration:", durationMs + "ms");
    console.log("╠═════════════════════════════════════════════════════════");
    console.log("║ Request #" + metrics.requestCount);
    console.log("║ Cumulative Tokens: " + metrics.cumulativeUsage?.totalTokens);
    console.log("║ Codemode LLM Calls: " + codemodeCallCount);
    if (retryCount > 0) {
      console.log("║ Retry Attempts: " + retryCount);
    }
    console.log("╚═════════════════════════════════════════════════════════");

    // Log final text response
    const lastMessage = this.state.messages[this.state.messages.length - 1];
    if (lastMessage?.role === "assistant") {
      const textParts = lastMessage.parts
        ?.filter((p: any) => p.type === "text")
        .map((p: any) => p.text)
        .join("");
      if (textParts) {
        console.log(
          "\n╔═════════════════════════════════════════════════════════"
        );
        console.log("║ [FINAL RESPONSE]");
        console.log(
          "╠═════════════════════════════════════════════════════════"
        );
        console.log("║", textParts.split("\n").join("\n║ "));
        console.log(
          "╚═════════════════════════════════════════════════════════"
        );
      }
    }

    this.setState({
      messages: this.state.messages,
      loading: false,
      metrics
    });
  }
}

function updateMessages(
  messages: UIMessage<typeof tools>[],
  newMessage: UIMessage<typeof tools>
) {
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

/**
 * Worker entry point that routes incoming requests to the appropriate handler
 */
export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext) {
    return (
      // Route the request to our agent or return 404 if not found
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
