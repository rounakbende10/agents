import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: "demo-tools",
  version: "1.0.0"
});

// Calculator tool
server.tool(
  "calculate",
  "Perform mathematical calculations. Supports +, -, *, /, ^, sqrt, sin, cos, tan, log",
  {
    expression: z
      .string()
      .describe(
        "Mathematical expression to evaluate, e.g., '2 + 3 * 4' or 'sqrt(16)'"
      )
  },
  async ({ expression }) => {
    try {
      // Safe math evaluation
      const result = evaluateMath(expression);
      return {
        content: [{ type: "text", text: `Result: ${result}` }]
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error: ${error}` }],
        isError: true
      };
    }
  }
);

// Current time tool
server.tool(
  "get_current_time",
  "Get the current date and time in various formats",
  {
    timezone: z
      .string()
      .optional()
      .describe(
        "Timezone like 'America/New_York' or 'UTC'. Defaults to local."
      ),
    format: z
      .enum(["iso", "readable", "unix"])
      .optional()
      .describe("Output format")
  },
  async ({ timezone, format = "readable" }) => {
    const now = new Date();
    let result: string;

    if (format === "unix") {
      result = Math.floor(now.getTime() / 1000).toString();
    } else if (format === "iso") {
      result = now.toISOString();
    } else {
      result = now.toLocaleString("en-US", {
        timeZone: timezone || undefined,
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
      });
    }

    return {
      content: [{ type: "text", text: result }]
    };
  }
);

// Random number generator
server.tool(
  "random_number",
  "Generate a random number within a specified range",
  {
    min: z
      .number()
      .optional()
      .describe("Minimum value (inclusive). Default: 0"),
    max: z
      .number()
      .optional()
      .describe("Maximum value (inclusive). Default: 100"),
    count: z
      .number()
      .optional()
      .describe("How many random numbers to generate. Default: 1")
  },
  async ({ min = 0, max = 100, count = 1 }) => {
    const numbers = Array.from(
      { length: count },
      () => Math.floor(Math.random() * (max - min + 1)) + min
    );
    return {
      content: [
        {
          type: "text",
          text:
            numbers.length === 1
              ? numbers[0].toString()
              : JSON.stringify(numbers)
        }
      ]
    };
  }
);

// Unit converter
server.tool(
  "convert_units",
  "Convert between common units (length, weight, temperature)",
  {
    value: z.number().describe("The value to convert"),
    from: z
      .string()
      .describe(
        "Source unit (e.g., 'km', 'miles', 'kg', 'lbs', 'celsius', 'fahrenheit')"
      ),
    to: z.string().describe("Target unit")
  },
  async ({ value, from, to }) => {
    const conversions: Record<string, Record<string, (v: number) => number>> = {
      km: { miles: (v) => v * 0.621371, meters: (v) => v * 1000 },
      miles: { km: (v) => v * 1.60934, meters: (v) => v * 1609.34 },
      kg: { lbs: (v) => v * 2.20462, grams: (v) => v * 1000 },
      lbs: { kg: (v) => v * 0.453592, grams: (v) => v * 453.592 },
      celsius: {
        fahrenheit: (v) => (v * 9) / 5 + 32,
        kelvin: (v) => v + 273.15
      },
      fahrenheit: {
        celsius: (v) => ((v - 32) * 5) / 9,
        kelvin: (v) => ((v - 32) * 5) / 9 + 273.15
      },
      meters: {
        km: (v) => v / 1000,
        miles: (v) => v / 1609.34,
        feet: (v) => v * 3.28084
      },
      feet: { meters: (v) => v / 3.28084, km: (v) => v / 3280.84 }
    };

    const fromLower = from.toLowerCase();
    const toLower = to.toLowerCase();

    if (conversions[fromLower]?.[toLower]) {
      const result = conversions[fromLower][toLower](value);
      return {
        content: [
          {
            type: "text",
            text: `${value} ${from} = ${result.toFixed(4)} ${to}`
          }
        ]
      };
    }

    return {
      content: [{ type: "text", text: `Cannot convert from ${from} to ${to}` }],
      isError: true
    };
  }
);

// Text tools
server.tool(
  "text_transform",
  "Transform text (uppercase, lowercase, reverse, word count, character count)",
  {
    text: z.string().describe("The text to transform"),
    operation: z
      .enum([
        "uppercase",
        "lowercase",
        "reverse",
        "word_count",
        "char_count",
        "title_case"
      ])
      .describe("Operation to perform")
  },
  async ({ text, operation }) => {
    let result: string;
    switch (operation) {
      case "uppercase":
        result = text.toUpperCase();
        break;
      case "lowercase":
        result = text.toLowerCase();
        break;
      case "reverse":
        result = text.split("").reverse().join("");
        break;
      case "word_count":
        result = `Word count: ${text.split(/\s+/).filter(Boolean).length}`;
        break;
      case "char_count":
        result = `Character count: ${text.length} (without spaces: ${text.replace(/\s/g, "").length})`;
        break;
      case "title_case":
        result = text.replace(
          /\w\S*/g,
          (txt) => txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase()
        );
        break;
    }
    return {
      content: [{ type: "text", text: result }]
    };
  }
);

// UUID generator
server.tool(
  "generate_uuid",
  "Generate a UUID (universally unique identifier)",
  {
    count: z
      .number()
      .optional()
      .describe("How many UUIDs to generate. Default: 1")
  },
  async ({ count = 1 }) => {
    const uuids = Array.from({ length: count }, () => crypto.randomUUID());
    return {
      content: [{ type: "text", text: uuids.join("\n") }]
    };
  }
);

// JSON formatter
server.tool(
  "format_json",
  "Format/prettify JSON or validate JSON syntax",
  {
    json: z.string().describe("JSON string to format"),
    indent: z.number().optional().describe("Indentation spaces. Default: 2")
  },
  async ({ json, indent = 2 }) => {
    try {
      const parsed = JSON.parse(json);
      return {
        content: [{ type: "text", text: JSON.stringify(parsed, null, indent) }]
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Invalid JSON: ${error}` }],
        isError: true
      };
    }
  }
);

// Simple math evaluator (safe, no eval)
function evaluateMath(expr: string): number {
  // Remove spaces
  expr = expr.replace(/\s/g, "");

  // Handle functions
  expr = expr.replace(/sqrt\(([^)]+)\)/g, (_, n) =>
    Math.sqrt(evaluateMath(n)).toString()
  );
  expr = expr.replace(/sin\(([^)]+)\)/g, (_, n) =>
    Math.sin((evaluateMath(n) * Math.PI) / 180).toString()
  );
  expr = expr.replace(/cos\(([^)]+)\)/g, (_, n) =>
    Math.cos((evaluateMath(n) * Math.PI) / 180).toString()
  );
  expr = expr.replace(/tan\(([^)]+)\)/g, (_, n) =>
    Math.tan((evaluateMath(n) * Math.PI) / 180).toString()
  );
  expr = expr.replace(/log\(([^)]+)\)/g, (_, n) =>
    Math.log10(evaluateMath(n)).toString()
  );
  expr = expr.replace(/abs\(([^)]+)\)/g, (_, n) =>
    Math.abs(evaluateMath(n)).toString()
  );

  // Handle power
  expr = expr.replace(/(\d+(?:\.\d+)?)\^(\d+(?:\.\d+)?)/g, (_, a, b) =>
    Math.pow(parseFloat(a), parseFloat(b)).toString()
  );

  // Simple arithmetic parser
  const tokens = expr.match(/(\d+\.?\d*|[+\-*/()])/g);
  if (!tokens) throw new Error("Invalid expression");

  // Evaluate using a simple recursive descent parser
  let pos = 0;

  function parseExpression(): number {
    let left = parseTerm();
    while (
      pos < tokens.length &&
      (tokens[pos] === "+" || tokens[pos] === "-")
    ) {
      const op = tokens[pos++];
      const right = parseTerm();
      left = op === "+" ? left + right : left - right;
    }
    return left;
  }

  function parseTerm(): number {
    let left = parseFactor();
    while (
      pos < tokens.length &&
      (tokens[pos] === "*" || tokens[pos] === "/")
    ) {
      const op = tokens[pos++];
      const right = parseFactor();
      left = op === "*" ? left * right : left / right;
    }
    return left;
  }

  function parseFactor(): number {
    if (tokens[pos] === "(") {
      pos++;
      const result = parseExpression();
      pos++; // skip )
      return result;
    }
    if (tokens[pos] === "-") {
      pos++;
      return -parseFactor();
    }
    return parseFloat(tokens[pos++]);
  }

  return parseExpression();
}

// Start the server
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("Demo MCP server started");
