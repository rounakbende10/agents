import { createRoot } from "react-dom/client";
import { useAgent } from "agents/react";
import "./styles.css";
import { generateId, type UIMessage } from "ai";
import { useState, useEffect, useRef } from "react";
import type { Simplechat } from "./server";
import type { MCPServersState } from "agents";

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

type AgentState = {
  messages: UIMessage[];
  loading: boolean;
  metrics?: RequestMetrics;
};

function App() {
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [inputMessage, setInputMessage] = useState("");
  const [mcpServers, setMcpServers] = useState<MCPServersState>();
  const [newServerName, setNewServerName] = useState("");
  const [newServerUrl, setNewServerUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [metrics, setMetrics] = useState<RequestMetrics | undefined>();
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const agent = useAgent<Simplechat, AgentState>({
    agent: "simplechat",
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
      parts: [{ type: "text", text: inputMessage }]
    };

    agent.setState({ messages: [...messages, userMessage], loading, metrics });
    setInputMessage("");
  };

  const resetMessages = () => {
    agent.setState({ messages: [], loading: false, metrics: undefined });
    setMetrics(undefined);
  };

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  return (
    <div className="app">
      <header className="header">
        <h1>Simple LLM with MCP Tools</h1>
        <p>Direct GPT-5-mini calls with MCP tool support</p>
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
                    <button
                      type="button"
                      onClick={() => removeMCPServer(id)}
                      className="remove-btn"
                    >
                      Remove
                    </button>
                  </div>
                </div>

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
              </div>
            ))}
          </div>
        </section>

        {/* Chat Section */}
        <section className="chat-section">
          <div className="chat-header">
            <h2>Chat</h2>
            <button
              type="button"
              onClick={resetMessages}
              className="reset-btn"
              disabled={messages.length === 0}
            >
              Reset
            </button>
          </div>

          {metrics && (
            <div className="metrics-bar">
              {metrics.requestCount && (
                <div className="metric-item">
                  <span className="metric-label">Requests:</span>
                  <span className="metric-value">{metrics.requestCount}</span>
                </div>
              )}
              {metrics.cumulativeUsage && (
                <div className="metric-item">
                  <span className="metric-label">Total Tokens:</span>
                  <span className="metric-value">
                    {metrics.cumulativeUsage.inputTokens} in /{" "}
                    {metrics.cumulativeUsage.outputTokens} out (
                    {metrics.cumulativeUsage.totalTokens} total)
                  </span>
                </div>
              )}
              {metrics.cumulativeDurationMs && (
                <div className="metric-item">
                  <span className="metric-label">Total Duration:</span>
                  <span className="metric-value">
                    {(metrics.cumulativeDurationMs / 1000).toFixed(2)}s
                  </span>
                </div>
              )}
              {metrics.usage &&
                metrics.requestCount &&
                metrics.requestCount > 1 && (
                  <div className="metric-item metric-secondary">
                    <span className="metric-label">Last Request:</span>
                    <span className="metric-value">
                      {metrics.usage.totalTokens} tokens,{" "}
                      {(metrics.durationMs! / 1000).toFixed(2)}s
                    </span>
                  </div>
                )}
            </div>
          )}

          <div className="chat-container">
            <div className="messages">
              {messages.map((message) => (
                <div key={message.id} className={`message ${message.role}`}>
                  <div className="message-content">
                    {message.parts.map((part, index) => {
                      if (part.type === "text") {
                        return (
                          <span key={`${message.id}-${index}`}>
                            {part.text}
                          </span>
                        );
                      }
                      // Skip step-start and other internal parts
                      if (
                        part.type === "step-start" ||
                        part.type === "step-finish"
                      ) {
                        return null;
                      }
                      // Handle tool invocations
                      if (part.type === "tool-invocation") {
                        const toolPart = part as any;
                        return (
                          <div
                            key={`${message.id}-${index}`}
                            className="part-block tool-block"
                          >
                            <div className="part-header">
                              <span className="part-icon">🔧</span>
                              <span className="part-title">
                                Tool:{" "}
                                {toolPart.toolInvocation?.toolName || "unknown"}
                              </span>
                              {toolPart.toolInvocation?.state && (
                                <span
                                  className={`tool-state ${toolPart.toolInvocation.state}`}
                                >
                                  {toolPart.toolInvocation.state}
                                </span>
                              )}
                            </div>
                            <div className="part-content">
                              {toolPart.toolInvocation?.args && (
                                <div className="tool-section">
                                  <div className="tool-section-title">
                                    Input:
                                  </div>
                                  <pre className="tool-data">
                                    {JSON.stringify(
                                      toolPart.toolInvocation.args,
                                      null,
                                      2
                                    )}
                                  </pre>
                                </div>
                              )}
                              {toolPart.toolInvocation?.result && (
                                <div className="tool-section">
                                  <div className="tool-section-title">
                                    Output:
                                  </div>
                                  <pre className="tool-data">
                                    {JSON.stringify(
                                      toolPart.toolInvocation.result,
                                      null,
                                      2
                                    )}
                                  </pre>
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      }
                      return null;
                    })}
                  </div>
                </div>
              ))}
              {loading && (
                <div className="message assistant">
                  <div className="message-content loading">...</div>
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
