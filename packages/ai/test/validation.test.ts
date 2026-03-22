import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Tool, ToolCall } from "../src/types.js";
import { validateToolArguments } from "../src/utils/validation.js";

const webFetchSchema = Type.Object({
	url: Type.String({ description: "The fully-qualified URL" }),
	format: Type.Optional(Type.Union([Type.Literal("markdown"), Type.Literal("text"), Type.Literal("html")])),
	timeout_secs: Type.Optional(Type.Number({ minimum: 1 })),
});

const webFetchTool: Tool<typeof webFetchSchema> = {
	name: "web_fetch",
	description: "Fetch a web page or text resource from a URL.",
	parameters: webFetchSchema,
};

afterEach(() => {
	vi.restoreAllMocks();
});

describe("validateToolArguments", () => {
	it("returns repair-oriented guidance for malformed tool input", () => {
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call_123",
			name: "web_fetch",
			arguments: {
				url: {},
				format: "md",
				timeout_secs: 0,
			},
		};

		expect(() => validateToolArguments(webFetchTool, toolCall)).toThrowError(
			`Tool call rejected: invalid arguments for "web_fetch".
Fix the arguments and retry the same tool call once with corrected input.
Do not repeat the same invalid payload unchanged.

Problems:
- url: must be string
- format: expected "markdown" | "text" | "html"
- timeout_secs: must be >= 1

Expected shape: { url: string; format?: "markdown" | "text" | "html"; timeout_secs?: number }

Received arguments:
{
  "url": {},
  "format": "md",
  "timeout_secs": 0
}`,
		);
	});

	it("returns coerced arguments on valid input", () => {
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call_456",
			name: "web_fetch",
			arguments: {
				url: "https://example.com",
				format: "text",
				timeout_secs: "10",
			},
		};

		expect(validateToolArguments(webFetchTool, toolCall)).toEqual({
			url: "https://example.com",
			format: "text",
			timeout_secs: 10,
		});
	});

	it("falls back to raw arguments without writing to stderr when runtime code generation is blocked", () => {
		const originalFunction = globalThis.Function;
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const tool = {
			name: "echo",
			description: "Echo tool",
			parameters: Type.Object({
				count: Type.Number(),
			}),
		};
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "tool-1",
			name: "echo",
			arguments: { count: "42" as unknown as number },
		};

		globalThis.Function = (() => {
			throw new EvalError("Code generation from strings disallowed for this context");
		}) as unknown as FunctionConstructor;

		try {
			expect(validateToolArguments(tool, toolCall)).toEqual(toolCall.arguments);
			expect(errorSpy).not.toHaveBeenCalled();
		} finally {
			globalThis.Function = originalFunction;
		}
	});
});
