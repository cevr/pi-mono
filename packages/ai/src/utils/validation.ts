import AjvModule from "ajv";
import addFormatsModule from "ajv-formats";

// Handle both default and named exports
const Ajv = (AjvModule as any).default || AjvModule;
const addFormats = (addFormatsModule as any).default || addFormatsModule;

import type { Tool, ToolCall } from "../types.js";

// Detect if we're in a browser extension environment with strict CSP
// Chrome extensions with Manifest V3 don't allow eval/Function constructor
const isBrowserExtension = typeof globalThis !== "undefined" && (globalThis as any).chrome?.runtime?.id !== undefined;

// Create a singleton AJV instance with formats (only if not in browser extension)
// AJV requires 'unsafe-eval' CSP which is not allowed in Manifest V3
let ajv: any = null;
if (!isBrowserExtension) {
	try {
		ajv = new Ajv({
			allErrors: true,
			strict: false,
			coerceTypes: true,
		});
		addFormats(ajv);
	} catch (_e) {
		// AJV initialization failed (likely CSP restriction)
		console.warn("AJV validation disabled due to CSP restrictions");
	}
}

type JsonSchemaLike = {
	type?: string | string[];
	properties?: Record<string, JsonSchemaLike>;
	required?: string[];
	items?: JsonSchemaLike;
	anyOf?: JsonSchemaLike[];
	oneOf?: JsonSchemaLike[];
	enum?: unknown[];
	const?: unknown;
	additionalProperties?: JsonSchemaLike | boolean;
};

type AjvErrorLike = {
	instancePath?: string;
	message?: string;
	params?: {
		missingProperty?: string;
	};
};

function formatReceivedArguments(arguments_: unknown): string {
	return JSON.stringify(arguments_, null, 2) ?? String(arguments_);
}

function summarizeSchema(schema: JsonSchemaLike | undefined, depth = 0): string {
	if (!schema || depth > 2) return "unknown";

	if (schema.const !== undefined) {
		return JSON.stringify(schema.const);
	}

	if (Array.isArray(schema.enum) && schema.enum.length > 0) {
		return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
	}

	const union = schema.anyOf ?? schema.oneOf;
	if (Array.isArray(union) && union.length > 0) {
		return union.map((member) => summarizeSchema(member, depth + 1)).join(" | ");
	}

	if (schema.type === "object") {
		const properties = schema.properties ?? {};
		const required = new Set(schema.required ?? []);
		const entries = Object.entries(properties).map(([key, value]) => {
			const optional = required.has(key) ? "" : "?";
			return `${key}${optional}: ${summarizeSchema(value, depth + 1)}`;
		});
		return entries.length === 0 ? "{}" : `{ ${entries.join("; ")} }`;
	}

	if (schema.type === "array") {
		return `Array<${summarizeSchema(schema.items, depth + 1)}>`;
	}

	if (Array.isArray(schema.type) && schema.type.length > 0) {
		return schema.type.join(" | ");
	}

	if (typeof schema.type === "string") {
		return schema.type;
	}

	return "value";
}

function summarizeTopLevelSchema(schema: JsonSchemaLike): string {
	return summarizeSchema(schema);
}

function getSchemaAtInstancePath(
	schema: JsonSchemaLike | undefined,
	instancePath: string | undefined,
): JsonSchemaLike | undefined {
	if (!schema || !instancePath) return schema;

	const segments = instancePath
		.split("/")
		.map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"))
		.filter(Boolean);

	let current: JsonSchemaLike | undefined = schema;
	for (const segment of segments) {
		if (!current) return undefined;
		if (current.type === "array") {
			current = current.items;
			continue;
		}
		if (current.type === "object") {
			current = current.properties?.[segment];
			continue;
		}
		return undefined;
	}

	return current;
}

function formatValidationErrors(schema: JsonSchemaLike, errors: AjvErrorLike[] | null | undefined): string {
	if (!errors || errors.length === 0) {
		return "- root: unknown validation error";
	}

	const grouped = new Map<string, AjvErrorLike[]>();
	for (const err of errors) {
		const path = err.instancePath ? err.instancePath.substring(1) : err.params?.missingProperty || "root";
		const group = grouped.get(path) ?? [];
		group.push(err);
		grouped.set(path, group);
	}

	const formatted: string[] = [];
	for (const [path, group] of grouped) {
		const schemaAtPath = getSchemaAtInstancePath(schema, group[0]?.instancePath);
		const hasConstErrors = group.some((err) => err.message === "must be equal to constant");
		if (hasConstErrors && schemaAtPath) {
			formatted.push(`- ${path}: expected ${summarizeSchema(schemaAtPath)}`);
			continue;
		}

		for (const err of group) {
			formatted.push(`- ${path}: ${err.message ?? "invalid value"}`);
		}
	}

	return [...new Set(formatted)].join("\n");
}

function buildValidationErrorMessage(
	tool: Tool,
	toolCall: ToolCall,
	errors: AjvErrorLike[] | null | undefined,
): string {
	const expectedShape = summarizeTopLevelSchema(tool.parameters as JsonSchemaLike);
	const receivedArguments = formatReceivedArguments(toolCall.arguments);
	const formattedErrors = formatValidationErrors(tool.parameters as JsonSchemaLike, errors);

	return [
		`Tool call rejected: invalid arguments for "${toolCall.name}".`,
		"Fix the arguments and retry the same tool call once with corrected input.",
		"Do not repeat the same invalid payload unchanged.",
		"",
		"Problems:",
		formattedErrors,
		"",
		`Expected shape: ${expectedShape}`,
		"",
		"Received arguments:",
		receivedArguments,
	].join("\n");
}

/**
 * Finds a tool by name and validates the tool call arguments against its TypeBox schema
 * @param tools Array of tool definitions
 * @param toolCall The tool call from the LLM
 * @returns The validated arguments
 * @throws Error if tool is not found or validation fails
 */
export function validateToolCall(tools: Tool[], toolCall: ToolCall): any {
	const tool = tools.find((t) => t.name === toolCall.name);
	if (!tool) {
		throw new Error(`Tool "${toolCall.name}" not found`);
	}
	return validateToolArguments(tool, toolCall);
}

/**
 * Validates tool call arguments against the tool's TypeBox schema
 * @param tool The tool definition with TypeBox schema
 * @param toolCall The tool call from the LLM
 * @returns The validated (and potentially coerced) arguments
 * @throws Error with formatted message if validation fails
 */
export function validateToolArguments(tool: Tool, toolCall: ToolCall): any {
	// Skip validation in browser extension environment (CSP restrictions prevent AJV from working)
	if (!ajv || isBrowserExtension) {
		// Trust the LLM's output without validation
		// Browser extensions can't use AJV due to Manifest V3 CSP restrictions
		return toolCall.arguments;
	}

	// Compile the schema
	const validate = ajv.compile(tool.parameters);

	// Clone arguments so AJV can safely mutate for type coercion
	const args = structuredClone(toolCall.arguments);

	// Validate the arguments (AJV mutates args in-place for type coercion)
	if (validate(args)) {
		return args;
	}

	throw new Error(buildValidationErrorMessage(tool, toolCall, validate.errors as AjvErrorLike[] | undefined));
}
