import { generateObject, tool, type ToolSet } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import { compile as compileJsonSchemaToTs } from "json-schema-to-typescript";
import {
  zodToTs,
  printNode as printNodeZodToTs,
  createTypeAlias
} from "zod-to-ts";
import { getAgentByName } from "agents";
import { env, WorkerEntrypoint } from "cloudflare:workers";

function toCamelCase(str: string) {
  return str
    .replace(/[-_]([a-z])/g, (_, letter) => letter.toUpperCase())
    .replace(/^[a-z]/, (letter) => letter.toUpperCase());
}

function toValidIdentifier(str: string) {
  return str
    .replace(/[-_]([a-z])/g, (_, letter) => letter.toUpperCase())
    .replace(/^[A-Z]/, (letter) => letter.toLowerCase());
}

export class CodeModeProxy extends WorkerEntrypoint<
  Cloudflare.Env,
  {
    binding: string;
    name: string;
    callback: string;
  }
> {
  async callFunction(options: { functionName: string; args: unknown[] }) {
    console.log("\n┌─────────────────────────────────────────────────────────");
    console.log("│ [TOOL CALL]", options.functionName);
    console.log("├─────────────────────────────────────────────────────────");
    console.log("│ Input:", JSON.stringify(options.args, null, 2));
    console.log("└─────────────────────────────────────────────────────────");

    const stub = (await getAgentByName(
      // @ts-expect-error
      env[this.ctx.props.binding] as DurableObjectNamespace<T>,
      this.ctx.props.name
    )) as DurableObjectStub;
    // @ts-expect-error
    const result = await stub[this.ctx.props.callback](
      options.functionName,
      options.args
    );

    console.log("\n┌─────────────────────────────────────────────────────────");
    console.log("│ [TOOL RESULT]", options.functionName);
    console.log("├─────────────────────────────────────────────────────────");
    console.log("│ Output:", JSON.stringify(result, null, 2));
    console.log("└─────────────────────────────────────────────────────────");

    return result;
  }
}

export async function experimental_codemode(options: {
  tools: ToolSet;
  prompt: string;
  globalOutbound: Fetcher;
  loader: WorkerLoader;
  proxy: Fetcher<CodeModeProxy>;
}): Promise<{
  prompt: string;
  tools: ToolSet;
}> {
  const generatedTypes = await generateTypes(options.tools);
  const prompt = `${options.prompt}
  You are a helpful assistant. You have access to the "codemode" tool that can do different things:

  ${getToolDescriptions(options.tools)}

  If the user asks to do anything that be achieveable by the codemode tool, then simply pass over control to it by giving it a simple function description. Don't be too verbose.

  `;

  const codemodeTool = tool({
    description: "codemode: a tool that can generate code to achieve a goal",
    inputSchema: z.object({
      functionDescription: z.string()
    }),
    outputSchema: z.object({
      code: z.string(),
      result: z.any(),
      codemodeUsage: z
        .object({
          inputTokens: z.number(),
          outputTokens: z.number(),
          totalTokens: z.number()
        })
        .optional()
    }),
    execute: async ({ functionDescription }) => {
      const MAX_RETRIES = 3;
      let lastError: string | null = null;
      let lastCode: string | null = null;
      let cumulativeUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          console.log(
            "\n╔═════════════════════════════════════════════════════════"
          );
          console.log(
            "║ [CODEMODE LLM] GPT-5.1-codex-mini" +
              (attempt > 1 ? ` (Retry ${attempt}/${MAX_RETRIES})` : "")
          );
          console.log(
            "╠═════════════════════════════════════════════════════════"
          );
          console.log("║ Task:", functionDescription);
          console.log(
            "║ Available Tools:",
            Object.keys(options.tools).join(", ")
          );
          if (lastError) {
            console.log(
              "║ Previous Error:",
              lastError.substring(0, 200) +
                (lastError.length > 200 ? "..." : "")
            );
          }
          console.log(
            "╚═════════════════════════════════════════════════════════"
          );

          // Build prompt with error context if retrying
          let retryContext = "";
          if (lastError && lastCode) {
            retryContext = `

PREVIOUS ATTEMPT FAILED. You must fix the error.

Previous code that failed:
\`\`\`javascript
${lastCode}
\`\`\`

Error message:
${lastError}

Analyze the error and generate corrected code. Pay close attention to:
- Parameter types (use exactly what the TypeScript interface specifies)
- If error says "expected string, received object", pass a string not an object
- If error says "expected object, received string", pass an object not a string
- Match the exact property names and types from the interface definitions above

`;
          }

          const response = await generateObject({
            model: openai("gpt-5.1-codex-mini"),
            schema: z.object({
              code: z.string()
            }),
            prompt: `You are a code generating machine.

      In addition to regular javascript, you can also use the following functions:

      ${generatedTypes}

      Respond only with the code, nothing else. Output javascript code.

      IMPORTANT RULES:
      1. For function names containing hyphens or underscores, you MUST use bracket notation. For example: codemode["tool_abc_list-calendars"]({}) NOT codemode.tool_abc_list-calendars({})

      2. DEPENDENCY-AWARE TOOL ORDERING: Before calling a tool that requires specific input parameters (like "owner", "repo", "calendarId"), first call tools that can provide those values:
         - For GitHub tools: To get the authenticated user's username, use search_repositories with a known repo name (like the one you're creating) and extract "owner.login" from the results
         - For Calendar tools: If you need a calendarId, first call list-calendars to get available calendars and use the "primary" calendar or first one with accessRole "owner"
         - For any tool requiring IDs or names from other resources: Query those resources first

      3. Always store intermediate results in variables and use them in subsequent calls.

      4. REUSE EXISTING RESOURCES: If a resource already exists (repo, file, issue), USE IT - don't throw errors. Extract the needed info (owner, id, sha) from search/list results and continue.
         - If create_repository fails with "already exists", search for the repo and use the owner from the search results
         - If a file exists, get its sha and update it

      5. MCP TOOL RESPONSE FORMAT: All MCP tool responses are wrapped as { content: [{ type: "text", text: "JSON string" }] }. You MUST parse the response like this:
         const response = await codemode["tool_name"](params);
         const data = JSON.parse(response.content[0].text);
         // Now access data.items, data.owner, etc.

      Generate an anonymous async function expression. Do NOT call it, do NOT wrap it in IIFE, do NOT name it.

      CORRECT format (use exactly this structure):
      async function() {
        // Step 1: Get required context (user info, calendar list, etc.)
        // Step 2: Use that context in subsequent tool calls
        // Step 3: Return final result
        return result;
      }

      WRONG formats (do NOT use these):
      - (async () => { ... })()
      - async function main() { ... }
      - main()
${retryContext}
      Here is user input: ${functionDescription}`
          });

          // Track cumulative usage
          cumulativeUsage.inputTokens += response.usage?.inputTokens ?? 0;
          cumulativeUsage.outputTokens += response.usage?.outputTokens ?? 0;
          cumulativeUsage.totalTokens += response.usage?.totalTokens ?? 0;

          console.log(
            "\n╔═════════════════════════════════════════════════════════"
          );
          console.log(
            "║ [CODEMODE LLM] Response" +
              (attempt > 1 ? ` (Attempt ${attempt})` : "")
          );
          console.log(
            "╠═════════════════════════════════════════════════════════"
          );
          console.log("║ Generated Code:");
          console.log("║", response.object.code.split("\n").join("\n║ "));
          console.log("║");
          console.log(
            "║ Tokens: in=" +
              (response.usage?.inputTokens ?? 0) +
              " out=" +
              (response.usage?.outputTokens ?? 0) +
              " total=" +
              (response.usage?.totalTokens ?? 0)
          );
          console.log(
            "╚═════════════════════════════════════════════════════════"
          );

          console.log(
            "\n▶ [EXECUTION] Starting V8 isolate..." +
              (attempt > 1 ? ` (Attempt ${attempt})` : "")
          );
          const evaluator = createEvaluator(response.object.code, {
            proxy: options.proxy,
            loader: options.loader
          });
          const result = await evaluator();

          // Check if result contains an error from the V8 isolate
          if (
            result &&
            typeof result === "object" &&
            "err" in result &&
            result.err
          ) {
            const errorMsg = String(result.err);
            console.log(
              "\n╔═════════════════════════════════════════════════════════"
            );
            console.log("║ [EXECUTION] Failed - Error in generated code");
            console.log(
              "╠═════════════════════════════════════════════════════════"
            );
            console.log("║ Error:", errorMsg.split("\n").join("\n║ "));
            console.log(
              "╚═════════════════════════════════════════════════════════"
            );

            // If we have retries left, continue to next attempt
            if (attempt < MAX_RETRIES) {
              lastError = errorMsg;
              lastCode = response.object.code;
              console.log(
                `\n⟳ [RETRY] Attempt ${attempt} failed, will retry with error context...`
              );
              continue;
            }

            // No retries left, return the error result
            console.log(
              "\n╔═════════════════════════════════════════════════════════"
            );
            console.log("║ [EXECUTION] All retries exhausted");
            console.log(
              "╚═════════════════════════════════════════════════════════"
            );
          } else {
            console.log(
              "\n╔═════════════════════════════════════════════════════════"
            );
            console.log(
              "║ [EXECUTION] Complete" +
                (attempt > 1 ? ` (After ${attempt} attempts)` : "")
            );
            console.log(
              "╠═════════════════════════════════════════════════════════"
            );
            console.log(
              "║ Result:",
              JSON.stringify(result, null, 2).split("\n").join("\n║ ")
            );
            console.log(
              "╚═════════════════════════════════════════════════════════"
            );
          }

          return {
            code: response.object.code,
            result: result,
            codemodeUsage: cumulativeUsage
          };
        } catch (error) {
          const errorMsg =
            error instanceof Error ? error.message : String(error);
          console.error(
            "\n╔═════════════════════════════════════════════════════════"
          );
          console.error("║ [ERROR] Code generation/execution failed");
          console.error(
            "╠═════════════════════════════════════════════════════════"
          );
          console.error("║", errorMsg);
          console.error(
            "╚═════════════════════════════════════════════════════════"
          );

          if (attempt < MAX_RETRIES) {
            lastError = errorMsg;
            lastCode = null;
            console.log(`\n⟳ [RETRY] Attempt ${attempt} failed, will retry...`);
            continue;
          }
          throw error;
        }
      }

      // Should not reach here, but just in case
      throw new Error("All retry attempts exhausted");
    }
  });

  return { prompt, tools: { codemode: codemodeTool } };
}

function createEvaluator(
  code: string,
  options: {
    loader: WorkerLoader;
    proxy: Fetcher<CodeModeProxy>;
  }
) {
  return async () => {
    const worker = options.loader.get(`code-${Math.random()}`, () => {
      return {
        compatibilityDate: "2025-06-01",
        compatibilityFlags: ["nodejs_compat"],
        mainModule: "foo.js",
        modules: {
          "foo.js": `
import { env, WorkerEntrypoint } from "cloudflare:workers";

export default class CodeModeWorker extends WorkerEntrypoint {
  async evaluate() {
    try {
      const { CodeModeProxy } = env;
      const codemode = new Proxy(
        {},
        {
          get: (target, prop) => {
            return (args) => {
              return CodeModeProxy.callFunction({
                functionName: prop,
                args: args,
              });
            };
          }
        }
      );

      return await ${code}();
    } catch (err) {
      return {
        err: err.message,
        stack: err.stack
      };
    }
  }
}
            
        `
        },
        env: {
          // insert keys and bindings to tools/ts functions here
          CodeModeProxy: options.proxy
        },
        globalOutbound: null
      };
    });

    // @ts-expect-error TODO: fix this
    return await worker.getEntrypoint().evaluate();
  };
}

async function generateTypes(tools: ToolSet) {
  let availableTools = "";
  let availableTypes = "";

  for (const [toolName, tool] of Object.entries(tools)) {
    // @ts-expect-error TODO: fix this
    const inputJsonType = tool.inputSchema.jsonSchema
      ? await compileJsonSchemaToTs(
          // @ts-expect-error TODO: fix this
          tool.inputSchema.jsonSchema,
          `${toCamelCase(toolName)}Input`,
          {
            format: false,
            bannerComment: " "
          }
        )
      : printNodeZodToTs(
          createTypeAlias(
            zodToTs(
              // @ts-expect-error TODO: fix this
              tool.inputSchema,
              `${toCamelCase(toolName)}Input`
            ).node,
            `${toCamelCase(toolName)}Input`
          )
        );

    const outputJsonType =
      // @ts-expect-error TODO: fix this
      tool.outputSchema?.jsonSchema
        ? await compileJsonSchemaToTs(
            // @ts-expect-error TODO: fix this
            tool.outputSchema?.jsonSchema,
            `${toCamelCase(toolName)}Output`,
            {
              format: false,
              bannerComment: " "
            }
          )
        : tool.outputSchema
          ? printNodeZodToTs(
              createTypeAlias(
                zodToTs(
                  // @ts-expect-error TODO: fix this
                  tool.outputSchema,
                  `${toCamelCase(toolName)}Output`
                ).node,
                `${toCamelCase(toolName)}Output`
              )
            )
          : `interface ${toCamelCase(toolName)}Output { [key: string]: any }`;

    const InputType = inputJsonType
      .trim()
      .replace("export interface", "interface");

    const OutputType = outputJsonType
      .trim()
      .replace("export interface", "interface");

    availableTypes += `\n${InputType}`;
    availableTypes += `\n${OutputType}`;
    availableTools += `\n\t/*\n\t${tool.description?.trim()}\n\t*/`;
    availableTools += `\n\t"${toolName}": (input: ${toCamelCase(toolName)}Input) => Promise<${toCamelCase(toolName)}Output>;`;
    availableTools += "\n";
  }

  availableTools = `\ndeclare const codemode: {${availableTools}}`;

  return `
${availableTypes}
${availableTools}
      `;
}

function getToolDescriptions(tools: ToolSet) {
  return Object.entries(tools)
    .map(([_toolName, tool]) => {
      return `\n- ${tool.description?.trim()}`;
    })
    .join("");
}
