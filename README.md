# up-bank

Personal [Up Bank](https://up.com.au) MCP plugin for accounts, transactions, categories, and tags. It speaks the [Agent Plugins 1.0.0](https://agent-plugins.org/specification) format: `plugin.json`, `mcp.json`, and one skill under `skills/up-bank/`.

Webhooks and attachments are out of scope for v0.1.

## Requirements

- Node.js 18+ (global `fetch`)
- An Up Personal Access Token in `UP_ACCESS_TOKEN`

## Configure `UP_ACCESS_TOKEN`

Get a token from the Up app: swipe right → **Data sharing** → **Personal Access Token**, or from https://api.up.com.au.

Agent Plugins 1.0.0 has no secret store. This plugin declares the token as an MCP env placeholder. Put the real value in the host (Cursor Plugins → Configure, your shell, or a local `.env` you do not commit). Never commit the token.

`mcp.json` passes it through as `${UP_ACCESS_TOKEN}`:

```json
"env": {
  "UP_ACCESS_TOKEN": "${UP_ACCESS_TOKEN}"
}
```

The stdio server reads `process.env.UP_ACCESS_TOKEN` and sends:

```http
Authorization: Bearer <token>
```

to:

```text
https://api.up.com.au/api/v1
```

Copy `.env.example` to `.env` for local smoke tests only.

## Run the MCP server

From the plugin root:

```bash
export UP_ACCESS_TOKEN="up:yak:…"   # your token
node ./server.mjs
```

The process speaks JSON-RPC 2.0 over stdin/stdout (newline-delimited). A host that loads Agent Plugins should use `mcp.json` (`command`: `node`, `args`: `["./server.mjs"]`, `cwd`: `${PLUGIN_ROOT}`).

## Tools

Reads:

| Tool | Up API |
| --- | --- |
| `ping` | `GET /util/ping` |
| `list-accounts` | `GET /accounts` |
| `get-account` | `GET /accounts/{id}` |
| `list-transactions` | `GET /transactions` or `GET /accounts/{accountId}/transactions` |
| `get-transaction` | `GET /transactions/{id}` |
| `list-categories` | `GET /categories` |
| `list-tags` | `GET /tags` |

Writes (tags and category only):

| Tool | Up API |
| --- | --- |
| `add-transaction-tags` | `POST /transactions/{id}/relationships/tags` |
| `remove-transaction-tags` | `DELETE /transactions/{id}/relationships/tags` |
| `set-transaction-category` | `PATCH /transactions/{id}/relationships/category` |

Query mapping: `page[size]`, `page[after]`, `filter[accountType]`, `filter[ownershipType]`, `filter[status]`, `filter[since]`, `filter[until]`, `filter[category]`, `filter[tag]`, `filter[parent]`.

List results are `{ items, nextCursorUrl }`. `nextCursorUrl` is the API `links.next` URL. Pass it back as `next` (or a `page[after]` cursor). No offset pagination.

JSON:API `data.attributes` and relationship ids are flattened to domain shapes (`Account`, `Transaction`, `Category`, `Tag`, `Money`).

## Prove locally

```bash
node --check ./server.mjs
node ./scripts/prove.mjs
```

See [PROVE.md](PROVE.md) for recorded PASS/FAIL.

Grok Bot cannot load local plugins from `~/.cursor/plugins/local`. Cursor IDE can, if you install the plugin there.

## License

MIT
