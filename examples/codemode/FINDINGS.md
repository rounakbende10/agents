# Cloudflare Codemode - Findings & Research

**Location**: `/examples/codemode/`
**Status**: Working (with fixes applied)
**Last Updated**: February 8, 2026
**Blog Reference**: [Cloudflare Code-Mode Blog](https://blog.cloudflare.com/code-mode/)

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [How the Sandbox Works](#how-the-sandbox-works)
4. [Tool Discovery & TypeScript Generation](#tool-discovery--typescript-generation)
5. [Why TypeScript API Over JSON Schema](#why-typescript-api-over-json-schema)
6. [Issues & Fixes](#issues--fixes)
7. [Configuration](#configuration)
8. [Test Results](#test-results)
9. [Comparative Analysis: Codemode vs Simple-LLM](#comparative-analysis-codemode-vs-simple-llm)
10. [Limitations & Caveats](#limitations--caveats)
11. [Conclusion](#conclusion)
12. [Features Added](#features-added)
13. [Contribution](#contribution)
14. [Key Files](#key-files)
15. [Resources](#resources)

---

## Overview

This document captures research findings from testing Cloudflare's experimental **Codemode** pattern — an alternative to traditional LLM tool calling where the LLM generates executable JavaScript code instead of making direct tool calls.

**Core thesis from the [Cloudflare blog](https://blog.cloudflare.com/code-mode/):**

> "LLMs have seen a lot of code. They have not seen a lot of 'tool calls.'"

Codemode enables:

- **Parallel execution** via `Promise.all()` — multiple tool calls in a single code generation
- **Complex control flow** — loops, conditionals, error handling in generated code
- **Reduced token waste** — tool results processed locally in V8 isolate without LLM round-trips
- **Single code generation** for multi-tool tasks — eliminates the "decide → call → read → decide" loop

This research tests these claims against a traditional tool-calling approach (Simple-LLM) using the same multi-tool query across 3 MCP servers. The key finding: **Codemode uses 2.6x fewer billed tokens per session**, but this advantage is conditional on first-attempt code generation success.

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
│  - Google Calendar, Serper, GitHub                           │
│  - Tools become available to LLM via TypeScript API          │
└─────────────────────────────────────────────────────────────┘
```

### Dual LLM Flow

Codemode uses two separate LLM calls per invocation, each with independent token tracking:

```
User Message
    │
    ▼
┌──────────────────┐
│  Main LLM        │  Token Usage #1 — orchestration
│  (GPT-5-mini)    │  Decides to invoke codemode tool
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│  Codemode LLM    │  Token Usage #2 — code generation
│  (GPT-5.2-codex) │  Generates JavaScript from TypeScript API
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│  V8 Isolate      │  Executes code, calls multiple tools
│                  │  Zero LLM tokens consumed here
└────────┬─────────┘
         ▼
    Aggregated Results → returned to Main LLM
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

**Step 3: LLM generates code**

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

**Step 4: Proxy routes calls to MCP tools**

The `functionName` matches exactly with the MCP tool registry, enabling seamless tool invocation.

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

---

## Issues & Fixes

### Issue 1: Named Entrypoint Export

**Error:** `Worker's binding "globalOutbound" refers to service with a named entrypoint "globalOutbound", but it has no such named entrypoint.`

**Reference:** [cloudflare/workers-sdk#9758](https://github.com/cloudflare/workers-sdk/issues/9758)

**Root Cause:** The `wrangler.jsonc` config defines service bindings (`globalOutbound`, `CodeModeProxy`) that expect named entrypoints. Cloudflare Workers requires these to be exported as `WorkerEntrypoint` classes — plain object exports don't register as named entrypoints.

**Fix:** Export as `WorkerEntrypoint` class, not plain object:

```typescript
// Before — plain object, not recognized as named entrypoint
export const globalOutbound = { fetch: async (input, init) => { ... } };

// After — WorkerEntrypoint class, registers as named entrypoint
export class globalOutbound extends WorkerEntrypoint {
  async fetch(input, init) { ... }
}
```

Additionally, the `@cloudflare/codemode` package internally references `__filename` and `__dirname` (Node.js globals that don't exist in Cloudflare Workers). Since the code runs in a V8 isolate (not Node), these must be shimmed in `vite.config.ts`:

```typescript
define: { __filename: "'index.ts'", __dirname: "'/'" }
```

Without this, the worker crashes with `__filename is not defined` at startup.

### Issue 2: Hyphenated MCP Tool Names

**Error:** `Tool not found: tool-quq-megaflist-calendars`

**Root Cause:** The codemode SDK's `generateTypes()` function converts tool names to valid JavaScript identifiers using `toValidIdentifier()`, which strips hyphens and underscores, then converts to camelCase. When the generated code calls a tool, the Proxy intercepts the property name and runs it through `toKebabCase()` before looking it up in the tool registry.

This creates a lossy round-trip: the original MCP tool name `tool_Rgo1O6n7_list-calendars` becomes `toolRgo1O6n7ListCalendars` in the TypeScript declaration, then gets converted to `tool-rgo1o6n7-list-calendars` at the Proxy — which doesn't match the original name in the MCP registry. The underscores and mixed casing are permanently lost.

```
Original:       tool_Rgo1O6n7_list-calendars    (MCP registry)
→ TypeScript:   toolRgo1O6n7ListCalendars       (toValidIdentifier)
→ Proxy call:   tool-rgo1o6n7-list-calendars    (toKebabCase)
→ Lookup:       ❌ not found in MCP registry
```

**Fix (3 changes in `packages/codemode/src/ai.ts`):**

1. **Quoted property names** in the generated TypeScript declaration — use `"${toolName}":` instead of `${toValidIdentifier(toolName)}:`. This preserves the exact original name including hyphens and underscores:
   ```typescript
   // Before: availableTools += `${toValidIdentifier(toolName)}: ...`
   // After:  availableTools += `"${toolName}": ...`
   ```
2. **Bracket notation instruction** added to the code-gen prompt — tells the LLM to use `codemode["tool_Rgo1O6n7_list-calendars"](...)` instead of `codemode.toolRgo1O6n7ListCalendars(...)`, since the quoted names aren't valid dot-notation identifiers.
3. **Direct function name pass-through** in the Proxy handler — return `prop` as-is instead of running it through `toKebabCase()`, so the name matches the MCP registry exactly.

**PR:** [cloudflare/agents#806](https://github.com/cloudflare/agents/pull/806)

### Issue 3: Vite Dependency Caching

**Problem:** After patching `@cloudflare/codemode` source files in `packages/codemode/src/ai.ts`, changes were not reflected at runtime — the old behavior persisted despite confirmed file modifications.

**Root Cause:** Vite pre-bundles dependencies during `vite dev` startup for faster development. It takes all packages from `node_modules` (and linked local packages), compiles them into optimized ES modules, and caches them at:

```
examples/codemode/node_modules/.vite/deps_codemode_demo/
```

Once cached, Vite serves the pre-bundled version and does **not** watch the original source files for changes. This means edits to `packages/codemode/src/ai.ts` have no effect until the cache is invalidated.

**Solution options:**

1. **Delete the cache directory** and restart Vite — it will re-bundle from the updated source:

   ```bash
   rm -rf examples/codemode/node_modules/.vite/deps_codemode_demo/
   npm run start   # Vite re-creates the cache from current source
   ```

2. **Patch the bundled file directly** — edit the compiled output inside the cache directory. The compiled file contains the same logic but as a single bundled ES module. This avoids restarting Vite but the patch is lost on next cache rebuild.

3. **Force Vite to re-optimize** by modifying `vite.config.ts`:
   ```typescript
   optimizeDeps: {
     force: true; // Re-bundles dependencies on every startup
   }
   ```

During development, option 1 was used most frequently. Option 2 was used for quick iteration on prompt changes.

### Issue 4: Code Generation Format

**Error:** `Uncaught SyntaxError: Unexpected token ')' at foo.js:25:6`

**Root Cause:** The template inserts LLM-generated code as `return await ${code}();`, expecting an anonymous async function. But the LLM generated wrong formats:

| LLM Generated                   | After Insertion                            | Result       |
| ------------------------------- | ------------------------------------------ | ------------ |
| `(async () => { ... })()`       | `return await (...)();`                    | Double call  |
| `async function main() { ... }` | `return await async function main()...();` | Syntax error |

**Fix:** Updated prompt in `packages/codemode/src/ai.ts` to be explicit:

```
Generate an anonymous async function expression. Do NOT call it, do NOT wrap it in IIFE, do NOT name it.

CORRECT format:
async function() { ... }

WRONG formats:
- (async () => { ... })()
- async function main() { ... }
- main()
```

### Issue 5: V8 Isolate Errors Not Triggering Retry

**Error:** Generated code fails in V8 isolate but no retry mechanism existed.

**Root Cause:** When the Codemode LLM generates code with incorrect parameter types or logic errors, the V8 isolate returns `{ err: "...", stack: "..." }` but the system would just return this error to the user without attempting to fix it.

**Fix:** Implemented retry mechanism with error feedback in `packages/codemode/src/ai.ts`:

```typescript
execute: async ({ functionDescription }) => {
  const MAX_RETRIES = 3;
  let lastError: string | null = null;
  let lastCode: string | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    let retryContext = "";
    if (lastError && lastCode) {
      retryContext = `
PREVIOUS ATTEMPT FAILED. You must fix the error.
Previous code: ${lastCode}
Error: ${lastError}
`;
    }

    const response = await generateObject({ ...(prompt + retryContext) });
    const result = await evaluator();

    if (result?.err) {
      if (attempt < MAX_RETRIES) {
        lastError = String(result.err);
        lastCode = response.object.code;
        console.log(`[RETRY] Attempt ${attempt} failed, will retry...`);
        continue;
      }
    }
    return { code, result };
  }
};
```

### Issue 6: MCP Tool Response Format Parsing

**Error:** `repoSearchResult.items` returns `undefined`

**Root Cause:** The [MCP protocol specification](https://modelcontextprotocol.io/) defines a standard response format for tool results. All MCP-compliant servers wrap their responses in a `content` array with typed entries:

```json
{
  "content": [{ "type": "text", "text": "{ \"items\": [...] }" }]
}
```

The actual data (e.g., a list of GitHub repos) is JSON-serialized inside `content[0].text` as a string. The code-gen LLM doesn't know this wrapping exists — it sees the TypeScript declaration for `search_repositories` and assumes the return value is the raw GitHub API response with `.items` directly accessible:

```javascript
// What the LLM generated (wrong):
const repos = await codemode["search_repositories"]({ q: "codemodetest" });
const repo = repos.items[0]; // ❌ undefined — 'items' is inside content[0].text

// What it should be:
const response = await codemode["search_repositories"]({ q: "codemodetest" });
const repos = JSON.parse(response.content[0].text);
const repo = repos.items[0]; // ✅ works
```

This issue doesn't affect traditional tool calling because the Vercel AI SDK handles MCP response unwrapping automatically before passing results to the LLM. In Codemode, the generated code receives the raw MCP response directly.

**Fix:** Added explicit instruction in the Codemode LLM prompt in `packages/codemode/src/ai.ts`:

```
MCP TOOL RESPONSE FORMAT: All MCP tool responses are wrapped as
{ content: [{ type: "text", text: "JSON string" }] }.
You MUST parse the response like this:

const response = await codemode["tool_name"](params);
const data = JSON.parse(response.content[0].text);
```

An alternative fix would be to add an unwrapping layer in the Proxy handler so that generated code receives the parsed data directly, but prompt-based instruction was simpler to implement and test.

### Issue 7: Dependency-Aware Tool Ordering

**Error:** GitHub tools fail with `422 Unprocessable Entity` — "owner" parameter missing, incorrect, or hardcoded as a placeholder like `"user"`.

**Root Cause:** The code-gen LLM generates code that calls GitHub tools like `create_repo` or `create_issue`, which require an `owner` parameter. But the LLM has no way to know the authenticated user's GitHub username — it's not in the TypeScript declarations, not in the prompt, and not available as an environment variable.

Without guidance, the LLM either:

- Hardcodes a placeholder: `owner: "user"` or `owner: "username"` → API 404
- Omits it entirely → API 422
- Guesses from context → usually wrong

Similarly, Google Calendar tools require a `calendarId` parameter, but the LLM doesn't know which calendars exist for the authenticated user.

The fundamental issue is that **some tool parameters can only be discovered by calling other tools first**. The LLM needs to understand these implicit dependencies.

**Fix:** Added dependency chain instructions to the Codemode LLM prompt in `packages/codemode/src/ai.ts`:

```
DEPENDENCY-AWARE TOOL ORDERING: Before calling a tool that requires
specific input parameters (like "owner", "repo", "calendarId"),
first call tools that can provide those values:

- For GitHub tools: Use search_repositories and extract "owner.login"
  from the result. Never hardcode usernames.
- For Calendar tools: First call list-calendars and use the primary
  calendar's ID. Never assume "primary" as calendarId.
- For issue/PR tools: First search for the repo to confirm it exists
  and get the exact owner/repo name.
```

This is a prompt-engineering workaround. A more robust solution would be to inject the authenticated user's context (e.g., username, default calendar) into the TypeScript declarations or prompt automatically, but this would require MCP server-level changes to expose identity information.

### Issue 8: Parameter Pollution in Traditional Tool Calling

**Error:** GitHub API rejects tool calls with `422 Unprocessable Entity`

**Root Cause:** Traditional AI SDK tool calling includes schema default values:

```json
{
  "owner": "user",
  "repo": "myrepo",
  "title": "New Issue",
  "milestone": 0,
  "assignees": [],
  "labels": []
}
```

GitHub rejects `milestone: 0` as invalid. Codemode avoids this because generated code only includes explicitly needed parameters.

**Fix:** Implemented input sanitization in `examples/simple-llm/src/server.ts`:

```typescript
function sanitizeToolInput(
  input: Record<string, unknown>
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === 0 && key === "milestone") continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (value === null || value === undefined) continue;
    sanitized[key] = value;
  }
  return sanitized;
}
```

**Issue:** [cloudflare/agents#851](https://github.com/cloudflare/agents/issues/851)

### Issue 9: `result.usage` vs `result.totalUsage` — Inaccurate Token Reporting

**Error:** Simple-LLM token usage underreported by up to 8.4x, making Codemode appear only marginally better.

**Root Cause:** Both `server.ts` files used Vercel AI SDK's `result.usage`, which returns token usage of the **last step only** in multi-step tool calling. Per the [Vercel AI SDK docs](https://ai-sdk.dev/docs/reference/ai-sdk-core/stream-text), `result.totalUsage` returns the sum across all steps.

When `streamText()` runs with `stopWhen: stepCountIs(10)`, it makes multiple internal LLM API calls (one per tool-calling step). Each step re-sends the entire conversation context. `result.usage` only captures the final step.

```typescript
// Before
const usage = await result.usage; // last step only

// After
const usage = await result.totalUsage; // all steps summed
```

**Impact:**

| System                   | `result.usage` (wrong) | `result.totalUsage` (correct) | Undercount |
| ------------------------ | ---------------------- | ----------------------------- | ---------- |
| **Simple-LLM** Request 1 | 15,677                 | **131,322**                   | **8.4x**   |
| **Simple-LLM** Request 2 | 15,356                 | **42,432**                    | **2.8x**   |
| **Codemode** Request 1   | 30,542                 | **32,104**                    | 1.05x      |
| **Codemode** Request 2   | ~22,840                | **33,770**                    | 1.5x       |

Simple-LLM was undercounted by 8.4x because it makes ~8 internal LLM steps per request. Codemode was less affected (1-2 main LLM steps) but Request 2 showed a 1.5x undercount due to the Main LLM carrying session history across steps.

**Note on billing:** These are billed tokens — each step is a separate OpenAI API call. OpenAI may apply prompt caching (reduced rate for repeated prefixes), so the cost may be lower than the raw count, but the token count is accurate.

---

## Configuration

### Models

| Component    | Model           | Purpose             |
| ------------ | --------------- | ------------------- |
| Main LLM     | `gpt-5-mini`    | Orchestration       |
| Codemode LLM | `gpt-5.2-codex` | Code generation     |
| Simple-LLM   | `gpt-5-mini`    | Direct tool calling |

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

## Test Results

> All token counts use `result.totalUsage` (billed tokens across all LLM steps). See [Issue 9](#issue-9-resultusage-vs-resulttotalusage--inaccurate-token-reporting) for why this matters.

### Test Query

> "Search for top AI conferences this month, select one and schedule my calendar event with no overlaps. Check for 'codemodetest' repo — if not present, create a GitHub repo named 'codemodetest' and add a README file stating 'this is codemode test' and create an issue stating 'testing code mode' and add a comment on the same issue stating 'rounak is looking into it'."

**MCP Servers:** Serper (Google Search + Scrape), Google Calendar, GitHub

### Codemode Results

**Request 1 — Multi-tool task (best case, 1 codemode call):**

| Metric              | Value                          |
| ------------------- | ------------------------------ |
| Codemode LLM Calls  | 1                              |
| Main LLM Tokens     | 9,391 in / 2,163 out = 11,554  |
| Codemode LLM Tokens | 12,475 in / 8,075 out = 20,550 |
| **Total Tokens**    | **32,104**                     |
| Duration            | 170s                           |
| Retry Attempts      | 0                              |

**Request 2 — Follow-up (delete event + add comment):**

| Metric              | Value                          |
| ------------------- | ------------------------------ |
| Codemode LLM Calls  | 1                              |
| Main LLM Tokens     | 17,663 in / 1,135 out = 18,798 |
| Codemode LLM Tokens | 14,972                         |
| **Total Tokens**    | **33,770**                     |
| Duration            | 56s                            |

**Session total: 65,874 tokens**

**Optimization progress (Request 1 only):**

| Metric             | Initial (over-decomposed) | Batched (2 calls) | Optimized (1 call) |
| ------------------ | ------------------------- | ----------------- | ------------------ |
| Codemode LLM Calls | 7                         | 2                 | **1**              |
| Total Tokens       | ~109,392                  | ~43,318           | **~32,104**        |
| Retry Attempts     | 3                         | 1                 | **0**              |

### Simple-LLM Results

**Request 1 — Multi-tool task:**

| Metric           | Value                                  |
| ---------------- | -------------------------------------- |
| Input Tokens     | 127,112                                |
| Output Tokens    | 4,210                                  |
| **Total Tokens** | **131,322**                            |
| Duration         | 68s                                    |
| Tool Calls       | ~10 (mostly sequential, some parallel) |

**Request 2 — Follow-up (delete event + add comment):**

| Metric           | Value        |
| ---------------- | ------------ |
| Input Tokens     | 41,977       |
| Output Tokens    | 455          |
| **Total Tokens** | **42,432**   |
| Duration         | 13s          |
| Tool Calls       | 2 (parallel) |

**Session total: 173,754 tokens**

**Observations from Simple-LLM logs:**

- Called `get-current-time` twice with different account parameters (redundant)
- Sent `milestone: 0`, `labels: []`, `assignees: []` on `create_issue` (parameter pollution, required sanitization)
- First run (before `totalUsage` fix) missed the `add_issue_comment` step despite being explicitly asked

---

## Comparative Analysis: Codemode vs Simple-LLM

### Head-to-Head Token Comparison

|                            | Codemode   | Simple-LLM  | Ratio                        |
| -------------------------- | ---------- | ----------- | ---------------------------- |
| **Request 1** (multi-tool) | 32,104     | 131,322     | Codemode uses **4.1x fewer** |
| **Request 2** (follow-up)  | 33,770     | 42,432      | Codemode uses **1.3x fewer** |
| **Session total**          | **65,874** | **173,754** | Codemode uses **2.6x fewer** |

### Why the Token Difference

The core difference is **how many times the LLM re-reads the context**.

**Simple-LLM** makes ~8 tool calls (mostly sequential, with occasional parallel batching when the LLM decides calls are independent). Each LLM step re-sends the entire conversation:

```
Step 1: [system + user + tools]              → google_search      ~8,300 in
Step 2: [... + result_1]                     → get-current-time   ~10,500 in
Step 3: [... + result_2]                     → get-freebusy       ~11,000 in
Step 4: [... + result_3]                     → create-event       ~12,500 in
Step 5: [... + result_4]                     → search_repos       ~14,000 in
Step 6: [... + result_5]                     → create_repo        ~15,000 in
Step 7: [... + result_6]                     → create_file        ~15,500 in
Step 8: [... + result_7]                     → final text         ~15,549 in
                                                         SUM:   ~127,112 in
```

**Codemode** generates code once, then the V8 isolate executes all tool calls with zero LLM involvement:

```
Main LLM:    [system + user]           → call codemode tool    ~9,391 in
Code LLM:    [types + task]            → generate TypeScript   ~12,475 in  (one shot)
V8 Isolate:  execute code              → 15 tool calls          0 LLM tokens
Main LLM:    [... + codemode result]   → final text            (included in totalUsage)
                                                        SUM:   ~21,866 in
```

### Context Isolation: Two Levels

**Intra-request** (within a single user message):

- Simple-LLM: O(n) — context grows with each tool-calling step
- Codemode: O(1) — code-gen LLM called once, tools execute in isolate

**Inter-request** (across conversation turns):

- Simple-LLM: O(n) — full conversation history carried forward
- Codemode: Mixed — Main LLM carries history (O(n)), but code-gen LLM starts fresh (O(1))

```
Request 2 example:
  Simple-LLM:  41,977 input tokens (carrying full Request 1 history)
  Codemode:    17,663 main (session history) + 14,972 codegen (fresh) = 33,770
```

### Behavioral Differences

| Behavior                | Codemode                                     | Simple-LLM                                                                |
| ----------------------- | -------------------------------------------- | ------------------------------------------------------------------------- |
| **Execution style**     | Autonomous — completes all tasks in one flow | May ask clarifying questions first                                        |
| **Tool execution**      | Parallel via `Promise.all()`                 | Mostly sequential; occasional parallel when LLM batches independent calls |
| **Parameter precision** | Only explicit params in generated code       | May include schema defaults (pollution)                                   |
| **Task completion**     | Code follows full script — cannot skip steps | Dropped `add_issue_comment` in Request 1 despite explicit ask             |
| **Error handling**      | Retry mechanism with error feedback          | Explains error, offers workarounds                                        |

### Task Completion Reliability

In Simple-LLM's Request 1 run, the LLM completed `create_issue` and then produced a final text response — **skipping the explicitly requested `add_issue_comment` step**. The LLM decided the task was "done" after creating the issue, even though the user's query clearly included "add a comment on the same issue stating 'rounak is looking into it'."

Codemode cannot exhibit this failure mode. The generated code is a complete program with all steps written out sequentially:

```javascript
// Codemode's generated code includes ALL steps — can't skip any
const issue = await codemode["create_issue"]({ owner, repo, title, body });
const comment = await codemode["add_issue_comment"]({
  owner,
  repo,
  issue_number: issue.number,
  body: "rounak is looking into it"
});
```

Once the code is generated, the V8 isolate executes every line. There is no LLM decision point between steps where it could decide to stop early. This is a structural advantage — reliability comes from the execution model, not from prompt engineering.

### Performance Summary

| Metric                       | Codemode (best case)             | Simple-LLM                | Winner     |
| ---------------------------- | -------------------------------- | ------------------------- | ---------- |
| **Total Tokens (session)**   | 65,874                           | 173,754                   | Codemode   |
| **Token ratio**              | 1x                               | 2.6x                      | Codemode   |
| **Intra-request scaling**    | O(1)                             | O(n)                      | Codemode   |
| **User interactions needed** | 1                                | 1-4                       | Codemode   |
| **Parameter precision**      | No pollution                     | Needs sanitization        | Codemode   |
| **Task completion**          | All steps executed               | Dropped a step in testing | Codemode   |
| **Duration (Request 1)**     | 170s                             | 68s                       | Simple-LLM |
| **Duration (Request 2)**     | 56s                              | 13s                       | Simple-LLM |
| **Follow-up efficiency**     | Main LLM bridges partial context | Full context from history | Simple-LLM |
| **Token predictability**     | Variable (32K-151K)              | Consistent                | Simple-LLM |

---

## Limitations & Caveats

### 1. Retry Cost Amplification

When code generation fails, each retry is significantly more expensive than Simple-LLM's tool-call retries.

**Observed in testing (run with 4 codemode calls due to date formatting errors):**

| Scenario                      | Codemode Tokens | Simple-LLM Tokens |
| ----------------------------- | --------------- | ----------------- |
| Best case (1 codemode call)   | 32,104          | 131,322           |
| Worst case (4 codemode calls) | **150,775**     | 131,322           |

Each failed attempt adds the full generated TypeScript program (~5-9K tokens) + execution results back into the main LLM's context. Main LLM tokens ballooned from 11,554 (1 call) to 75,615 (4 calls) — a 6.5x increase.

Simple-LLM retries are cheaper: a failed tool call produces a small JSON error (~100-200 tokens), not a 140-line program.

### 2. Duration Trade-off

Codemode is slower per-request despite using fewer tokens:

|           | Codemode | Simple-LLM |
| --------- | -------- | ---------- |
| Request 1 | 170s     | 68s        |
| Request 2 | 56s      | 13s        |

Codemode requires: Main LLM decision → Code-gen LLM call → V8 isolate startup → tool execution → result aggregation. Two separate LLM API calls (different models) per codemode invocation. Simple-LLM streams tool calls from a single LLM with no V8 overhead.

### 3. Non-Deterministic Token Usage

The same prompt produces different results across runs:

| Run        | Codemode LLM Calls | Total Tokens |
| ---------- | ------------------ | ------------ |
| Best case  | 1                  | 32,104       |
| Worst case | 4                  | 150,775      |

Simple-LLM's token usage is more predictable — each tool call costs roughly the same.

### 4. Context Bridging Overhead

The Main LLM carries session history and can bridge context to the code-gen LLM via the task description. In testing, Request 2's task description included the event summary, issue number, and repo name extracted from Request 1's results:

```
Task: ... List events and search for events with summary containing
'Attend 2026 AI/ML Conference - BuiltWorlds'. ... Add a comment to
issue number 1 in the repository rounakbende10/codemodetest ...
```

However, the Main LLM bridged **partial** context — it passed the event summary and issue number but not the exact `eventId`, so the code-gen LLM still had to list calendars and search for events before deleting. Simple-LLM had the `eventId` directly in its conversation history and needed only 2 tool calls vs Codemode's additional discovery calls.

This is a **quality-of-bridging** problem, not a fundamental architectural limitation. The Main LLM _can_ pass exact IDs, but whether it does depends on how well it summarizes previous results in the task description.

### 5. SDK Maturity

Codemode SDK is `v0.0.5` (experimental). During testing, 8 significant issues were encountered and fixed locally (see [Issues & Fixes](#issues--fixes)). Production use requires substantial prompt engineering and workarounds not documented in the blog.

---

## Conclusion

**Codemode uses 2.6x fewer billed tokens per session** compared to traditional tool calling, validating the Cloudflare blog's core claim about reduced token waste. The advantage comes from eliminating intermediate LLM round-trips — tool results are processed in a V8 isolate instead of being fed back to the LLM after every call.

However, this advantage is **conditional**:

- It requires **first-attempt code generation success**. With retries, Codemode can exceed Simple-LLM's token usage (150K vs 131K).
- It comes with a **latency penalty** — Codemode is 2-4x slower per-request due to dual-LLM architecture and V8 overhead.
- It trades **context memory for token efficiency** — follow-up tasks may be less efficient because the code-gen LLM starts fresh each time.

**Codemode is better when:**

- Tasks involve 3+ chained tool calls that can be parallelized
- First-attempt code generation success rate is high
- Long-running sessions where context accumulation matters
- APIs are sensitive to parameter pollution
- Autonomous execution is preferred over interactive clarification

**Simple-LLM is better when:**

- Tasks involve 1-2 tool calls (code-gen overhead not amortized)
- Latency matters more than token cost
- Follow-up tasks reference previous results
- Predictable token costs are important

---

## Features Added

The following features were built on top of the original Cloudflare agents SDK (`@cloudflare/codemode@0.0.5`), which had no built-in metrics, comparison tooling, or retry logic.

### 1. Token Tracking & Metrics System

Custom `TokenUsage` and `RequestMetrics` types with per-request and cumulative session tracking. Captures Main LLM and Codemode LLM token usage independently, with formatted console logging for analysis.

- Per-request: input/output/total tokens, duration
- Cumulative: session-wide token and duration aggregation across requests
- Codemode-specific: `codemodeUsage` extraction from tool outputs, `codemodeCallCount`, `retryCount`
- Fixed `result.usage` → `result.totalUsage` for accurate multi-step billing (see [Issue 9](#issue-9-resultusage-vs-resulttotalusage--inaccurate-token-reporting))

### 2. Simple-LLM Comparison Example

Built the entire `examples/simple-llm/` from scratch as a traditional tool-calling baseline for comparison against Codemode. Uses the same MCP servers, same query, same metrics format — enabling direct head-to-head analysis.

### 3. Retry Mechanism with Error Feedback

Added retry logic to `packages/codemode/src/ai.ts` — up to 3 attempts with failed code and error messages passed back to the LLM for correction. Includes cumulative token tracking across retries. The original SDK had no retry mechanism; V8 isolate errors were returned directly to the user.

### 4. Input Sanitization for Simple-LLM

Implemented `sanitizeToolInput()` in `examples/simple-llm/src/server.ts` to strip schema default values (`milestone: 0`, empty arrays, nulls) before MCP tool calls, working around parameter pollution in traditional tool calling.

### 5. Enhanced Codemode Prompts

Added prompt instructions for:

- MCP response format parsing (`content[0].text` JSON unwrapping)
- Dependency-aware tool ordering (search before create)
- Resource reuse (don't fail if resource exists)
- Correct code generation format (anonymous async function)

---

## Contribution

### PR #806: Fix MCP Tool Name Handling

**Repository:** [cloudflare/agents](https://github.com/cloudflare/agents)
**Status:** Closed (not merged) — API being reworked by maintainers

**Changes proposed:**

- Quoted property names in TypeScript declarations
- Bracket notation instruction in prompt
- Direct function name pass-through

Fixes are applied locally in this fork for testing.

### Issue #851: Parameter Pollution in Tool Calling

**Repository:** [cloudflare/agents](https://github.com/cloudflare/agents)
**Status:** Open
**URL:** [cloudflare/agents#851](https://github.com/cloudflare/agents/issues/851)

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
- [Vercel AI SDK — streamText Reference](https://ai-sdk.dev/docs/reference/ai-sdk-core/stream-text)
