# Codemode Demo

LLM-powered code generation and execution in Cloudflare Workers V8 isolates.

<img width="1481" height="810" alt="image" src="https://github.com/user-attachments/assets/36656642-1b0f-46d9-868b-f13c6e127b5e" />

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

### Google Calendar MCP

We use [nspady/google-calendar-mcp](https://github.com/nspady/google-calendar-mcp).

**1. Create Google Cloud Project**

- Go to [Google Cloud Console](https://console.cloud.google.com/)
- Enable **Google Calendar API**

**2. Create OAuth Credentials**

- "APIs & Services" → "Credentials" → "OAuth client ID"
- Select "Desktop app", download as `credentials.json`

**3. Generate Token File**

```bash
npx @anthropic/mcp-server-google-calendar auth
```

Tokens saved to `token.json`.

**4. Start MCP Server**

```bash
npx @anthropic/mcp-server-google-calendar --transport sse --port 3001
```

**5. Connect from UI**

- Click "Add MCP Server"
- Name: `google-calendar`
- URL: `http://localhost:3001/sse`

### Serper MCP (Web Search)

```bash
SERPER_API_KEY=your-key npx @anthropic/mcp-server-serper --transport sse --port 3002
```

### Token Refresh

Tokens expire after 7 days in "Testing" mode. Re-run auth:

```bash
npx @anthropic/mcp-server-google-calendar auth
```

### Security Notes

Add to `.gitignore`:

```
credentials.json
token.json
*-token.json
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

The code generation model is configured in the `@cloudflare/codemode` package. To change it:

1. Start the dev server: `npm start`
2. Find the Vite bundle (generated at runtime):
   ```
   examples/codemode/node_modules/.vite/deps_codemode_demo/
   ```
3. Search for codemode-related chunks and find `openai("gpt-`
4. Update the model name

**Note:** The bundle is regenerated when Vite re-optimizes dependencies.

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
