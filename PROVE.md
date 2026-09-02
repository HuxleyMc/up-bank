# Proof (v0.1.0)

Recorded in this cloud workspace. Grok Bot cannot load local plugins from `~/.cursor/plugins/local` (Cursor IDE can). That path was not a real directory here, so the plugin was not copied there.

Command:

```bash
node ./scripts/prove.mjs
```

Schemas downloaded at runtime (not committed) to `/tmp/up-bank-prove/schemas/`:

- https://agent-plugins.org/schemas/1.0.0/plugin.schema.json
- https://agent-plugins.org/schemas/1.0.0/mcp.schema.json

Validated with Ajv 2020-12 (`ajv@8` installed only under `/tmp/up-bank-prove/ajv`, not in this repo).

| Check | Result | Evidence |
| --- | --- | --- |
| Paths | PASS | Plugin root `/workspace`: `plugin.json`, `mcp.json`, `server.mjs`, `skills/up-bank/SKILL.md`, `scripts/prove.mjs` |
| `plugin.json` schema | PASS | Ajv against downloaded `plugin.schema.json`. Closed 1.0.0 manifest: no extra top-level fields. `name` is `up-bank`. |
| `mcp.json` schema | PASS | Ajv against downloaded `mcp.schema.json`. stdio server, `cwd` `${PLUGIN_ROOT}`, env `UP_ACCESS_TOKEN` is the placeholder `${UP_ACCESS_TOKEN}` only. |
| `node --check` | PASS | `node --check ./server.mjs` exit 0 |
| MCP `initialize` | PASS | stdio JSON-RPC; `serverInfo.name=up-bank`, `protocolVersion=2025-03-26` |
| MCP `tools/list` | PASS | 10 tools: `ping`, `list-accounts`, `get-account`, `list-transactions`, `get-transaction`, `list-categories`, `list-tags`, `add-transaction-tags`, `remove-transaction-tags`, `set-transaction-category` |
| MCP `tools/call` `ping` (live API) | FAIL | Public `up:demo:…` tokens from Up’s OpenAPI examples return HTTP 401 `Not Authorized`. The tool mapped that to “The Up access token is missing or invalid.” without echoing the token. Direct `curl` to `GET https://api.up.com.au/api/v1/util/ping` with a demo token also 401. **ping requires a real Personal Access Token.** |
| Secrets in git | PASS | No `up:demo:` / `up:yak:` literals in plugin files. Demo token used only in process env for the smoke run. |
| `~/.cursor/plugins/local` | SKIP | `/home/ubuntu/.cursor/plugins/local` is not a real directory; not created. |

`plugin.json` does not contain a `variables` object: Agent Plugins 1.0.0 is a closed schema (`additionalProperties: false`). Adding `variables` would fail the schema check above. The secret is declared as the `UP_ACCESS_TOKEN` env placeholder in `mcp.json`.

## Live ping

With no `Authorization` header:

```text
HTTP 401
{"errors":[{"status":"401","title":"Not Authorized","detail":"The request was not authenticated because no valid credential was found in the Authorization header, or the Authorization header was not present."}]}
```

The MCP `ping` tool surfaces a token-missing/invalid message instead of that stack or the header value.
