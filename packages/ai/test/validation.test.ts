import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
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
});
