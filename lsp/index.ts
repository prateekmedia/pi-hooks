/**
 * LSP Extension - re-exports both hook and tool
 * 
 * When loading the directory, this ensures both extensions are registered.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import lspHook from "./lsp.js";
import lspTool from "./lsp-tool.js";

export default function (pi: ExtensionAPI) {
  lspHook(pi);
  lspTool(pi);
}
