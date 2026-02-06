# Codemode Demo

LLM-powered code generation and execution in Cloudflare Workers V8 isolates.

## Performance Comparison

| Codemode                            | Traditional                              |
| ----------------------------------- | ---------------------------------------- |
| ![Codemode](./assets/code-mode.png) | ![Traditional](./assets/traditional.png) |

Codemode executes multiple tools in parallel with a single code generation, while traditional tool calling requires sequential LLM round-trips.

## Quick Start

```bash
# From repo root
npm install
npm run build

# Navigate to this example
cd examples/codemode

# Create .env file
echo "OPENAI_API_KEY=sk-your-key-here" > .env

# Start dev server
npm start
```

Open http://localhost:5173 (or 5174/5175 if ports are in use).

## MCP Server Setup

MCP servers run in **stdio mode** by default. Use `supergateway` to expose them as SSE endpoints.

### Google Calendar

**Setup:**

1. Go to [Google Cloud Console](https://console.cloud.google.com/) → Enable **Google Calendar API**
2. Create OAuth credentials: "APIs & Services" → "Credentials" → "OAuth client ID" → "Desktop app"
3. Download as `credentials.json`
4. Run auth: `npx google-calendar-mcp auth` (saves `token.json`)

**Start server:**

```bash
npx -y supergateway --stdio "npx google-calendar-mcp" --port 3001 --cors
```

**Connect:** Name `calendar`, URL `http://localhost:3001/sse`

> Tokens expire after 7 days in "Testing" mode. Re-run auth command to refresh.

### Serper (Web Search)

Get API key from [serper.dev](https://serper.dev)

```bash
SERPER_API_KEY=your-key npx -y supergateway --stdio "npx -y mcp-server-serper" --port 3002 --cors
```

**Connect:** Name `serper`, URL `http://localhost:3002/sse`

> **Note:** The `mcp-server-serper` package reads `SERPER_API_KEY` from environment only in stdio mode. Running directly with `--port` expects API key in request headers instead.

### GitHub

Create token at [GitHub Settings → Personal Access Tokens](https://github.com/settings/tokens) with `repo` scope.

```bash
GITHUB_PERSONAL_ACCESS_TOKEN=your-token npx -y supergateway --stdio "npx -y @modelcontextprotocol/server-github" --port 3003 --cors
```

**Connect:** Name `github`, URL `http://localhost:3003/sse`

### Start All MCP Servers

Create a script to start all servers:

```bash
#!/bin/bash
# start-mcp-servers.sh

# Load environment variables
source .env

# Google Calendar (port 3001)
npx -y supergateway --stdio "npx google-calendar-mcp" --port 3001 --cors &

# Serper Web Search (port 3002)
SERPER_API_KEY=$SERPER_API_KEY npx -y supergateway --stdio "npx -y mcp-server-serper" --port 3002 --cors &

# GitHub (port 3003)
GITHUB_PERSONAL_ACCESS_TOKEN=$GITHUB_PERSONAL_ACCESS_TOKEN npx -y supergateway --stdio "npx -y @modelcontextprotocol/server-github" --port 3003 --cors &

echo "MCP servers started on ports 3001, 3002, 3003"
wait
```

### Security

Add to `.gitignore`:

```
credentials.json
token.json
.env
```

## Project Structure

```
examples/codemode/
├── src/
│   ├── server.ts    # Durable Object agent
│   ├── client.tsx   # React frontend
│   └── tools.ts     # Local tool definitions
├── wrangler.jsonc   # Worker config
├── vite.config.ts   # Vite + Cloudflare plugin
└── .env             # OPENAI_API_KEY
```

## Configuration

### Environment Variables

| Variable         | Required | Description                   |
| ---------------- | -------- | ----------------------------- |
| `OPENAI_API_KEY` | Yes      | OpenAI API key for GPT models |

### Model Configuration

| Component    | Model           | Purpose                    |
| ------------ | --------------- | -------------------------- |
| Main LLM     | `gpt-5-mini`    | Task orchestration         |
| Codemode LLM | `gpt-5.2-codex` | JavaScript code generation |

Models are configured in:

- Main LLM: `src/server.ts`
- Codemode LLM: `packages/codemode/src/ai.ts`

## Known Issues & Fixes

See [FINDINGS.md](./FINDINGS.md) for detailed issue documentation.

### Quick Fixes Required

**1. Named Entrypoint Export**

If you see `Worker's binding "globalOutbound" refers to service with a named entrypoint...`:

In `src/server.ts`, change:

```typescript
// From
export const globalOutbound = { fetch: async (input, init) => { ... } };

// To
export class globalOutbound extends WorkerEntrypoint {
  async fetch(input, init) { ... }
}
```

**2. Add `__dirname` define**

In `vite.config.ts`:

```typescript
define: {
  __filename: "'index.ts'",
  __dirname: "'/'"  // Add this
}
```

## Resources

- [Cloudflare Code-Mode Blog](https://blog.cloudflare.com/code-mode/)
- [Agents SDK](https://github.com/cloudflare/agents)
- [FINDINGS.md](./FINDINGS.md) - Detailed research and fixes
