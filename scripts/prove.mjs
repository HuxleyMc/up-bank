#!/usr/bin/env node
/**
 * Local proof: schema validate, node --check, MCP initialize/tools/list, optional live ping.
 * Demo tokens are pulled from Up's public OpenAPI at runtime and never written to the repo.
 */

import { spawn, execFileSync } from "node:child_process";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = "/tmp/up-bank-prove";
const SCHEMA_PLUGIN =
  "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const SCHEMA_MCP = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
const OPENAPI =
  "https://raw.githubusercontent.com/up-banking/api/master/v1/openapi.json";

const results = [];

function record(name, pass, detail) {
  results.push({ name, pass, detail });
  const mark = pass ? "PASS" : "FAIL";
  process.stderr.write(`${mark}  ${name}${detail ? ` — ${detail}` : ""}\n`);
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  const text = await res.text();
  writeFileSync(dest, text);
  return text;
}

function spawnRpc(env = {}) {
  const child = spawn("node", [join(PLUGIN_ROOT, "server.mjs")], {
    cwd: PLUGIN_ROOT,
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map();
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (msg && Object.prototype.hasOwnProperty.call(msg, "id")) {
      const waiter = pending.get(msg.id);
      if (waiter) {
        pending.delete(msg.id);
        waiter(msg);
      }
    }
  });
  function request(id, method, params) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }, 15000);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
    });
  }
  function notify(method, params) {
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`,
    );
  }
  function close() {
    try {
      child.stdin.end();
    } catch {
      /* ignore */
    }
    child.kill("SIGTERM");
  }
  return { child, request, notify, close };
}

function findCommittedSecrets() {
  const skip = new Set([".git", "node_modules", "agent-tools"]);
  const hits = [];
  function walk(dir) {
    for (const name of readdirSync(dir)) {
      if (skip.has(name)) continue;
      const path = join(dir, name);
      const st = statSync(path);
      if (st.isDirectory()) walk(path);
      else if (st.isFile()) {
        const text = readFileSync(path, "utf8");
        if (/up:(?:demo|yak):[A-Za-z0-9_-]+/.test(text)) hits.push(path);
      }
    }
  }
  walk(PLUGIN_ROOT);
  return hits;
}

async function validateWithAjv(schemaPath, dataPath) {
  const ajvDir = join(TMP, "ajv");
  mkdirSync(ajvDir, { recursive: true });
  writeFileSync(
    join(ajvDir, "package.json"),
    JSON.stringify({ name: "up-bank-prove-ajv", private: true }),
  );
  if (!existsSync(join(ajvDir, "node_modules", "ajv"))) {
    execFileSync("npm", ["install", "--omit=dev", "ajv@8"], {
      cwd: ajvDir,
      stdio: "pipe",
    });
  }
  const ajvUrl = `file://${join(ajvDir, "node_modules/ajv/dist/2020.js")}`;
  const { default: Ajv2020 } = await import(ajvUrl);
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  const data = JSON.parse(readFileSync(dataPath, "utf8"));
  const validate = ajv.compile(schema);
  const valid = validate(data);
  if (!valid) {
    const errs = (validate.errors || [])
      .map((e) => `${e.instancePath || "/"} ${e.message}`)
      .join("; ");
    throw new Error(errs);
  }
}

async function main() {
  mkdirSync(join(TMP, "schemas"), { recursive: true });
  const pluginSchemaPath = join(TMP, "schemas", "plugin.schema.json");
  const mcpSchemaPath = join(TMP, "schemas", "mcp.schema.json");

  try {
    await download(SCHEMA_PLUGIN, pluginSchemaPath);
    await download(SCHEMA_MCP, mcpSchemaPath);
    record(
      "download schemas",
      true,
      `${SCHEMA_PLUGIN} and ${SCHEMA_MCP} → ${join(TMP, "schemas")}`,
    );
  } catch (err) {
    record("download schemas", false, String(err.message));
    printSummary();
    process.exit(1);
  }

  try {
    await validateWithAjv(pluginSchemaPath, join(PLUGIN_ROOT, "plugin.json"));
    record("plugin.json schema", true, pluginSchemaPath);
  } catch (err) {
    record("plugin.json schema", false, String(err.message));
  }

  try {
    await validateWithAjv(mcpSchemaPath, join(PLUGIN_ROOT, "mcp.json"));
    record("mcp.json schema", true, mcpSchemaPath);
  } catch (err) {
    record("mcp.json schema", false, String(err.message));
  }

  try {
    execFileSync("node", ["--check", join(PLUGIN_ROOT, "server.mjs")], {
      cwd: PLUGIN_ROOT,
      stdio: "pipe",
    });
    record("node --check server.mjs", true, join(PLUGIN_ROOT, "server.mjs"));
  } catch (err) {
    record(
      "node --check server.mjs",
      false,
      (err.stderr && err.stderr.toString()) || String(err.message),
    );
  }

  const secretHits = findCommittedSecrets();
  record(
    "no tokens in plugin files",
    secretHits.length === 0,
    secretHits.length
      ? `found token-like strings in ${secretHits.join(", ")}`
      : "no up:demo / up:yak literals in the plugin tree",
  );

  const localPlugins = join(
    process.env.HOME || "",
    ".cursor/plugins/local",
  );
  record(
    "skip ~/.cursor/plugins/local copy",
    true,
    existsSync(localPlugins)
      ? `directory exists at ${localPlugins}; not copied (not requested as an install step)`
      : `${localPlugins} is not a real directory; skipped`,
  );

  let mcp = null;
  try {
    mcp = spawnRpc({ UP_ACCESS_TOKEN: "" });
    const init = await mcp.request(1, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "up-bank-prove", version: "0.1.0" },
    });
    const initOk =
      init.result &&
      init.result.serverInfo &&
      init.result.serverInfo.name === "up-bank";
    record(
      "MCP initialize",
      Boolean(initOk),
      initOk
        ? `protocolVersion=${init.result.protocolVersion}`
        : JSON.stringify(init),
    );
    mcp.notify("notifications/initialized", {});
    const listed = await mcp.request(2, "tools/list", {});
    const names = ((listed.result && listed.result.tools) || []).map(
      (t) => t.name,
    );
    const expected = [
      "ping",
      "list-accounts",
      "get-account",
      "list-transactions",
      "get-transaction",
      "list-categories",
      "list-tags",
      "add-transaction-tags",
      "remove-transaction-tags",
      "set-transaction-category",
    ];
    const missing = expected.filter((n) => !names.includes(n));
    record(
      "MCP tools/list",
      missing.length === 0,
      missing.length
        ? `missing ${missing.join(", ")}`
        : `${names.length} tools: ${names.join(", ")}`,
    );
    mcp.close();
    mcp = null;
  } catch (err) {
    record("MCP initialize / tools/list", false, String(err.message));
    if (mcp) mcp.close();
  }

  let demoToken = process.env.UP_ACCESS_TOKEN;
  if (!demoToken || /^\$\{/.test(demoToken)) {
    try {
      const spec = await fetch(OPENAPI).then((r) => r.text());
      const match = spec.match(/up:demo:[A-Za-z0-9]+/);
      demoToken = match ? match[0] : null;
    } catch {
      demoToken = null;
    }
  }

  try {
    mcp = spawnRpc({
      UP_ACCESS_TOKEN: demoToken || "",
    });
    await mcp.request(1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "up-bank-prove", version: "0.1.0" },
    });
    mcp.notify("notifications/initialized", {});
    const ping = await mcp.request(3, "tools/call", {
      name: "ping",
      arguments: {},
    });
    const text =
      ping.result &&
      ping.result.content &&
      ping.result.content[0] &&
      ping.result.content[0].text;
    const isError = Boolean(ping.result && ping.result.isError);
    const livePingPass = Boolean(demoToken) && !isError;
    record(
      "MCP tools/call ping (live API)",
      livePingPass,
      livePingPass
        ? "GET /util/ping succeeded (token used only in process env, not written to git)"
        : demoToken
          ? `public demo token did not authenticate (${String(text).slice(0, 160)}). ping requires a real token.`
          : "no token available; ping requires a real UP_ACCESS_TOKEN",
    );
    mcp.close();
  } catch (err) {
    record("MCP tools/call ping (live API)", false, String(err.message));
    if (mcp) mcp.close();
  }

  const required = results.filter((r) => r.name !== "MCP tools/call ping (live API)");
  const requiredPass = required.every((r) => r.pass);
  printSummary();
  process.exit(requiredPass ? 0 : 1);
}

function printSummary() {
  const lines = results.map(
    (r) => `- ${r.pass ? "PASS" : "FAIL"} **${r.name}**: ${r.detail || ""}`,
  );
  process.stderr.write(`\n${results.filter((r) => r.pass).length}/${results.length} passed\n`);
  writeFileSync(
    join(TMP, "last-results.json"),
    JSON.stringify(results, null, 2),
  );
  writeFileSync(join(TMP, "last-results.md"), `${lines.join("\n")}\n`);
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err}\n`);
  process.exit(1);
});
