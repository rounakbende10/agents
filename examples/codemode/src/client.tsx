import { createRoot } from "react-dom/client";
import { useAgent } from "agents/react";
import "./styles.css";
import { generateId, type UIMessage } from "ai";
import { useState, useEffect, useRef } from "react";
import type { Codemode } from "./server";
import type { MCPServersState } from "agents";

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

type AgentState = {
  messages: UIMessage[];
  loading: boolean;
  metrics?: RequestMetrics;
};

// Component to render different types of message parts
function MessagePart({ part }: { part: UIMessage["parts"][0] }) {
  if (part.type === "text") {
    return <span>{part.text}</span>;
  }

  // Don't show step-start blocks
  if (part.type === "step-start") {
    return null;
  }

  if (part.type === "reasoning") {
    // Only show reasoning blocks if they have content
    if (!part.text || part.text.trim() === "") {
      return null;
    }

    return (
      <div className="part-block reasoning-block">
        <div className="part-header">
          <span className="part-icon">🧠</span>
          <span className="part-title">Reasoning</span>
        </div>
        <div className="part-content">{part.text}</div>
      </div>
    );
  }

  if (part.type === "file") {
    return (
      <div className="part-block file-block">
        <div className="part-header">
          <span className="part-icon">📄</span>
          <span className="part-title">
            File: {part.filename || "Untitled"}
          </span>
        </div>
        <div className="part-content">
          <div className="file-info">
            <span className="file-type">{part.mediaType}</span>
            {part.url && (
              <a
                href={part.url}
                target="_blank"
                rel="noopener noreferrer"
                className="file-link"
              >
                View File
              </a>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (part.type.startsWith("tool-")) {
    const toolName = part.type.replace("tool-", "");
    // biome-ignore lint/suspicious/noExplicitAny: it's fine, fix later
    const toolPart = part as any; // Type assertion for tool parts
    return (
      <div className="part-block tool-block">
        <div className="part-header">
          <span className="part-icon">🔧</span>
          <span className="part-title">Tool: {toolName}</span>
          {toolPart.state && (
            <span className={`tool-state ${toolPart.state}`}>
              {toolPart.state}
            </span>
          )}
        </div>
        <div className="part-content">
          {toolPart.input && (
            <div className="tool-section">
              <div className="tool-section-title">Input:</div>
              <div className="tool-data-container">
                {toolPart.input.functionDescription ? (
                  <div className="input-description">
                    <div className="input-header">
                      <span className="input-icon">📝</span>
                      <span className="input-title">Function Description</span>
                    </div>
                    <div className="input-content">
                      {toolPart.input.functionDescription}
                    </div>
                  </div>
                ) : null}
                {Object.keys(toolPart.input).length > 1 ||
                !toolPart.input.functionDescription ? (
                  <div className="input-raw">
                    <div className="input-raw-header">Raw Input:</div>
                    <pre className="tool-data">
                      {JSON.stringify(toolPart.input, null, 2)}
                    </pre>
                  </div>
                ) : null}
              </div>
            </div>
          )}
          {toolPart.output && (
            <div className="tool-section">
              <div className="tool-section-title">Output:</div>
              <div className="tool-data-container">
                {toolPart.output.code ? (
                  <div className="code-output">
                    <div className="code-header">
                      <span className="code-language">JavaScript</span>
                      <button
                        type="button"
                        className="copy-button"
                        onClick={() =>
                          navigator.clipboard.writeText(toolPart.output.code)
                        }
                        title="Copy code"
                      >
                        📋
                      </button>
                    </div>
                    <pre className="code-content">
                      <code>{toolPart.output.code}</code>
                    </pre>
                  </div>
                ) : null}
                {toolPart.output.result && (
                  <div className="result-output">
                    <div className="result-header">Result:</div>
                    <pre className="result-data">
                      {JSON.stringify(toolPart.output.result, null, 2)}
                    </pre>
                  </div>
                )}
                {!toolPart.output.code && !toolPart.output.result && (
                  <pre className="tool-data">
                    {JSON.stringify(toolPart.output, null, 2)}
                  </pre>
                )}
              </div>
            </div>
          )}
          {toolPart.errorText && (
            <div className="tool-section error">
              <div className="tool-section-title">Error:</div>
              <div className="tool-data-container">
                <pre className="tool-data error-data">{toolPart.errorText}</pre>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  // Fallback for unknown part types
  return (
    <div className="part-block unknown-block">
      <div className="part-header">
        <span className="part-icon">❓</span>
        <span className="part-title">{part.type}</span>
      </div>
      <div className="part-content">
        <pre className="part-data">{JSON.stringify(part, null, 2)}</pre>
      </div>
    </div>
  );
}

function App() {
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [inputMessage, setInputMessage] = useState("");
  const [mcpServers, setMcpServers] = useState<MCPServersState>();
  const [newServerName, setNewServerName] = useState("");
  const [newServerUrl, setNewServerUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [metrics, setMetrics] = useState<RequestMetrics | undefined>();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const agent = useAgent<Codemode, AgentState>({
    agent: "codemode",
    onStateUpdate: (state) => {
      setMessages(state.messages);
      setLoading(state.loading);
      setMetrics(state.metrics);
    },
    onMcpUpdate: (mcpServers) => {
      setMcpServers(mcpServers);
    }
  });

  const addMCPServer = () => {
    if (!newServerName.trim() || !newServerUrl.trim()) return;

    agent.call("addMcp", [
      { name: newServerName.trim(), url: newServerUrl.trim() }
    ]);
    setNewServerName("");
    setNewServerUrl("");
  };

  const removeMCPServer = (id: string) => {
    agent.call("removeMcp", [id]);
  };

  const sendMessage = async () => {
    if (!inputMessage.trim()) return;

    const userMessage: UIMessage = {
      id: generateId(),
      role: "user",
      parts: [
        {
          type: "text",
          text: inputMessage
        }
      ]
    };

    agent.setState({ messages: [...messages, userMessage], loading }); // setMessages((prev) => [...prev, userMessage]);
    setInputMessage("");

    // Simulate AI response
    // setTimeout(() => {
    //   const aiMessage: UIMessage = {
    //     id: (Date.now() + 1).toString(),
    //     role: "assistant",
    //     parts: [
    //       {
    //         type: "text",
    //         text: `I received your message: "${inputMessage}". This is a simulated response.`
    //       }
    //     ]
    //   };
    //   setMessages((prev) => [...prev, aiMessage]);
    // }, 1000);
  };

  const resetMessages = () => {
    agent.setState({ messages: [], loading: false });
  };

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  // const getStatusColor = (status: MCPServer["status"]) => {
  //   switch (status) {
  //     case "connected":
  //       return "#4ade80";
  //     case "connecting":
  //       return "#fbbf24";
  //     case "disconnected":
  //       return "#6b7280";
  //     case "error":
  //       return "#ef4444";
  //     default:
  //       return "#6b7280";
  //   }
  // };

  return (
    <div className="app">
      <header className="header">
        <h1>CodeMode Testing App</h1>
        <p>Test MCP servers and chat with LLM</p>
      </header>

      <div className="main-content">
        {/* MCP Servers Section */}
        <section className="mcp-section">
          <h2>MCP Servers</h2>

          {/* Add Server Form */}
          <div className="add-server-form">
            <div className="form-group">
              <input
                type="text"
                placeholder="Server Name"
                value={newServerName}
                onChange={(e) => setNewServerName(e.target.value)}
              />
              <input
                type="url"
                placeholder="Server URL"
                value={newServerUrl}
                onChange={(e) => setNewServerUrl(e.target.value)}
              />
              <button
                type="button"
                onClick={addMCPServer}
                disabled={!newServerName.trim() || !newServerUrl.trim()}
              >
                Add
              </button>
            </div>
          </div>

          {/* Server List */}
          <div className="server-list">
            {Object.entries(mcpServers?.servers ?? {}).map(([id, server]) => (
              <div key={id} className="server-card">
                <div className="server-header">
                  <div className="server-info">
                    <h3>{server.name}</h3>
                    <p className="server-url">{server.server_url}</p>
                  </div>
                  <div className="server-actions">
                    {/* <div
                      className="status-indicator"
                      style={{ backgroundColor: getStatusColor(server.state) }}
                      title={server.status}
                    /> */}
                    <button
                      type="button"
                      onClick={() => removeMCPServer(id)}
                      className="remove-btn"
                    >
                      Remove
                    </button>
                  </div>
                </div>

                {
                  // server.status === "connected" && server.tools.length > 0 && (
                  <div className="server-tools">
                    <h4>Available Tools:</h4>
                    <div className="tools-list">
                      {mcpServers?.tools
                        .filter((tool) => tool.serverId === id)
                        .map((tool) => (
                          <span key={tool.name} className="tool-tag">
                            {tool.name}
                          </span>
                        ))}
                    </div>
                  </div>
                  //)
                }
              </div>
            ))}
          </div>
        </section>

        {/* Chat Section */}
        <section className="chat-section">
          <div className="chat-header">
            <h2>Chat with LLM</h2>
            <button
              type="button"
              onClick={resetMessages}
              className="reset-btn"
              disabled={messages.length === 0}
            >
              Reset Chat
            </button>
          </div>

          {/* Metrics Display */}
          {metrics && (
            <div className="metrics-bar">
              {/* Request counter and cumulative stats */}
              <div className="metrics-header">
                <div className="metric-item metric-request">
                  <span className="metric-label">Request</span>
                  <span className="metric-value metric-badge">
                    #{metrics.requestCount ?? 1}
                  </span>
                </div>
                {metrics.cumulativeUsage && (
                  <div className="metric-item metric-cumulative">
                    <span className="metric-label">Session Total:</span>
                    <span className="metric-value">
                      {metrics.cumulativeUsage.totalTokens.toLocaleString()}{" "}
                      tokens
                    </span>
                  </div>
                )}
                {metrics.cumulativeDurationMs && (
                  <div className="metric-item">
                    <span className="metric-label">Session Time:</span>
                    <span className="metric-value">
                      {(metrics.cumulativeDurationMs / 1000).toFixed(1)}s
                    </span>
                  </div>
                )}
              </div>

              {/* Current request breakdown */}
              <div className="metrics-current">
                <div className="metrics-section-title">Current Request</div>
                <div className="metrics-grid">
                  {metrics.usage && (
                    <div className="metric-item">
                      <span className="metric-label">Main LLM:</span>
                      <span className="metric-value">
                        {metrics.usage.totalTokens.toLocaleString()} tokens
                        <span className="metric-detail">
                          ({metrics.usage.inputTokens} in /{" "}
                          {metrics.usage.outputTokens} out)
                        </span>
                      </span>
                    </div>
                  )}
                  {metrics.codemodeUsage && (
                    <div className="metric-item">
                      <span className="metric-label">Codemode LLM:</span>
                      <span className="metric-value">
                        {metrics.codemodeUsage.totalTokens.toLocaleString()}{" "}
                        tokens
                        <span className="metric-detail">
                          ({metrics.codemodeUsage.inputTokens} in /{" "}
                          {metrics.codemodeUsage.outputTokens} out)
                        </span>
                      </span>
                    </div>
                  )}
                  {metrics.durationMs && (
                    <div className="metric-item">
                      <span className="metric-label">Duration:</span>
                      <span className="metric-value">
                        {(metrics.durationMs / 1000).toFixed(2)}s
                      </span>
                    </div>
                  )}
                </div>
              </div>

              {/* Codemode-specific stats */}
              {(metrics.codemodeCallCount || metrics.retryCount) && (
                <div className="metrics-codemode">
                  <div className="metrics-section-title">Codemode Stats</div>
                  <div className="metrics-grid">
                    {metrics.codemodeCallCount &&
                      metrics.codemodeCallCount > 0 && (
                        <div className="metric-item">
                          <span className="metric-label">LLM Calls:</span>
                          <span className="metric-value metric-badge">
                            {metrics.codemodeCallCount}
                          </span>
                          <span className="metric-detail">
                            (~
                            {Math.round(
                              (metrics.codemodeUsage?.totalTokens ?? 0) /
                                Math.max(metrics.codemodeCallCount, 1)
                            ).toLocaleString()}{" "}
                            tokens/call)
                          </span>
                        </div>
                      )}
                    {metrics.retryCount && metrics.retryCount > 0 && (
                      <div className="metric-item metric-retry">
                        <span className="metric-label">Retries:</span>
                        <span className="metric-value metric-badge-warning">
                          {metrics.retryCount}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Context isolation indicator */}
              <div className="metrics-context">
                <span className="context-badge">
                  Context Isolation: Each Codemode call starts at ~12K tokens
                  (no history accumulation)
                </span>
              </div>
            </div>
          )}

          <div className="chat-container">
            <div className="messages">
              {messages.map((message) => (
                <div key={message.id} className={`message ${message.role}`}>
                  <div className="message-content">
                    {message.parts.map((part, index) => (
                      <div key={`${message.id}-part-${index}`}>
                        <MessagePart part={part} />
                      </div>
                    ))}
                  </div>
                </div>
              ))}
              {loading && (
                <div className="message assistant">
                  <div className="message-content">
                    <div className="loading-indicator">...</div>
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>

            <div className="chat-input">
              <input
                type="text"
                placeholder="Type your message..."
                value={inputMessage}
                onChange={(e) => setInputMessage(e.target.value)}
                onKeyPress={(e) => e.key === "Enter" && sendMessage()}
              />
              <button
                type="button"
                onClick={sendMessage}
                disabled={!inputMessage.trim()}
              >
                Send
              </button>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
