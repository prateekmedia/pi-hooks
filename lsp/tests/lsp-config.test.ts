import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveLSPConfig, type LSPServerDefinition } from "../lsp-config.js";
import { LSPManager } from "../lsp-core.js";

const builtin: LSPServerDefinition = {
  id: "builtin",
  command: "builtin-ls",
  args: ["--stdio"],
  extensions: [".one"],
  rootMarkers: ["project.one"],
  languageIds: { ".one": "one" },
  initializationOptions: { original: true },
  diagnosticsWaitMs: 3000,
};

const tests: Array<{ name: string; fn: () => Promise<void> }> = [];
function test(name: string, fn: () => Promise<void>) { tests.push({ name, fn }); }
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function equal(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

async function withConfigs(globalValue: string | object | undefined, projectValue: string | object | undefined, fn: (paths: { cwd: string; global: string; project: string }) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "lsp-config-test-"));
  const cwd = join(dir, "project");
  const global = join(dir, "global.json");
  const project = join(cwd, ".pi", "lsp.json");
  await mkdir(join(cwd, ".pi"), { recursive: true });
  if (globalValue !== undefined) await writeFile(global, typeof globalValue === "string" ? globalValue : JSON.stringify(globalValue));
  if (projectValue !== undefined) await writeFile(project, typeof projectValue === "string" ? projectValue : JSON.stringify(projectValue));
  try { await fn({ cwd, global, project }); } finally { await rm(dir, { recursive: true, force: true }); }
}

function resolve(paths: { cwd: string; global: string; project: string }) {
  return resolveLSPConfig({ cwd: paths.cwd, builtins: [builtin], globalConfigPath: paths.global, projectConfigPath: paths.project });
}

test("global config can override a builtin and define a server", async () => {
  await withConfigs({ servers: {
    builtin: { command: "/opt/bin/one-ls", args: ["--new"], diagnosticsWaitMs: 5000 },
    custom: { command: "custom-ls", extensions: [".CUSTOM"], rootMarkers: ["custom.toml"], languageIds: { ".CUSTOM": "custom" } },
  } }, undefined, async (paths) => {
    const result = resolve(paths);
    const changed = result.servers.find((server) => server.id === "builtin")!;
    const custom = result.servers.find((server) => server.id === "custom")!;
    equal(changed.command, "/opt/bin/one-ls", "builtin command override");
    equal(changed.args, ["--new"], "builtin args override");
    equal(changed.diagnosticsWaitMs, 5000, "builtin wait override");
    assert(custom.command === "custom-ls" && custom.extensions[0] === ".custom", "custom server extensions should normalize");
    equal(custom.languageIds, { ".custom": "custom" }, "custom language ids should normalize");
  });
});

test("project config cannot add a server or change executable surfaces", async () => {
  await withConfigs(undefined, { servers: {
    builtin: { command: "/tmp/evil", args: ["--evil"], extensions: [".evil"], rootMarkers: ["evil"], languageIds: { ".evil": "evil" }, initializationOptions: { evil: true }, diagnosticsWaitMs: 7000 },
    projectOnly: { command: "evil", extensions: [".evil"], rootMarkers: ["evil"] },
  } }, async (paths) => {
    const result = resolve(paths);
    const server = result.servers.find((item) => item.id === "builtin")!;
    equal(server.command, builtin.command, "project command must be ignored");
    equal(server.args, builtin.args, "project args must be ignored");
    equal(server.extensions, builtin.extensions, "project extensions must be ignored");
    equal(server.rootMarkers, builtin.rootMarkers, "project roots must be ignored");
    equal(server.languageIds, builtin.languageIds, "project language ids must be ignored");
    equal(server.initializationOptions, builtin.initializationOptions, "project initialization options must be ignored");
    equal(server.diagnosticsWaitMs, 7000, "project wait tuning should apply");
    assert(!result.servers.some((item) => item.id === "projectOnly"), "project server must not be added");
    assert(result.warnings.some((warning) => warning.message.includes("privileged project field")), "privileged fields should warn");
    assert(result.warnings.some((warning) => warning.message.includes("cannot define servers")), "new project server should warn");
  });
});

test("malformed or oversized JSON leaves builtins working", async () => {
  await withConfigs("{not json", "[also bad", async (paths) => {
    const result = resolve(paths);
    assert(result.servers.length === 1 && result.servers[0].command === builtin.command, "builtin should survive malformed files");
    assert(result.warnings.length === 2, "both malformed files should warn");
  });

  await withConfigs(JSON.stringify({ padding: "x".repeat(300_000) }), undefined, async (paths) => {
    const result = resolve(paths);
    assert(result.servers.length === 1 && result.servers[0].command === builtin.command, "builtin should survive oversized files");
    assert(result.warnings.some((warning) => warning.message.includes("exceeds")), "oversized config should warn");
  });
});

test("project disable is monotonic", async () => {
  await withConfigs({ servers: { builtin: { disabled: true } } }, { servers: { builtin: { disabled: false } } }, async (paths) => {
    const result = resolve(paths);
    assert(result.servers[0].disabled === true, "project must not re-enable globally disabled server");
  });
});

test("diagnostics waits are clamped in both scopes", async () => {
  await withConfigs({ servers: { builtin: { diagnosticsWaitMs: 1 } } }, { servers: { builtin: { diagnosticsWaitMs: 999999 } } }, async (paths) => {
    const result = resolve(paths);
    equal(result.servers[0].diagnosticsWaitMs, 60000, "project upper clamp");
  });
  await withConfigs({ servers: { builtin: { diagnosticsWaitMs: 1 } } }, undefined, async (paths) => {
    equal(resolve(paths).servers[0].diagnosticsWaitMs, 250, "global lower clamp");
  });
});

test("relative commands with separators and incomplete new servers are rejected", async () => {
  await withConfigs({ servers: {
    builtin: { command: "./relative-ls" },
    bad: { command: "dir/server", extensions: [".bad"], rootMarkers: ["bad.toml"] },
    incomplete: { command: "ok-ls", extensions: [".ok"] },
  } }, undefined, async (paths) => {
    const result = resolve(paths);
    equal(result.servers[0].command, builtin.command, "invalid builtin override should be ignored");
    assert(result.servers.length === 1, "invalid new servers should not be added");
    assert(result.warnings.length >= 3, "invalid entries should expose warnings");
  });
});

test("prototype-pollution keys are ignored", async () => {
  const json = '{"servers":{"builtin":{"diagnosticsWaitMs":4000,"__proto__":{"polluted":true}},"constructor":{"command":"evil","extensions":[".x"],"rootMarkers":["x"]}}}';
  await withConfigs(json, undefined, async (paths) => {
    const result = resolve(paths);
    equal(result.servers[0].diagnosticsWaitMs, 4000, "safe sibling field should apply");
    assert(({} as any).polluted === undefined, "Object prototype must remain unchanged");
    assert(result.warnings.some((warning) => warning.message.includes("forbidden")), "forbidden keys should warn");
  });
});

test("manager excludes project-disabled servers and applies safe wait tuning", async () => {
  await withConfigs(undefined, { servers: { clangd: { disabled: true } } }, async (paths) => {
    const manager = new LSPManager(paths.cwd, { globalConfigPath: paths.global, projectConfigPath: paths.project });
    try {
      assert(manager.getServerForFile("source.cpp") === undefined, "disabled clangd must not match files");
    } finally {
      await manager.shutdown();
    }
  });

  await withConfigs(undefined, { servers: { clangd: { diagnosticsWaitMs: 9876 } } }, async (paths) => {
    const manager = new LSPManager(paths.cwd, { globalConfigPath: paths.global, projectConfigPath: paths.project });
    try {
      equal(manager.diagnosticsWaitMsForFile("source.cpp"), 9876, "project wait tuning should reach the manager");
      assert(manager.getServerForFile("source.cpp")?.command === "clangd", "project tuning must preserve builtin command");
    } finally {
      await manager.shutdown();
    }
  });
});

test("manager warns when global overrides bypass special executable discovery", async () => {
  await withConfigs({ servers: { typescript: { args: ["--stdio", "--log-level", "2"] } } }, undefined, async (paths) => {
    const manager = new LSPManager(paths.cwd, { globalConfigPath: paths.global, projectConfigPath: paths.project });
    try {
      assert(manager.getConfigWarnings().some((warning) => warning.server === "typescript" && warning.message.includes("discovery")), "special discovery override should warn");
    } finally {
      await manager.shutdown();
    }
  });
});

let failed = 0;
for (const item of tests) {
  try { await item.fn(); console.log(`  ${item.name}... ✓`); }
  catch (error) { failed++; console.error(`  ${item.name}... ✗\n    ${error instanceof Error ? error.message : String(error)}`); }
}
console.log(`\n${tests.length - failed} passed, ${failed} failed`);
if (failed) process.exit(1);
