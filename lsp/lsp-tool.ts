/**
 * LSP Tool Extension for pi-coding-agent
 *
 * Provides Language Server Protocol tool for:
 * - definitions, references, hover, signature help
 * - document symbols, diagnostics, workspace diagnostics
 * - rename, code actions
 *
 * Supported languages:
 *   - Dart/Flutter (dart language-server)
 *   - TypeScript/JavaScript (typescript-language-server)
 *   - Vue (vue-language-server)
 *   - Svelte (svelteserver)
 *   - Python (pyright-langserver)
 *   - Go (gopls)
 *   - Rust (rust-analyzer)
 *
 * Usage:
 *   pi --extension ./lsp-tool.ts
 *
 * Or use the combined lsp.ts extension for both hook and tool functionality.
 */

import * as path from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { getOrCreateManager, formatDiagnostic, filterDiagnosticsBySeverity, uriToPath, resolvePosition, type SeverityFilter } from "./lsp-core.js";

const PREVIEW_LINES = 10;
const DIAGNOSTICS_WAIT_MS = 3000;

const ACTIONS = ["definition", "references", "hover", "symbols", "diagnostics", "workspace-diagnostics", "signature", "rename", "codeAction"] as const;
const SEVERITY_FILTERS = ["all", "error", "warning", "info", "hint"] as const;

const LspParams = Type.Object({
  action: StringEnum(ACTIONS),
  file: Type.Optional(Type.String({ description: "File path (required for most actions)" })),
  files: Type.Optional(Type.Array(Type.String(), { description: "File paths for workspace-diagnostics" })),
  line: Type.Optional(Type.Number({ description: "Line (1-indexed). Required for position-based actions unless query provided." })),
  column: Type.Optional(Type.Number({ description: "Column (1-indexed). Required for position-based actions unless query provided." })),
  endLine: Type.Optional(Type.Number({ description: "End line for range-based actions (codeAction)" })),
  endColumn: Type.Optional(Type.Number({ description: "End column for range-based actions (codeAction)" })),
  query: Type.Optional(Type.String({ description: "Symbol name filter (for symbols) or to resolve position (for definition/references/hover/signature)" })),
  newName: Type.Optional(Type.String({ description: "New name for rename action" })),
  severity: Type.Optional(StringEnum(SEVERITY_FILTERS, { description: 'Filter diagnostics: "all"|"error"|"warning"|"info"|"hint"' })),
});

type LspParamsType = Static<typeof LspParams>;

function formatLocation(loc: { uri: string; range?: { start?: { line: number; character: number } } }, cwd?: string): string {
  const abs = uriToPath(loc.uri);
  const display = cwd && path.isAbsolute(abs) ? path.relative(cwd, abs) : abs;
  const { line, character: col } = loc.range?.start ?? {};
  return typeof line === "number" && typeof col === "number" ? `${display}:${line + 1}:${col + 1}` : display;
}

function formatHover(contents: unknown): string {
  if (typeof contents === "string") return contents;
  if (Array.isArray(contents)) return contents.map(c => typeof c === "string" ? c : (c as any)?.value ?? "").filter(Boolean).join("\n\n");
  if (contents && typeof contents === "object" && "value" in contents) return String((contents as any).value);
  return "";
}

function formatSignature(help: any): string {
  if (!help?.signatures?.length) return "No signature help available.";
  const sig = help.signatures[help.activeSignature ?? 0] ?? help.signatures[0];
  let text = sig.label ?? "Signature";
  if (sig.documentation) text += `\n${typeof sig.documentation === "string" ? sig.documentation : sig.documentation?.value ?? ""}`;
  if (sig.parameters?.length) {
    const params = sig.parameters.map((p: any) => typeof p.label === "string" ? p.label : Array.isArray(p.label) ? p.label.join("-") : "").filter(Boolean);
    if (params.length) text += `\nParameters: ${params.join(", ")}`;
  }
  return text;
}

function collectSymbols(symbols: any[], depth = 0, lines: string[] = [], query?: string): string[] {
  for (const sym of symbols) {
    const name = sym?.name ?? "<unknown>";
    if (query && !name.toLowerCase().includes(query.toLowerCase())) {
      if (sym.children?.length) collectSymbols(sym.children, depth + 1, lines, query);
      continue;
    }
    const loc = sym?.range?.start ? `${sym.range.start.line + 1}:${sym.range.start.character + 1}` : "";
    lines.push(`${"  ".repeat(depth)}${name}${loc ? ` (${loc})` : ""}`);
    if (sym.children?.length) collectSymbols(sym.children, depth + 1, lines, query);
  }
  return lines;
}

function formatWorkspaceEdit(edit: any, cwd?: string): string {
  const lines: string[] = [];
  
  if (edit.documentChanges?.length) {
    for (const change of edit.documentChanges) {
      if (change.textDocument?.uri) {
        const fp = uriToPath(change.textDocument.uri);
        const display = cwd && path.isAbsolute(fp) ? path.relative(cwd, fp) : fp;
        lines.push(`${display}:`);
        for (const e of change.edits || []) {
          const loc = `${e.range.start.line + 1}:${e.range.start.character + 1}`;
          lines.push(`  [${loc}] → "${e.newText}"`);
        }
      }
    }
  }
  
  if (edit.changes) {
    for (const [uri, edits] of Object.entries(edit.changes)) {
      const fp = uriToPath(uri);
      const display = cwd && path.isAbsolute(fp) ? path.relative(cwd, fp) : fp;
      lines.push(`${display}:`);
      for (const e of edits as any[]) {
        const loc = `${e.range.start.line + 1}:${e.range.start.character + 1}`;
        lines.push(`  [${loc}] → "${e.newText}"`);
      }
    }
  }
  
  return lines.length ? lines.join("\n") : "No edits.";
}

function formatCodeActions(actions: any[]): string[] {
  return actions.map((a, i) => {
    const title = a.title || a.command?.title || "Untitled action";
    const kind = a.kind ? ` (${a.kind})` : "";
    const isPreferred = a.isPreferred ? " ★" : "";
    return `${i + 1}. ${title}${kind}${isPreferred}`;
  });
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "lsp",
    label: "LSP",
    description: `Query language server for definitions, references, types, symbols, diagnostics, rename, and code actions.

Actions: definition, references, hover, signature, rename (require file + line/column or query), symbols (file, optional query), diagnostics (file), workspace-diagnostics (files array), codeAction (file + position).
Use bash to find files: find src -name "*.ts" -type f`,
    parameters: LspParams,

    async execute(_toolCallId, params, _onUpdate, ctx, _signal) {
      const manager = getOrCreateManager(ctx.cwd);
      const { action, file, files, line, column, endLine, endColumn, query, newName, severity } = params as LspParamsType;
      const sevFilter: SeverityFilter = severity || "all";
      const needsFile = action !== "workspace-diagnostics";
      const needsPos = ["definition", "references", "hover", "signature", "rename", "codeAction"].includes(action);

      if (needsFile && !file) throw new Error(`Action "${action}" requires a file path.`);

      let rLine = line, rCol = column, fromQuery = false;
      if (needsPos && (rLine === undefined || rCol === undefined) && query && file) {
        const resolved = await resolvePosition(manager, file, query);
        if (resolved) { rLine = resolved.line; rCol = resolved.column; fromQuery = true; }
      }
      if (needsPos && (rLine === undefined || rCol === undefined)) {
        throw new Error(`Action "${action}" requires line/column or a query matching a symbol.`);
      }

      const qLine = query ? `query: ${query}\n` : "";
      const sevLine = sevFilter !== "all" ? `severity: ${sevFilter}\n` : "";
      const posLine = fromQuery && rLine && rCol ? `resolvedPosition: ${rLine}:${rCol}\n` : "";

      switch (action) {
        case "definition": {
          const results = await manager.getDefinition(file!, rLine!, rCol!);
          const locs = results.map(l => formatLocation(l, ctx?.cwd));
          const payload = locs.length ? locs.join("\n") : fromQuery ? `${file}:${rLine}:${rCol}` : "No definitions found.";
          return { content: [{ type: "text", text: `action: definition\n${qLine}${posLine}${payload}` }], details: results };
        }
        case "references": {
          const results = await manager.getReferences(file!, rLine!, rCol!);
          const locs = results.map(l => formatLocation(l, ctx?.cwd));
          return { content: [{ type: "text", text: `action: references\n${qLine}${posLine}${locs.length ? locs.join("\n") : "No references found."}` }], details: results };
        }
        case "hover": {
          const result = await manager.getHover(file!, rLine!, rCol!);
          const payload = result ? formatHover(result.contents) || "No hover information." : "No hover information.";
          return { content: [{ type: "text", text: `action: hover\n${qLine}${posLine}${payload}` }], details: result ?? null };
        }
        case "symbols": {
          const symbols = await manager.getDocumentSymbols(file!);
          const lines = collectSymbols(symbols, 0, [], query);
          const payload = lines.length ? lines.join("\n") : query ? `No symbols matching "${query}".` : "No symbols found.";
          return { content: [{ type: "text", text: `action: symbols\n${qLine}${payload}` }], details: symbols };
        }
        case "diagnostics": {
          const result = await manager.touchFileAndWait(file!, DIAGNOSTICS_WAIT_MS);
          const filtered = filterDiagnosticsBySeverity(result.diagnostics, sevFilter);
          const payload = !result.receivedResponse
            ? "Timeout: LSP server did not respond. Try again."
            : filtered.length ? filtered.map(formatDiagnostic).join("\n") : "No diagnostics.";
          return { content: [{ type: "text", text: `action: diagnostics\n${sevLine}${payload}` }], details: { ...result, diagnostics: filtered } };
        }
        case "workspace-diagnostics": {
          if (!files?.length) throw new Error('Action "workspace-diagnostics" requires a "files" array.');
          const result = await manager.getDiagnosticsForFiles(files, DIAGNOSTICS_WAIT_MS);
          const out: string[] = [];
          let errors = 0, warnings = 0, filesWithIssues = 0;

          for (const item of result.items) {
            const display = ctx?.cwd && path.isAbsolute(item.file) ? path.relative(ctx.cwd, item.file) : item.file;
            if (item.status !== 'ok') { out.push(`${display}: ${item.error || item.status}`); continue; }
            const filtered = filterDiagnosticsBySeverity(item.diagnostics, sevFilter);
            if (filtered.length) {
              filesWithIssues++;
              out.push(`${display}:`);
              for (const d of filtered) {
                if (d.severity === 1) errors++; else if (d.severity === 2) warnings++;
                out.push(`  ${formatDiagnostic(d)}`);
              }
            }
          }

          const summary = `Analyzed ${result.items.length} file(s): ${errors} error(s), ${warnings} warning(s) in ${filesWithIssues} file(s)`;
          return { content: [{ type: "text", text: `action: workspace-diagnostics\n${sevLine}${summary}\n\n${out.length ? out.join("\n") : "No diagnostics."}` }], details: result };
        }
        case "signature": {
          const result = await manager.getSignatureHelp(file!, rLine!, rCol!);
          return { content: [{ type: "text", text: `action: signature\n${qLine}${posLine}${formatSignature(result)}` }], details: result ?? null };
        }
        case "rename": {
          if (!newName) throw new Error('Action "rename" requires a "newName" parameter.');
          const result = await manager.rename(file!, rLine!, rCol!, newName);
          if (!result) return { content: [{ type: "text", text: `action: rename\n${qLine}${posLine}No rename available at this position.` }], details: null };
          const edits = formatWorkspaceEdit(result, ctx?.cwd);
          return { content: [{ type: "text", text: `action: rename\n${qLine}${posLine}newName: ${newName}\n\n${edits}` }], details: result };
        }
        case "codeAction": {
          const result = await manager.getCodeActions(file!, rLine!, rCol!, endLine, endColumn);
          const actions = formatCodeActions(result);
          return { content: [{ type: "text", text: `action: codeAction\n${qLine}${posLine}${actions.length ? actions.join("\n") : "No code actions available."}` }], details: result };
        }
      }
    },

    renderCall(args, theme) {
      const params = args as LspParamsType;
      let text = theme.fg("toolTitle", theme.bold("lsp ")) + theme.fg("accent", params.action || "...");
      if (params.file) text += " " + theme.fg("muted", params.file);
      else if (params.files?.length) text += " " + theme.fg("muted", `${params.files.length} file(s)`);
      if (params.query) text += " " + theme.fg("dim", `query="${params.query}"`);
      else if (params.line !== undefined && params.column !== undefined) text += theme.fg("warning", `:${params.line}:${params.column}`);
      if (params.severity && params.severity !== "all") text += " " + theme.fg("dim", `[${params.severity}]`);
      return new Text(text, 0, 0);
    },

    renderResult(result, options, theme) {
      if (options.isPartial) return new Text(theme.fg("warning", "Running..."), 0, 0);

      const textContent = result.content?.find((c: any) => c.type === "text")?.text || "";
      const lines = textContent.split("\n");

      let headerEnd = 0;
      for (let i = 0; i < lines.length; i++) {
        if (/^(action|query|severity|resolvedPosition):/.test(lines[i])) headerEnd = i + 1;
        else break;
      }

      const header = lines.slice(0, headerEnd);
      const content = lines.slice(headerEnd);
      const maxLines = options.expanded ? content.length : PREVIEW_LINES;
      const display = content.slice(0, maxLines);
      const remaining = content.length - maxLines;

      let out = header.map((l: string) => theme.fg("muted", l)).join("\n");
      if (display.length) {
        if (out) out += "\n";
        out += display.map((l: string) => theme.fg("toolOutput", l)).join("\n");
      }
      if (remaining > 0) out += theme.fg("dim", `\n... (${remaining} more lines)`);

      return new Text(out, 0, 0);
    },
  });
}
