# Cloudflare Codemode - Findings & Research

**Location**: `/examples/codemode/`
**Status**: Working (with fixes applied)
**Last Updated**: February 5, 2026

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
10. [Contribution](#contribution)

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
│  (GPT-5-mini)   │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Codemode LLM   │  Token Usage #2 - generates JavaScript
│(GPT-5.2-codex)│
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

**PR:** [cloudflare/agents#806](https://github.com/cloudflare/agents/pull/806)

### Issue 3: Vite Dependency Caching

**Problem:** Patches to source not reflected at runtime.

**Solution:** Patch Vite bundle directly:

```
examples/codemode/node_modules/.vite/deps_codemode_demo/
```

### Issue 4: Code Generation Format

**Error:** `Uncaught SyntaxError: Unexpected token ')' at foo.js:25:6`

**Root Cause:** The template inserts LLM-generated code as `return await ${code}();`, expecting an anonymous async function. But the LLM generated wrong formats:

| LLM Generated                   | After Insertion                            | Result          |
| ------------------------------- | ------------------------------------------ | --------------- |
| `(async () => { ... })()`       | `return await (...)();`                    | ❌ Double call  |
| `async function main() { ... }` | `return await async function main()...();` | ❌ Syntax error |

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
    // Build prompt with error context if retrying
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

    // Check if result contains V8 isolate error
    if (result?.err) {
      if (attempt < MAX_RETRIES) {
        lastError = String(result.err);
        lastCode = response.object.code;
        console.log(`⟳ [RETRY] Attempt ${attempt} failed, will retry...`);
        continue;
      }
    }
    return { code, result };
  }
};
```

**Features:**

- Max 3 retry attempts
- Passes failed code and error message back to LLM
- Cumulative token tracking across retries
- Logs show `(Retry 2/3)`, `(Attempt 3)` for debugging

### Issue 6: MCP Tool Response Format Parsing

**Error:** `repoSearchResult.items` returns `undefined`

**Root Cause:** MCP tools return responses wrapped in a specific format:

```json
{
  "content": [
    {
      "type": "text",
      "text": "{ \"items\": [...] }" // JSON string, not object!
    }
  ]
}
```

The LLM was trying to access `.items` directly instead of parsing from `content[0].text`.

**Fix:** Added explicit instruction in the Codemode LLM prompt:

```
5. MCP TOOL RESPONSE FORMAT: All MCP tool responses are wrapped as
   { content: [{ type: "text", text: "JSON string" }] }.
   You MUST parse the response like this:

   const response = await codemode["tool_name"](params);
   const data = JSON.parse(response.content[0].text);
   // Now access data.items, data.owner, etc.
```

### Issue 7: Dependency-Aware Tool Ordering

**Error:** GitHub tools fail with "owner" parameter missing or incorrect

**Root Cause:** LLM generates code that uses GitHub tools (create_repository, create_issue) but doesn't know the authenticated user's username to use as "owner".

**Fix:** Added prompt instructions for dependency-aware tool ordering:

```
2. DEPENDENCY-AWARE TOOL ORDERING: Before calling a tool that requires
   specific input parameters (like "owner", "repo", "calendarId"),
   first call tools that can provide those values:

   - For GitHub tools: Use search_repositories with the repo name
     and extract "owner.login" from the results
   - For Calendar tools: First call list-calendars and use the
     "primary" calendar or first one with accessRole "owner"

4. REUSE EXISTING RESOURCES: If a resource already exists (repo, file,
   issue), USE IT - don't throw errors. Extract the needed info from
   search/list results and continue.
```

**Result:** The LLM now generates code that:

1. Searches for the repo first
2. Parses the JSON response correctly
3. Extracts `owner.login` from results
4. Uses that owner in subsequent tool calls

### Issue 8: Parameter Pollution in Traditional Tool Calling

**Error:** GitHub API rejects tool calls with `422 Unprocessable Entity`

**Root Cause:** Traditional AI SDK tool calling includes schema default values in the request, even when not needed:

```json
{
  "owner": "user",
  "repo": "myrepo",
  "title": "New Issue",
  "milestone": 0, // ← Invalid: GitHub rejects milestone: 0
  "assignees": [], // ← Unnecessary empty array
  "labels": [] // ← Unnecessary empty array
}
```

GitHub's API rejects `milestone: 0` as invalid (must be a valid milestone ID or omitted).

**Why Codemode Avoids This:**

Code generation gives the LLM precise parameter control:

| Approach       | Parameter Behavior                     | Example                     |
| -------------- | -------------------------------------- | --------------------------- |
| **Codemode**   | Only explicit params in generated code | `{ owner, repo, title }` ✅ |
| **Simple-LLM** | Schema defaults may be included        | `{ ..., milestone: 0 }` ❌  |

**Fix:** Implemented input sanitization in `examples/simple-llm/src/server.ts` to remove invalid default values before passing to MCP tools:

```typescript
function sanitizeToolInput(
  input: Record<string, unknown>
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    // Skip invalid defaults
    if (value === 0 && key === "milestone") continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (value === null || value === undefined) continue;
    sanitized[key] = value;
  }
  return sanitized;
}
```

This removes `milestone: 0`, empty arrays, and null/undefined values before API calls.

**Issue:** [cloudflare/agents#851](https://github.com/cloudflare/agents/issues/851)

---

## Configuration

### Models

| Component  | Model           | Location                                   |
| ---------- | --------------- | ------------------------------------------ |
| Codemode   | `gpt-5.2-codex` | Vite bundle in `.vite/deps_codemode_demo/` |
| simple-llm | `gpt-5-mini`    | `examples/simple-llm/src/server.ts`        |

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

### Multi-Tool Query: Web Search + Calendar + GitHub (3 MCP Servers)

**Query:** "search for top AI conferences this month select one and schedule my calendar event with no overlaps. check for "codemodetest" repo if not present Create a git repo named "codemodetest" and add a Readme file stating "this is codemode test" and create an issue stating "testing code mode" and add a comment on the same issue stating "rounak is looking into it"

**MCP Servers Used:**

- Serper (Google Search + Scrape)
- Google Calendar
- GitHub

**Execution Flow (Single Codemode Call):**

```
┌─────────────────────────────────────────────────────────────────────────┐
│ MAIN LLM (GPT-5-mini) - Orchestrates single comprehensive codemode call │
└─────────────────────────────────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ Codemode Call #1 - All operations in single code generation             │
│                                                                          │
│ Web Search + Scrape:          Calendar Operations:                       │
│ • google_search               • get-current-time                         │
│ • scrape (multiple pages)     • list-calendars                           │
│                               • get-freebusy                             │
│ GitHub Operations:            • create-event                             │
│ • search_repositories                                                    │
│ • create_repository                                                      │
│ • create_or_update_file                                                  │
│ • create_issue                                                           │
│ • add_issue_comment                                                      │
└─────────────────────────────────────────────────────────────────────────┘
```

**Metrics (Latest Run - Feb 5, 2026):**

| Metric                 | Value                          |
| ---------------------- | ------------------------------ |
| MCP Servers            | 3 (Serper, Calendar, GitHub)   |
| **Codemode LLM Calls** | **1**                          |
| Main LLM Tokens        | 8,116 in / 1,540 out = 9,656   |
| Codemode Tokens        | 12,442 in / 8,444 out = 20,886 |
| **Total Tokens**       | **30,542**                     |
| **Duration**           | **175 seconds (~2.9 min)**     |
| Retry Attempts         | 0                              |

**Optimization Progress:**

| Metric             | Initial (Over-decomposed) | Batched (2 calls) | Optimized (1 call) |
| ------------------ | ------------------------- | ----------------- | ------------------ |
| Codemode LLM Calls | 7                         | 2                 | **1**              |
| Total Tokens       | ~109,392                  | ~43,318           | **~30,542**        |
| Retry Attempts     | 3                         | 1                 | **0**              |
| Duration           | ~3 min                    | ~3 min            | **~2.9 min**       |

**Outcome:** All tasks completed successfully:

- ✅ Searched for AI conferences (found AI2 Summit, AI Dev World, etc.)
- ✅ Scheduled conferences on Google Calendar
- ✅ Created codemodetest repository
- ✅ Added README with correct content
- ✅ Created issue "testing code mode"
- ✅ Added comment "rounak is looking into it"

---

### Simple-LLM: Same Multi-Tool Query (Comparison)

**Query:** Same as Codemode test above

**Log File:** `/tmp/simple-llm.log`

**Execution Summary:**

| Request | Input Tokens | Total Tokens | Cumulative | Outcome                                |
| ------- | ------------ | ------------ | ---------- | -------------------------------------- |
| #1      | 8,263        | 9,499        | 9,499      | Search ✅, GitHub repo ✅              |
| #2      | 10,127       | 10,343       | 19,842     | Calendar ✅ (after user clarification) |
| #3      | 16,069       | 16,215       | 36,057     | Issue created ✅                       |
| #4      | 16,857       | 17,933       | 53,990     | Comment added ✅, All tasks complete   |

**Context Growth:** Input tokens grow each request (8K → 10K → 16K → 17K) as conversation history accumulates.

**Key Differences from Codemode:**

1. **Interactive Approach**: Requested clarification for calendar ("Which calendar? What format?") instead of autonomous execution

2. **Sequential Tool Calls**: Each tool call requires LLM reasoning between calls

3. **More Requests Required**: 4 requests vs 1 for Codemode to complete same tasks

**Outcome:** All tasks completed successfully, but required 4 user interactions and 77% more tokens than Codemode.

---

## Comparative Analysis: Codemode vs Simple-LLM

### Behavioral Differences

| Behavior            | Codemode                                     | Simple-LLM                                 |
| ------------------- | -------------------------------------------- | ------------------------------------------ |
| **Execution style** | Autonomous - completes all tasks in one flow | Interactive - asks clarifying questions    |
| **Tool execution**  | Parallel via `Promise.all()`                 | Sequential with LLM reasoning between each |
| **Error handling**  | Retry mechanism with error feedback          | Explains error, offers workarounds         |
| **Task batching**   | Groups related ops into fewer LLM calls      | Single context handles everything          |

### Token Comparison

| System         | Requests            | Total Tokens | Duration | Notes                               |
| -------------- | ------------------- | ------------ | -------- | ----------------------------------- |
| **Codemode**   | 1 Main + 1 Codemode | ~30,542      | ~2.9 min | Single call, all ops batched        |
| **Simple-LLM** | 4                   | ~53,990      | ~4 min   | Context grows: 8K → 10K → 16K → 17K |

**Codemode:** 2 batched calls handle all operations. Each Codemode call starts fresh (~18K tokens).

**Simple-LLM:** Context accumulates. Input tokens grow each request (8K → 10K → 16K) as conversation history is carried forward.

### Context Isolation: The Key Architectural Difference

```
Simple-LLM (Accumulating Context):
┌────────────────────────────────────────────────────────────────┐
│ Request 1:  ~16K tokens  ───┐                                   │
│ Request 2:  ~32K tokens  ───┼──► Context grows each turn        │
│ Request 3:  ~50K tokens  ───┘    (carries full history)         │
│                                                                 │
│ Token Growth: O(n) - linear with conversation length            │
└────────────────────────────────────────────────────────────────┘

Codemode (Independent Context):
┌────────────────────────────────────────────────────────────────┐
│ Main LLM:     ~2.5K tokens  (orchestration only)                │
│ Codemode #1: ~12K tokens  ───┐                                  │
│ Codemode #2: ~12K tokens  ───┼──► Each starts fresh             │
│ Codemode #N: ~12K tokens  ───┘    (no history accumulation)     │
│                                                                 │
│ Token Growth: O(1) - constant per Codemode call                 │
└────────────────────────────────────────────────────────────────┘
```

**Why This Matters:**

| Aspect                  | Simple-LLM              | Codemode              |
| ----------------------- | ----------------------- | --------------------- |
| **Context per request** | Grows with conversation | Fixed ~12K per call   |
| **10 interactions**     | ~880K tokens (sum)      | ~126K tokens          |
| **History carried**     | Full conversation       | Only Main LLM sees it |
| **Scalability**         | Degrades over time      | Constant performance  |

### Performance Summary

| Metric                | Codemode | Simple-LLM | Winner   |
| --------------------- | -------- | ---------- | -------- |
| **All Tasks Done**    | ✅ Yes   | ✅ Yes     | Tie      |
| **User Interactions** | 1        | 4          | Codemode |
| **Context Growth**    | O(1)     | O(n)       | Codemode |
| **Total Tokens**      | ~30,542  | ~53,990    | Codemode |
| **Duration**          | ~2.9 min | ~4 min     | Codemode |

\*Both systems completed all tasks, but Codemode used 43% fewer tokens and completed 28% faster with a single user interaction vs 4 for Simple-LLM.

**Conclusion:** Codemode completed all tasks autonomously with constant-time scalability. With single-call optimization, Codemode uses fewer tokens (30K vs 54K) and completes faster (2.9 min vs 4 min) than traditional tool calling.

### Tool Parameter Handling

A key architectural advantage of Codemode is precise parameter control:

| Approach       | Parameter Behavior                     | Example                     |
| -------------- | -------------------------------------- | --------------------------- |
| **Codemode**   | Only explicit params in generated code | `{ owner, repo, title }` ✅ |
| **Simple-LLM** | Schema defaults may be included        | `{ ..., milestone: 0 }` ❌  |

**Why this matters:** Code generation lets the LLM include only the parameters it needs. Traditional tool calling may include schema defaults (like `milestone: 0`) that cause API validation errors.

---

## Contribution

### PR #806: Fix MCP Tool Name Handling

**Repository:** [cloudflare/agents](https://github.com/cloudflare/agents)
**Status:** Closed (not merged) - API being reworked by maintainers

**Changes proposed:**

- Quoted property names in TypeScript declarations
- Bracket notation instruction in prompt
- Direct function name pass-through

The fixes are applied locally in this fork for testing purposes.

### Issue #851: Parameter Pollution in Tool Calling

**Repository:** [cloudflare/agents](https://github.com/cloudflare/agents)
**Status:** Open
**URL:** [cloudflare/agents#851](https://github.com/cloudflare/agents/issues/851)

**Problem reported:**

- Tool calling includes schema default values (e.g., `milestone: 0`, empty arrays)
- GitHub API rejects `milestone: 0` with 422 Unprocessable Entity
- Workaround: Input sanitization before MCP tool calls

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
