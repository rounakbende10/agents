# Cloudflare Codemode - Findings & Research

**Location**: `/examples/codemode/`
**Status**: Working (with fixes applied)
**Last Updated**: January 29, 2026

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [How the Sandbox Works](#how-the-sandbox-works)
4. [How Tools Are Discovered and Matched](#how-tools-are-discovered-and-matched)
5. [Codemode vs Traditional Tool Calling](#codemode-vs-traditional-tool-calling)
6. [MCP Server Setup](#mcp-server-setup)
7. [Issues & Fixes](#issues--fixes)
8. [Configuration](#configuration)
9. [Test Results](#test-results)
10. [Contribution](#contribution)

---

## Overview

The codemode example is a **React chat application** that showcases:

1. **Code-Mode Execution** - LLM generates JavaScript code that runs in V8 isolates
2. **Dynamic MCP Integration** - Add/remove MCP servers at runtime
3. **Durable Object Agents** - Persistent state via `Agent` class
4. **Real-time WebSocket** - Live state synchronization between frontend and backend

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
                              │ WebSocket (cf_agent_state)
                              ▼
┌─────────────────────────────────────────────────────────────┐
│              Codemode Durable Object Agent                   │
│  - Extends Agent class from 'agents' package                 │
│  - experimental_codemode() wraps tools                       │
│  - Streams responses via setState()                          │
└─────────────────────────────────────────────────────────────┘
                              │
                              │ worker_loaders.get()
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                   V8 Isolate Worker                          │
│  - Dynamically created for each code execution               │
│  - Executes LLM-generated JavaScript                         │
│  - codemode proxy routes calls back to agent                 │
└─────────────────────────────────────────────────────────────┘
                              │
                              │ CodeModeProxy.callFunction()
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    MCP Servers (Optional)                    │
│  - External tool providers added at runtime                  │
│  - Tools become available to LLM                             │
└─────────────────────────────────────────────────────────────┘
```

### Dual LLM Token Flow

Codemode uses two LLM calls per request:

```
User Message
    │
    ▼
┌─────────────────┐
│  Main LLM       │  ◄── Token Usage #1 (orchestration)
│  (GPT-4o)       │
└────────┬────────┘
         │ Decides to use codemode tool
         ▼
┌─────────────────┐
│  Codemode LLM   │  ◄── Token Usage #2 (code generation)
│  (GPT-5.1-codex)│
└────────┬────────┘
         │ Generates JavaScript
         ▼
┌─────────────────┐
│  V8 Isolate     │  Executes code, calls tools
└────────┬────────┘
         ▼
    Tool Results
```

---

## How the Sandbox Works

### Execution Flow

```
User Request → Main LLM → generates function description
                              ↓
                      Code Generation LLM (gpt-5.1-codex-mini)
                              ↓
                      generates JavaScript code
                              ↓
                      Cloudflare Worker Loader
                              ↓
                      Isolated Worker Environment
                              ↓
                      Executes code with tool proxy
```

### Key Components

**1. Worker Loader (`options.loader`)**

Creates a fresh, isolated worker instance for each code execution with a unique ID:

```javascript
const worker = options.loader.get(`code-${Math.random()}`, () => {
  return {
    compatibilityDate: "2025-06-01",
    compatibilityFlags: ["nodejs_compat"],
    mainModule: "foo.js",
    modules: { "foo.js": `...generated code...` },
    env: { CodeModeProxy: options.proxy },
    globalOutbound: null // No direct network access
  };
});
```

**2. Dynamic Worker Module**

The generated code is injected into a `WorkerEntrypoint` class:

```javascript
export default class CodeModeWorker extends WorkerEntrypoint {
  async evaluate() {
    const codemode = new Proxy({}, {
      get: (target, prop) => {
        return (args) => CodeModeProxy.callFunction({
          functionName: prop,
          args: args,
        });
      }
    });
    return await ${generatedCode}();
  }
}
```

**3. Tool Proxy (`CodeModeProxy`)**

- The sandbox cannot directly call tools
- A `Proxy` object intercepts all function calls
- Calls are routed through `CodeModeProxy.callFunction()` back to the main agent
- All tool access is controlled and auditable

### Security Model

| Layer                     | Protection                                    |
| ------------------------- | --------------------------------------------- |
| **Isolation**             | Each execution runs in a separate worker      |
| **No Direct Tool Access** | Code can't bypass the proxy                   |
| **No Network Access**     | `globalOutbound: null` blocks arbitrary fetch |
| **Stateless**             | Workers are ephemeral, no persistence         |
| **Controlled API**        | Only the `codemode` proxy object is exposed   |

---

## How Tools Are Discovered and Matched

### Step 1: Tool Descriptions → Main LLM

The `getToolDescriptions()` function extracts descriptions from your tools and injects them into the main prompt:

```
You have access to the "codemode" tool that can do different things:
- List all calendars for the authenticated user
- List events from a specific calendar
- Create a new calendar event
- Get free/busy information
```

The **main LLM** only knows _what_ tools can do, not _how_ to call them.

### Step 2: Schema → TypeScript Types

The `generateTypes()` function converts Zod/JSON schemas to TypeScript declarations:

```typescript
// Input: MCP tool definitions with JSON schemas
// (e.g., from Google Calendar MCP server)

// Output: Generated TypeScript declarations
interface ListCalendarsInput {
  // no required parameters
}
interface ListCalendarsOutput {
  calendars: Array<{ id: string; summary: string; primary?: boolean }>;
}

interface ListEventsInput {
  calendarId: string;
  timeMin?: string;
  timeMax?: string;
  maxResults?: number;
}
interface ListEventsOutput {
  events: Array<{ id: string; summary: string; start: string; end: string }>;
}

declare const codemode: {
  /*
  List all calendars for the authenticated user
  */
  "tool_Rgo1O6n7_list-calendars": (
    input: ListCalendarsInput
  ) => Promise<ListCalendarsOutput>;

  /*
  List events from a specific calendar
  */
  "tool_Rgo1O6n7_list-events": (
    input: ListEventsInput
  ) => Promise<ListEventsOutput>;
};
```

### Step 3: Types Injected into Code Generation Prompt

The generated TypeScript declarations are passed to the code-generating LLM:

```
You are a code generating machine.

In addition to regular javascript, you can also use the following functions:

${generatedTypes}   // <-- The TypeScript declarations

IMPORTANT: For function names containing hyphens or underscores,
you MUST use bracket notation. For example:
codemode["tool_abc_list-calendars"]({})

Generate an async function that achieves the goal.
```

### Step 4: Proxy Matches Names at Runtime

When generated code runs:

```javascript
await codemode["tool_Rgo1O6n7_list-calendars"]({});
```

The `Proxy` intercepts and routes:

```javascript
const codemode = new Proxy(
  {},
  {
    get: (target, prop) => {
      // prop = "tool_Rgo1O6n7_list-calendars"
      return (args) => {
        // args = {}
        return CodeModeProxy.callFunction({
          functionName: prop, // "tool_Rgo1O6n7_list-calendars"
          args: args // {}
        });
      };
    }
  }
);
```

The `CodeModeProxy` routes to the actual MCP tool, matching by `functionName`.

### Summary

```
MCP Tools (with JSON schemas)
        ↓
generateTypes() converts to TypeScript interfaces
        ↓
TypeScript declarations injected into code-gen prompt
        ↓
Code LLM generates: codemode["tool_xxx_list-calendars"]({})
        ↓
Proxy intercepts call, extracts functionName + args
        ↓
CodeModeProxy.callFunction() routes to MCP tool
        ↓
MCP server executes, returns result
```

---

## Codemode vs Traditional Tool Calling

### Performance Comparison

| Aspect              | Traditional Tool Calling   | Codemode                                  |
| ------------------- | -------------------------- | ----------------------------------------- |
| **Architecture**    | Sequential LLM round-trips | Single code generation + execution        |
| **Parallelism**     | One tool at a time         | `Promise.all()` for concurrent calls      |
| **Latency**         | N tools = N LLM calls      | N tools = 1 LLM call + parallel execution |
| **Control Flow**    | LLM decides each step      | Code handles conditionals/loops           |
| **Data Processing** | LLM processes each result  | JavaScript processes locally              |

### Example: Multi-Calendar Task

**Task:** "Get all calendars, fetch events for next 7 days from each, search web for each meeting topic"

**Traditional (15+ round-trips):**

1. LLM → list-calendars → wait
2. LLM → get-events(cal1) → wait
3. LLM → get-events(cal2) → wait
4. LLM → get-events(cal3) → wait
5. LLM → web-search(event1) → wait
6. ... repeat for each event

**Codemode (1 code generation):**

```javascript
const calendars = await codemode["tool_abc_list-calendars"]({});
const events = await Promise.all(
  calendars.map((cal) =>
    codemode["tool_abc_list-events"]({
      calendarId: cal.id,
      startDate: "2026-01-28",
      endDate: "2026-02-04"
    })
  )
);
const searches = await Promise.all(
  events.flat().map((e) => codemode["tool_serper_search"]({ query: e.summary }))
);
return { calendars, events, searches };
```

---

## MCP Server Setup

### Google Calendar MCP

We use [nspady/google-calendar-mcp](https://github.com/nspady/google-calendar-mcp) for calendar integration.

#### Step 1: Create Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select existing
3. Enable the **Google Calendar API**:
   - Navigate to "APIs & Services" → "Library"
   - Search for "Google Calendar API" and enable it

#### Step 2: Create OAuth Credentials

1. Go to "APIs & Services" → "Credentials"
2. Click "Create Credentials" → "OAuth client ID"
3. Select "Desktop app" as application type
4. Download the JSON file and save as `credentials.json` in project root:

```json
{
  "installed": {
    "client_id": "xxxxx.apps.googleusercontent.com",
    "project_id": "your-project-id",
    "auth_uri": "https://accounts.google.com/o/oauth2/auth",
    "token_uri": "https://oauth2.googleapis.com/token",
    "client_secret": "GOCSPX-xxxxx",
    "redirect_uris": ["http://localhost"]
  }
}
```

#### Step 3: Generate Token File

Run the MCP server auth flow to generate tokens:

```bash
# Using npx
npx @anthropic/mcp-server-google-calendar auth

# Or with environment variable
GOOGLE_OAUTH_CREDENTIALS=./credentials.json npx @cocal/google-calendar-mcp auth
```

This opens a browser for Google OAuth consent. After authorization, tokens are saved to `token.json`:

```json
{
  "access_token": "ya29.xxxxx",
  "refresh_token": "1//xxxxx",
  "scope": "https://www.googleapis.com/auth/calendar",
  "token_type": "Bearer",
  "expiry_date": 1737985234567
}
```

#### Step 4: Start the MCP Server

```bash
# Option 1: Using npx with SSE transport
npx @anthropic/mcp-server-google-calendar --transport sse --port 3001

# Option 2: Using mcp-remote for SSE proxy
npx mcp-remote http://localhost:3001/sse
```

#### Step 5: Connect from Codemode UI

1. Open http://localhost:5173
2. Click "Add MCP Server"
3. Enter:
   - **Name**: `google-calendar`
   - **URL**: `http://localhost:3001/sse`

### Token Refresh

**Important:** Tokens expire after 7 days when the Google Cloud app is in "Testing" mode.

To refresh tokens:

```bash
# Re-run auth flow
npx @anthropic/mcp-server-google-calendar auth
```

To avoid frequent expiry, publish your OAuth app in Google Cloud Console (requires verification).

### Serper MCP (Web Search)

For web search capabilities, use the Serper MCP server.

#### Setup

1. Get API key from [serper.dev](https://serper.dev)
2. Start the server:

```bash
SERPER_API_KEY=your-api-key npx @anthropic/mcp-server-serper --transport sse --port 3002
```

3. Connect from UI:
   - **Name**: `serper`
   - **URL**: `http://localhost:3002/sse`

### File Structure

```
cloudflare-agents-example/
├── credentials.json              # Google OAuth client credentials
├── token.json                    # Generated access/refresh tokens
├── mcp-google-calendar-token.json  # Alternative token location
└── examples/codemode/
    └── .env                      # OPENAI_API_KEY
```

### Security Notes

- Never commit `credentials.json`, `token.json`, or any token files to git
- Add to `.gitignore`:
  ```
  credentials.json
  token.json
  *-token.json
  .gcp-saved-tokens.json
  ```

---

## Issues & Fixes

### Issue 1: Named Entrypoint Export (v0.0.5)

**Error:**

```
Worker's binding "globalOutbound" refers to service with a named entrypoint
"globalOutbound", but it has no such named entrypoint.
```

**Root Cause:** Cloudflare Vite plugin requires `WorkerEntrypoint` classes, not plain objects.

**Reference:** [cloudflare/workers-sdk#9758](https://github.com/cloudflare/workers-sdk/issues/9758)

**Fix in `src/server.ts`:**

```typescript
// Before (broken)
export const globalOutbound = {
  fetch: async (input, init) => { ... }
};

// After (working)
export class globalOutbound extends WorkerEntrypoint {
  async fetch(input, init) { ... }
}
```

**Also add in `vite.config.ts`:**

```typescript
define: {
  __filename: "'index.ts'",
  __dirname: "'/'"  // Required for TypeScript compiler
}
```

---

### Issue 2: Hyphenated MCP Tool Names (v0.0.5)

**Error:**

```
Tool not found: tool-quq-megaflist-calendars
```

**Root Cause:** Lossy round-trip name conversion. The package converts tool names to camelCase for valid JS identifiers, then tries to convert back using kebab-case - but this doesn't preserve underscores or original casing.

| Stage            | Value                          |
| ---------------- | ------------------------------ |
| Original         | `tool_QuqMEGAF_list-calendars` |
| → camelCase      | `toolQuqMegafListCalendars`    |
| → kebab (broken) | `tool-quq-megaflist-calendars` |

**Fix (3 changes in `@cloudflare/codemode/dist/ai.js`):**

1. **Use quoted property names:**

```javascript
// Before
availableTools += `\n\t${toValidIdentifier(toolName)}: ...`;

// After
availableTools += `\n\t"${toolName}": ...`;
```

2. **Add bracket notation instruction to prompt:**

```
IMPORTANT: For function names containing hyphens or underscores,
you MUST use bracket notation: codemode["tool_abc_list-calendars"]({})
```

3. **Pass property names directly (remove toKebabCase):**

```javascript
// Before
functionName: toKebabCase(prop);

// After
functionName: prop;
```

**PR Submitted:** [cloudflare/agents#807](https://github.com/cloudflare/agents/pull/807)

---

### Issue 3: Vite Dependency Caching

**Problem:** Patches to `node_modules/@cloudflare/codemode/dist/ai.js` not reflected at runtime.

**Root Cause:** Vite pre-bundles and caches dependencies.

**Solution:** Patch the Vite bundle directly:

```
node_modules/.vite/deps_codemode_demo/@cloudflare_codemode_ai.js
```

---

## Configuration

### Model Configuration

| Component           | Model                | Location                               |
| ------------------- | -------------------- | -------------------------------------- |
| Codemode (code gen) | `gpt-5.1-codex-mini` | Vite bundle line ~226346               |
| simple-llm          | `gpt-5-mini`         | `examples/simple-llm/src/server.ts:94` |

**Tested Models:**

| Model ID             | Status |
| -------------------- | ------ |
| `gpt-4.1`            | Works  |
| `gpt-4o`             | Works  |
| `gpt-5-mini`         | Works  |
| `gpt-5.1-codex-mini` | Works  |

### wrangler.jsonc

```jsonc
{
  "name": "codemode-demo",
  "main": "src/server.ts",
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

### Environment Variables

```env
OPENAI_API_KEY=sk-your-openai-api-key
```

### MCP Tool Naming Convention

MCP servers prefix tool names with a unique server ID:

```
tool_{serverId}_{originalToolName}

Examples:
- tool_LsJQQ4r_google_search
- tool_Rgo1O6n7_list-calendars
- tool_tdRolmkh_calculate
```

---

## Test Results

### Simple Arithmetic

**Input:** "What is 5 + 3?"

**Generated Code:**

```javascript
async function computeSum() {
  return 5 + 3;
}
```

**Result:** `8`

### Fibonacci Sequence

**Input:** "Generate an array of the first 5 fibonacci numbers"

**Generated Code:**

```javascript
async function getFirstFiveFibonacci() {
  const fib = [0, 1];
  while (fib.length < 5) {
    fib.push(fib[fib.length - 1] + fib[fib.length - 2]);
  }
  return fib;
}
```

**Result:** `[0, 1, 1, 2, 3]`

### Token Usage Example

```json
{
  "usage": {
    "inputTokens": 961,
    "outputTokens": 221,
    "totalTokens": 1182
  },
  "codemodeUsage": {
    "inputTokens": 7918,
    "outputTokens": 46,
    "totalTokens": 7964
  },
  "durationMs": 6358
}
```

---

## Contribution

### PR #807: Fix MCP Tool Name Handling

**Repository:** [cloudflare/agents](https://github.com/cloudflare/agents)
**Status:** Open (pending review)
**CI Status:** Core tests passed; `sync-docs` and `claude-review` failed due to fork PR permission restrictions (OIDC tokens unavailable)

**Changes:**

- Use quoted property names in TypeScript declarations
- Add bracket notation instruction to prompt
- Pass function names directly without transformation
- Update model to `gpt-5.1-codex-mini`

---

## Key Files

| File             | Purpose                                        |
| ---------------- | ---------------------------------------------- |
| `src/server.ts`  | Durable Object agent with codemode integration |
| `src/client.tsx` | React frontend with useAgent hook              |
| `src/tools.ts`   | Tool definitions (empty - uses MCP)            |
| `wrangler.jsonc` | Worker configuration                           |
| `vite.config.ts` | Vite + Cloudflare plugin config                |

---

## Resources

- [Cloudflare Code-Mode Blog](https://blog.cloudflare.com/code-mode/)
- [Agents SDK Documentation](https://github.com/cloudflare/agents)
- [Vite Plugin Documentation](https://developers.cloudflare.com/workers/frameworks/framework-guides/vite/)
