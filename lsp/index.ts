/**
 * LSP Tool for pi-coding-agent
 *
 * Provides on-demand LSP queries: definitions, references, hover, symbols, diagnostics, signatures.
 * Requires the LSP hook to be loaded first (shared LSPManager).
 *
 * Usage:
 *   pi --hook ./lsp/lsp.ts --tool ./lsp
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Type, type Static } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import type { CustomToolFactory } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { getManager } from "./lsp-shared.js";
import { formatDiagnostic, type LSPManager } from "./lsp-core.js";

// Preview line limit when not expanded
const PREVIEW_LINES = 10;

const ACTIONS = [
  "definition",
  "references",
  "hover",
  "symbols",
  "diagnostics",
  "signature",
] as const;

const LspParams = Type.Object({
  action: StringEnum(ACTIONS),
  file: Type.String({ description: "File path" }),
  line: Type.Optional(
    Type.Number({
      description:
        "Line number (1-indexed). Required for definition/references/hover/signature unless query is provided.",
    })
  ),
  column: Type.Optional(
    Type.Number({
      description:
        "Column number (1-indexed). Required for definition/references/hover/signature unless query is provided.",
    })
  ),
  query: Type.Optional(
    Type.String({
      description:
        'Optional symbol name filter (used by action="symbols"; also used to resolve line/column for position-based actions when line/column are omitted)',
    })
  ),
});

type LspParamsType = Static<typeof LspParams>;

const DEFAULT_DIAGNOSTICS_WAIT_MS = 3000;

function uriToPath(uri: string): string {
  if (uri.startsWith("file://")) {
    try {
      return fileURLToPath(uri);
    } catch {
      return uri;
    }
  }
  return uri;
}

function formatLocation(
  location: { uri: string; range?: { start?: { line: number; character: number } } },
  cwd?: string
): string {
  const absPath = uriToPath(location.uri);
  const displayPath = cwd && path.isAbsolute(absPath) ? path.relative(cwd, absPath) : absPath;
  const line = location.range?.start?.line;
  const column = location.range?.start?.character;
  if (typeof line === "number" && typeof column === "number") {
    return `${displayPath}:${line + 1}:${column + 1}`;
  }
  return displayPath;
}

function formatFilePosition(file: string, line: number, column: number, cwd?: string): string {
  const absPath = path.isAbsolute(file) ? file : path.resolve(cwd ?? process.cwd(), file);
  const displayPath = cwd ? path.relative(cwd, absPath) : absPath;
  return `${displayPath}:${line}:${column}`;
}

function formatMarkedString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    if ("value" in value) return String((value as { value: unknown }).value);
  }
  return value === undefined ? "" : String(value);
}

function formatHoverContents(contents: unknown): string {
  if (Array.isArray(contents)) {
    return contents.map(formatMarkedString).filter(Boolean).join("\n\n");
  }
  return formatMarkedString(contents);
}

function formatSignatureHelp(help: any): string {
  if (!help || !Array.isArray(help.signatures) || help.signatures.length === 0) {
    return "No signature help available.";
  }

  const sigIndex = typeof help.activeSignature === "number" ? help.activeSignature : 0;
  const signature = help.signatures[sigIndex] ?? help.signatures[0];
  let text = signature.label ?? "Signature";

  const documentation = signature.documentation;
  if (documentation) {
    text += `\n${formatMarkedString(documentation)}`;
  }

  if (Array.isArray(signature.parameters) && signature.parameters.length > 0) {
    const params = signature.parameters
      .map((param: any) => {
        if (typeof param.label === "string") return param.label;
        if (Array.isArray(param.label)) return param.label.join("-");
        return "";
      })
      .filter(Boolean);
    if (params.length > 0) {
      text += `\nParameters: ${params.join(", ")}`;
    }
  }

  return text;
}

function matchesQuery(name: string, query?: string): boolean {
  if (!query) return true;
  return name.toLowerCase().includes(query.toLowerCase());
}

function collectSymbols(
  symbols: any[],
  depth = 0,
  lines: string[] = [],
  query?: string
): string[] {
  for (const symbol of symbols) {
    const name = symbol?.name ?? "<unknown>";
    if (!matchesQuery(name, query)) {
      if (Array.isArray(symbol.children) && symbol.children.length > 0) {
        collectSymbols(symbol.children, depth + 1, lines, query);
      }
      continue;
    }
    const range = symbol?.range?.start;
    const location = range ? `${range.line + 1}:${range.character + 1}` : "";
    const indent = "  ".repeat(depth);
    const detail = location ? ` (${location})` : "";
    lines.push(`${indent}${name}${detail}`);
    if (Array.isArray(symbol.children) && symbol.children.length > 0) {
      collectSymbols(symbol.children, depth + 1, lines, query);
    }
  }
  return lines;
}

function getSymbolStartPosition(symbol: any): { line: number; character: number } | null {
  const start = symbol?.selectionRange?.start ?? symbol?.range?.start;
  if (
    start &&
    typeof start.line === "number" &&
    typeof start.character === "number"
  ) {
    return { line: start.line, character: start.character };
  }
  return null;
}

function findSymbolStartPosition(symbols: any[], query: string): { line: number; character: number } | null {
  const q = query.toLowerCase();

  let exact: { line: number; character: number } | null = null;
  let partial: { line: number; character: number } | null = null;

  const visit = (items: any[]) => {
    for (const symbol of items) {
      const name = String(symbol?.name ?? "");
      const pos = getSymbolStartPosition(symbol);
      const n = name.toLowerCase();

      if (pos) {
        if (!exact && n === q) exact = pos;
        if (!partial && n.includes(q)) partial = pos;
      }

      if (Array.isArray(symbol?.children) && symbol.children.length > 0) {
        visit(symbol.children);
      }
    }
  };

  visit(symbols);
  return exact ?? partial;
}

async function resolveLineColumnFromQuery(
  manager: LSPManager,
  file: string,
  query: string
): Promise<{ line: number; column: number } | null> {
  const symbols = await manager.getDocumentSymbols(file);
  const pos = findSymbolStartPosition(symbols, query);
  if (!pos) return null;
  return { line: pos.line + 1, column: pos.character + 1 };
}

const factory: CustomToolFactory = () => ({
  name: "lsp",
  label: "LSP",
  description: "Query language server for definitions, references, types, symbols, and diagnostics",
  parameters: LspParams,

  async execute(_toolCallId, params: LspParamsType, _onUpdate, ctx, _signal) {
    const manager = getManager();
    if (!manager) {
      throw new Error("LSP not initialized - ensure lsp-hook is loaded");
    }

    const { action, file, line, column, query } = params;
    const needsPosition =
      action === "definition" ||
      action === "references" ||
      action === "hover" ||
      action === "signature";

    let resolvedLine = line;
    let resolvedColumn = column;
    let resolvedFromQuery = false;

    if (needsPosition && (resolvedLine === undefined || resolvedColumn === undefined)) {
      if (query) {
        const resolved = await resolveLineColumnFromQuery(manager, file, query);
        if (resolved) {
          resolvedLine = resolved.line;
          resolvedColumn = resolved.column;
          resolvedFromQuery = true;
        }
      }

      if (resolvedLine === undefined || resolvedColumn === undefined) {
        throw new Error(
          query
            ? `Action "${action}" requires line and column (1-indexed) or a query matching a symbol.`
            : `Action "${action}" requires line and column (1-indexed).`
        );
      }
    }

    const queryLine = query ? `query: ${query}\n` : "";

    const resolvedPositionLine =
      resolvedFromQuery && resolvedLine !== undefined && resolvedColumn !== undefined
        ? `resolvedPosition: ${resolvedLine}:${resolvedColumn}\n`
        : "";

    switch (action) {
      case "definition": {
        const results = await manager.getDefinition(file, resolvedLine!, resolvedColumn!);
        const lines = results.map((loc) => formatLocation(loc, ctx?.cwd));
        const payload =
          lines.length > 0
            ? lines.join("\n")
            : resolvedFromQuery
              ? formatFilePosition(file, resolvedLine!, resolvedColumn!, ctx?.cwd)
              : "No definitions found.";
        const text = `action: definition\n${queryLine}${resolvedPositionLine}${payload}`;
        return { content: [{ type: "text", text }], details: results };
      }
      case "references": {
        const results = await manager.getReferences(file, resolvedLine!, resolvedColumn!);
        const lines = results.map((loc) => formatLocation(loc, ctx?.cwd));
        const payload = lines.length > 0 ? lines.join("\n") : "No references found.";
        const text = `action: references\n${queryLine}${resolvedPositionLine}${payload}`;
        return { content: [{ type: "text", text }], details: results };
      }
      case "hover": {
        const result = await manager.getHover(file, resolvedLine!, resolvedColumn!);
        const payload = result
          ? formatHoverContents(result.contents) || "No hover information."
          : "No hover information.";
        const text = `action: hover\n${queryLine}${resolvedPositionLine}${payload}`;
        return { content: [{ type: "text", text }], details: result ?? null };
      }
      case "symbols": {
        const symbols = await manager.getDocumentSymbols(file);
        const lines = collectSymbols(symbols, 0, [], query);
        const payload =
          lines.length > 0
            ? lines.join("\n")
            : query
              ? `No symbols found matching "${query}".`
              : "No symbols found.";
        const text = `action: symbols\n${queryLine}${payload}`;
        return { content: [{ type: "text", text }], details: symbols };
      }
      case "diagnostics": {
        const diagnostics = await manager.touchFileAndWait(file, DEFAULT_DIAGNOSTICS_WAIT_MS);
        const payload =
          diagnostics.length > 0
            ? diagnostics.map(formatDiagnostic).join("\n")
            : "No diagnostics.";
        const text = `action: diagnostics\n${queryLine}${payload}`;
        return { content: [{ type: "text", text }], details: diagnostics };
      }
      case "signature": {
        const result = await manager.getSignatureHelp(file, resolvedLine!, resolvedColumn!);
        const payload = formatSignatureHelp(result);
        const text = `action: signature\n${queryLine}${resolvedPositionLine}${payload}`;
        return { content: [{ type: "text", text }], details: result ?? null };
      }
    }
  },

  renderCall(args: LspParamsType, theme: any) {
    let text = theme.fg("toolTitle", theme.bold("lsp "));
    text += theme.fg("accent", args.action || "...");
    if (args.file) {
      text += " " + theme.fg("muted", args.file);
    }
    if (args.query) {
      text += " " + theme.fg("dim", `query="${args.query}"`);
    } else if (args.line !== undefined && args.column !== undefined) {
      text += theme.fg("warning", `:${args.line}:${args.column}`);
    }
    return new Text(text, 0, 0);
  },

  renderResult(result: any, options: { expanded: boolean; isPartial: boolean }, theme: any) {
    if (options.isPartial) {
      return new Text(theme.fg("warning", "Running..."), 0, 0);
    }

    const textContent = result.content?.find((c: any) => c.type === "text")?.text || "";
    const lines = textContent.split("\n");

    // Always show header lines (action:, query:, resolvedPosition:)
    let headerEndIndex = 0;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith("action:") || lines[i].startsWith("query:") || lines[i].startsWith("resolvedPosition:")) {
        headerEndIndex = i + 1;
      } else {
        break;
      }
    }

    const headerLines = lines.slice(0, headerEndIndex);
    const contentLines = lines.slice(headerEndIndex);

    const maxContentLines = options.expanded ? contentLines.length : PREVIEW_LINES;
    const displayContentLines = contentLines.slice(0, maxContentLines);
    const remaining = contentLines.length - maxContentLines;

    let output = headerLines.map((line: string) => theme.fg("muted", line)).join("\n");
    if (displayContentLines.length > 0) {
      if (output) output += "\n";
      output += displayContentLines.map((line: string) => theme.fg("toolOutput", line)).join("\n");
    }
    if (remaining > 0) {
      output += theme.fg("dim", `\n... (${remaining} more lines)`);
    }

    return new Text(output, 0, 0);
  },
});

export default factory;
