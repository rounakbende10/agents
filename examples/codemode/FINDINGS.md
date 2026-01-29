# Cloudflare Codemode - Findings & Research

**Location**: `/examples/codemode/`
**Status**: Working (with fixes applied)
**Last Updated**: January 29, 2026

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [How the Sandbox Works](#how-the-sandbox-works)
4. [Tool Discovery & TypeScript Generation](#tool-discovery--typescript-generation)
5. [Why TypeScript API Over JSON Schema](#why-typescript-api-over-json-schema)
6. [MCP Server Setup](#mcp-server-setup)
7. [Issues & Fixes](#issues--fixes)
8. [Configuration](#configuration)
9. [Contribution](#contribution)

---

## Overview

Codemode is a pattern where LLMs generate executable JavaScript code instead of making direct tool calls. This enables:

- **Parallel execution** via `Promise.all()`
- **Complex control flow** (loops, conditionals)
- **Local data processing** without LLM round-trips
- **Single code generation** for multi-tool tasks

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    React Frontend (Vite)                     │
│  - Chat interface with message history                       │
│  - MCP server management UI                                  │
│  - useAgent() hook for WebSocket state sync                  │
└─────────────────────────────────────────────────────────────┘
                              │
                              │ WebSocket
                              ▼
┌─────────────────────────────────────────────────────────────┐
│              Codemode Durable Object Agent                   │
│  - experimental_codemode() wraps tools                       │
│  - generateTypes() creates TypeScript declarations           │
│  - Streams responses via setState()                          │
└─────────────────────────────────────────────────────────────┘
                              │
                              │ worker_loaders.get()
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                   V8 Isolate Worker                          │
│  - Dynamically created for each code execution               │
│  - Executes LLM-generated JavaScript                         │
│  - Proxy routes tool calls back to agent                     │
└─────────────────────────────────────────────────────────────┘
                              │
                              │ CodeModeProxy.callFunction()
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    MCP Servers                               │
│  - Google Calendar, Serper, etc.                             │
│  - Tools become available to LLM via TypeScript API          │
└─────────────────────────────────────────────────────────────┘
```

### Dual LLM Flow

```
User Message
    │
    ▼
┌─────────────────┐
│  Main LLM       │  Token Usage #1 - decides to use codemode
│  (GPT-4o)       │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Codemode LLM   │  Token Usage #2 - generates JavaScript
│  (GPT-5.1-codex)│
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  V8 Isolate     │  Executes code, calls multiple tools
└────────┬────────┘
         ▼
    Aggregated Results
```

---

## How the Sandbox Works

### Security Model

| Layer                     | Protection                                    |
| ------------------------- | --------------------------------------------- |
| **Isolation**             | Each execution runs in a separate worker      |
| **No Direct Tool Access** | Code can't bypass the proxy                   |
| **No Network Access**     | `globalOutbound: null` blocks arbitrary fetch |
| **Stateless**             | Workers are ephemeral, no persistence         |
| **Controlled API**        | Only the `codemode` proxy object is exposed   |

### Worker Creation

```javascript
const worker = options.loader.get(`code-${Math.random()}`, () => ({
  compatibilityDate: "2025-06-01",
  compatibilityFlags: ["nodejs_compat"],
  mainModule: "foo.js",
  modules: { "foo.js": `...generated code...` },
  env: { CodeModeProxy: options.proxy },
  globalOutbound: null
}));
```

### Proxy Interception

All tool calls are intercepted by a `Proxy` object:

```javascript
const codemode = new Proxy(
  {},
  {
    get: (target, prop) => {
      return (args) =>
        CodeModeProxy.callFunction({
          functionName: prop,
          args: args
        });
    }
  }
);
```

---

## Tool Discovery & TypeScript Generation

### The Complete Pipeline

```
┌─────────────────────────────────────────────────────────────┐
│  1. MCP Tools with Schemas                                   │
│     tool.inputSchema (Zod or JSON Schema)                    │
│     tool.outputSchema                                        │
│     tool.description                                         │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  2. generateTypes() Function                                 │
│     - compileJsonSchemaToTs() for JSON schemas               │
│     - zodToTs() for Zod schemas                              │
│     - Builds TypeScript interface strings                    │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  3. TypeScript Declaration Output                            │
│     interface ListCalendarsInput { ... }                     │
│     interface ListCalendarsOutput { ... }                    │
│     declare const codemode: { ... }                          │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  4. Injected into Code Generation Prompt                     │
│     "You can use these functions: ${generatedTypes}"         │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  5. Code LLM Generates JavaScript                            │
│     Uses bracket notation for tool calls                     │
└─────────────────────────────────────────────────────────────┘
```

### Code-Level Implementation

**Step 1: `generateTypes()` iterates over tools**

```typescript
// packages/codemode/src/ai.ts
async function generateTypes(tools: ToolSet) {
  let availableTools = "";
  let availableTypes = "";

  for (const [toolName, tool] of Object.entries(tools)) {
    // Convert schema to TypeScript
    const inputType = tool.inputSchema.jsonSchema
      ? await compileJsonSchemaToTs(tool.inputSchema.jsonSchema, ...)
      : printNodeZodToTs(zodToTs(tool.inputSchema, ...));

    // Build interface and function signature
    availableTypes += `\ninterface ${toolName}Input ${inputType}`;
    availableTools += `\n  "${toolName}": (input: ${toolName}Input) => Promise<...>;`;
  }

  return `${availableTypes}\ndeclare const codemode: {${availableTools}}`;
}
```

**Step 2: Generated TypeScript output**

```typescript
interface ListCalendarsInput {}
interface ListCalendarsOutput {
  calendars: Array<{ id: string; summary: string; primary?: boolean }>;
}

interface ListEventsInput {
  calendarId: string;
  timeMin?: string;
  timeMax?: string;
}
interface ListEventsOutput {
  events: Array<{ id: string; summary: string; start: string }>;
}

declare const codemode: {
  "tool_Rgo1O6n7_list-calendars": (
    input: ListCalendarsInput
  ) => Promise<ListCalendarsOutput>;
  "tool_Rgo1O6n7_list-events": (
    input: ListEventsInput
  ) => Promise<ListEventsOutput>;
};
```

**Step 3: Prompt sent to Code LLM**

```
┌─────────────────────────────────────────────────────────────────┐
│ You are a code generating machine.                              │
│                                                                 │
│ In addition to regular javascript, you can use these functions: │
│                                                                 │
│ interface ListCalendarsInput {}                                 │
│ interface ListCalendarsOutput {                                 │
│   calendars: Array<{id: string; summary: string}>               │
│ }                                                               │
│ interface ListEventsInput {                                     │
│   calendarId: string;                                           │
│   timeMin?: string;                                             │
│   timeMax?: string;                                             │
│ }                                                               │
│ interface ListEventsOutput {                                    │
│   events: Array<{id: string; summary: string; start: string}>   │
│ }                                                               │
│                                                                 │
│ declare const codemode: {                                       │
│   "tool_Rgo1O6n7_list-calendars": (input: ListCalendarsInput)   │
│     => Promise<ListCalendarsOutput>;                            │
│   "tool_Rgo1O6n7_list-events": (input: ListEventsInput)         │
│     => Promise<ListEventsOutput>;                               │
│ }                                                               │
│                                                                 │
│ IMPORTANT: Use bracket notation for hyphenated names:           │
│ codemode["tool_abc_list-calendars"]({})                         │
│                                                                 │
│ Generate an async function for: "Get all my events this week"   │
└─────────────────────────────────────────────────────────────────┘
```

**Step 4: LLM generates code**

```javascript
async function() {
  const { calendars } = await codemode["tool_Rgo1O6n7_list-calendars"]({});
  const now = new Date();
  const weekLater = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  const events = await Promise.all(
    calendars.map(cal =>
      codemode["tool_Rgo1O6n7_list-events"]({
        calendarId: cal.id,
        timeMin: now.toISOString(),
        timeMax: weekLater.toISOString()
      })
    )
  );

  return events.flat();
}
```

**Step 5: Proxy routes calls to MCP tools**

The `functionName` (e.g., `"tool_Rgo1O6n7_list-calendars"`) matches exactly with the MCP tool registry.

---

## Why TypeScript API Over JSON Schema

### Comparison

| Aspect           | JSON Schema (Traditional)           | TypeScript API (Codemode) |
| ---------------- | ----------------------------------- | ------------------------- |
| **Format**       | Verbose JSON                        | Concise TypeScript        |
| **LLM Training** | Less familiar                       | Heavily trained on TS/JS  |
| **Nesting**      | `{"type":"object","properties":{}}` | `{ field: Type }`         |
| **Optionals**    | `"required": []` array              | `field?: type`            |
| **Arrays**       | `{"type":"array","items":{...}}`    | `Type[]`                  |
| **Token Usage**  | ~4000-6000 for 20 tools             | ~1500-2500 for 20 tools   |

### Example: Complex Nested Type

**JSON Schema (verbose):**

```json
{
  "type": "object",
  "properties": {
    "attendees": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "email": { "type": "string" },
          "optional": { "type": "boolean" }
        },
        "required": ["email"]
      }
    }
  }
}
```

**TypeScript (concise):**

```typescript
{
  attendees?: Array<{ email: string; optional?: boolean }>;
}
```

### Multi-Tool Execution

**Traditional (15+ LLM round-trips):**

```
LLM → list-calendars → wait → LLM
LLM → get-events(cal1) → wait → LLM
LLM → get-events(cal2) → wait → LLM
LLM → web-search(event1) → wait → LLM
... repeat
```

**Codemode (1 LLM call + parallel execution):**

```javascript
const calendars = await codemode["list-calendars"]({});
const events = await Promise.all(
  calendars.map((cal) => codemode["list-events"]({ calendarId: cal.id }))
);
const searches = await Promise.all(
  events.flat().map((e) => codemode["web-search"]({ query: e.summary }))
);
return { calendars, events, searches };
```

---

## MCP Server Setup

### Google Calendar MCP

We use [nspady/google-calendar-mcp](https://github.com/nspady/google-calendar-mcp).

#### Setup Steps

1. **Create Google Cloud Project**
   - Go to [Google Cloud Console](https://console.cloud.google.com/)
   - Enable **Google Calendar API**

2. **Create OAuth Credentials**
   - "APIs & Services" → "Credentials" → "OAuth client ID"
   - Select "Desktop app", download as `credentials.json`

3. **Generate Token File**

   ```bash
   npx @anthropic/mcp-server-google-calendar auth
   ```

   Tokens saved to `token.json`.

4. **Start MCP Server**

   ```bash
   npx @anthropic/mcp-server-google-calendar --transport sse --port 3001
   ```

5. **Connect from UI**
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

---

## Issues & Fixes

### Issue 1: Named Entrypoint Export

**Error:** `Worker's binding "globalOutbound" refers to service with a named entrypoint "globalOutbound", but it has no such named entrypoint.`

**Reference:** [cloudflare/workers-sdk#9758](https://github.com/cloudflare/workers-sdk/issues/9758)

**Fix:** Export as `WorkerEntrypoint` class, not plain object:

```typescript
// Before
export const globalOutbound = { fetch: async (input, init) => { ... } };

// After
export class globalOutbound extends WorkerEntrypoint {
  async fetch(input, init) { ... }
}
```

Also add in `vite.config.ts`:

```typescript
define: { __filename: "'index.ts'", __dirname: "'/'" }
```

### Issue 2: Hyphenated MCP Tool Names

**Error:** `Tool not found: tool-quq-megaflist-calendars`

**Root Cause:** Lossy camelCase→kebab conversion doesn't preserve underscores/casing.

**Fix (3 changes):**

1. Use quoted property names: `"${toolName}":` instead of `${toValidIdentifier(toolName)}:`
2. Add bracket notation instruction to prompt
3. Pass `functionName: prop` directly (remove `toKebabCase`)

**PR:** [cloudflare/agents#807](https://github.com/cloudflare/agents/pull/807)

### Issue 3: Vite Dependency Caching

**Problem:** Patches to source not reflected at runtime.

**Solution:** Patch Vite bundle directly:

```
examples/codemode/node_modules/.vite/deps_codemode_demo/
```

---

## Configuration

### Models

| Component  | Model                | Location                                   |
| ---------- | -------------------- | ------------------------------------------ |
| Codemode   | `gpt-5.1-codex-mini` | Vite bundle in `.vite/deps_codemode_demo/` |
| simple-llm | `gpt-5-mini`         | `examples/simple-llm/src/server.ts`        |

### MCP Tool Naming

MCP servers prefix tool names: `tool_{serverId}_{originalToolName}`

Examples: `tool_LsJQQ4r_google_search`, `tool_Rgo1O6n7_list-calendars`

### wrangler.jsonc

```jsonc
{
  "compatibility_flags": [
    "nodejs_compat",
    "experimental",
    "enable_ctx_exports"
  ],
  "durable_objects": {
    "bindings": [{ "name": "Codemode", "class_name": "Codemode" }]
  },
  "services": [
    {
      "binding": "globalOutbound",
      "service": "codemode-demo",
      "entrypoint": "globalOutbound"
    },
    {
      "binding": "CodeModeProxy",
      "service": "codemode-demo",
      "entrypoint": "CodeModeProxy"
    }
  ],
  "worker_loaders": [{ "binding": "LOADER" }]
}
```

---

## Contribution

### PR #807: Fix MCP Tool Name Handling

**Repository:** [cloudflare/agents](https://github.com/cloudflare/agents)
**Status:** Open (pending review)
**CI:** Core tests passed; `sync-docs`/`claude-review` failed due to fork PR permission restrictions.

**Changes:**

- Quoted property names in TypeScript declarations
- Bracket notation instruction in prompt
- Direct function name pass-through
- Model update to `gpt-5.1-codex-mini`

---

## Key Files

| File                          | Purpose                      |
| ----------------------------- | ---------------------------- |
| `src/server.ts`               | Durable Object agent         |
| `src/client.tsx`              | React frontend               |
| `packages/codemode/src/ai.ts` | Core codemode implementation |

---

## Resources

- [Cloudflare Code-Mode Blog](https://blog.cloudflare.com/code-mode/)
- [Agents SDK](https://github.com/cloudflare/agents)
- [AI SDK v6 Migration](https://ai-sdk.dev/docs/migration-guides/migration-guide-6-0)
