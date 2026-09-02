#!/usr/bin/env node
/**
 * Zero-dep stdio MCP server for the Up Bank personal API.
 * JSON-RPC 2.0, newline-delimited messages on stdin/stdout.
 */

import readline from "node:readline";

const API_ORIGIN = "https://api.up.com.au";
const API_BASE = "https://api.up.com.au/api/v1";
const SERVER_NAME = "up-bank";
const SERVER_VERSION = "0.1.0";
const SUPPORTED_PROTOCOL_VERSIONS = [
  "2024-11-05",
  "2025-03-26",
  "2025-11-25",
];
const DEFAULT_PROTOCOL_VERSION = "2025-03-26";

class UpApiError extends Error {
  constructor(status, title, detail) {
    const message = detail ? `${title}: ${detail}` : title;
    super(message);
    this.name = "UpApiError";
    this.status = status;
    this.title = title;
    this.detail = detail;
  }
}

function tokenFromEnv() {
  const raw = process.env.UP_ACCESS_TOKEN;
  if (!raw || raw.trim() === "" || /^\$\{UP_ACCESS_TOKEN\}$/.test(raw.trim())) {
    return null;
  }
  return raw.trim();
}

function redactSecrets(text) {
  if (typeof text !== "string") return text;
  return text.replace(/up:(?:demo|yak):[A-Za-z0-9_-]+/g, "up:***");
}

function relId(rel) {
  const data = rel && rel.data;
  if (data && typeof data === "object" && !Array.isArray(data) && data.id) {
    return data.id;
  }
  return null;
}

function relIds(rel) {
  const data = rel && rel.data;
  if (!Array.isArray(data)) return [];
  return data.map((item) => item && item.id).filter(Boolean);
}

function money(obj) {
  if (!obj || typeof obj !== "object") return null;
  return {
    currencyCode: obj.currencyCode,
    value: obj.value,
    valueInBaseUnits: obj.valueInBaseUnits,
  };
}

function flattenAccount(resource) {
  const attributes = (resource && resource.attributes) || {};
  return {
    id: resource.id,
    displayName: attributes.displayName,
    accountType: attributes.accountType,
    ownershipType: attributes.ownershipType,
    balance: money(attributes.balance),
    createdAt: attributes.createdAt,
  };
}

function flattenTransaction(resource) {
  const attributes = (resource && resource.attributes) || {};
  const relationships = (resource && resource.relationships) || {};
  const note = attributes.note;
  return {
    id: resource.id,
    status: attributes.status,
    description: attributes.description,
    rawText: attributes.rawText ?? null,
    message: attributes.message ?? null,
    amount: money(attributes.amount),
    foreignAmount: money(attributes.foreignAmount),
    createdAt: attributes.createdAt,
    settledAt: attributes.settledAt ?? null,
    isCategorizable: attributes.isCategorizable,
    accountId: relId(relationships.account),
    transferAccountId: relId(relationships.transferAccount),
    categoryId: relId(relationships.category),
    parentCategoryId: relId(relationships.parentCategory),
    tags: relIds(relationships.tags),
    note:
      note && typeof note === "object" ? note.text ?? null : note ?? null,
  };
}

function flattenCategory(resource) {
  const attributes = (resource && resource.attributes) || {};
  const relationships = (resource && resource.relationships) || {};
  return {
    id: resource.id,
    name: attributes.name,
    parentId: relId(relationships.parent),
  };
}

function flattenTag(resource) {
  return { id: resource.id };
}

function pageResult(items, links) {
  return {
    items,
    nextCursorUrl: (links && links.next) || null,
  };
}

function isAllowedApiUrl(urlString) {
  try {
    const url = new URL(urlString);
    return (
      url.protocol === "https:" &&
      url.origin === API_ORIGIN &&
      url.pathname.startsWith("/api/v1/")
    );
  } catch {
    return false;
  }
}

function looksLikeUrl(value) {
  return typeof value === "string" && /^https?:\/\//i.test(value);
}

function setQuery(params, name, value) {
  if (value === undefined || value === null || value === "") return;
  params.set(name, String(value));
}

function apiErrorFromBody(status, body) {
  const errors = body && Array.isArray(body.errors) ? body.errors : [];
  const first = errors[0] || {};
  const title = first.title || `Up API error (${status})`;
  const detail = first.detail || null;
  if (status === 401) {
    return new UpApiError(
      401,
      "Not Authorized",
      "The Up access token is missing or invalid.",
    );
  }
  return new UpApiError(status, title, detail);
}

async function upFetch(method, path, options = {}) {
  const token = tokenFromEnv();
  if (!token) {
    throw new UpApiError(
      401,
      "Not Authorized",
      "The Up access token is missing or invalid.",
    );
  }

  let url;
  if (options.nextUrl) {
    if (!isAllowedApiUrl(options.nextUrl)) {
      throw new UpApiError(
        400,
        "Invalid pagination URL",
        "next must be the API links.next URL or a page[after] cursor.",
      );
    }
    url = options.nextUrl;
  } else {
    url = `${API_BASE}${path}`;
    const params = new URLSearchParams();
    const query = options.query || {};
    for (const [key, value] of Object.entries(query)) {
      setQuery(params, key, value);
    }
    const qs = params.toString();
    if (qs) url += `?${qs}`;
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
  } catch (err) {
    throw new UpApiError(
      503,
      "Network error",
      "Could not reach the Up API.",
    );
  }

  if (response.status === 204) {
    return null;
  }

  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }

  if (!response.ok) {
    throw apiErrorFromBody(response.status, body);
  }
  return body;
}

function paginationQuery(args) {
  const query = {};
  const pageSize = args.pageSize ?? args.page_size;
  const pageAfter = args.pageAfter ?? args.page_after;
  const next = args.next;
  if (pageSize !== undefined && pageSize !== null && pageSize !== "") {
    query["page[size]"] = pageSize;
  }
  if (looksLikeUrl(next)) {
    return { nextUrl: next, query: {} };
  }
  if (next) {
    query["page[after]"] = next;
  } else if (pageAfter) {
    query["page[after]"] = pageAfter;
  }
  return { nextUrl: null, query };
}

const TOOLS = [
  {
    name: "ping",
    description:
      "Prove the Up access token with GET /util/ping. Call this first if auth is in doubt.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list-accounts",
    description:
      "List Up accounts (balances). Optional filters: accountType (SAVER|TRANSACTIONAL|HOME_LOAN), ownershipType (INDIVIDUAL|JOINT). Paginate with nextCursorUrl via next.",
    inputSchema: {
      type: "object",
      properties: {
        accountType: {
          type: "string",
          enum: ["SAVER", "TRANSACTIONAL", "HOME_LOAN"],
        },
        ownershipType: { type: "string", enum: ["INDIVIDUAL", "JOINT"] },
        pageSize: { type: "integer", minimum: 1, maximum: 100 },
        next: {
          type: "string",
          description:
            "Opaque pagination cursor: the previous nextCursorUrl, or page[after].",
        },
        pageAfter: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get-account",
    description: "Get a single Up account by id, including current balance.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "list-transactions",
    description:
      "List transactions across all accounts, or one account when accountId is set. Filters: status (HELD|SETTLED), since, until, category, tag. Paginate with next.",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string" },
        status: { type: "string", enum: ["HELD", "SETTLED"] },
        since: {
          type: "string",
          description: "RFC-3339 start (filter[since]). Not a page cursor.",
        },
        until: {
          type: "string",
          description: "RFC-3339 end (filter[until]). Not a page cursor.",
        },
        category: { type: "string" },
        tag: { type: "string" },
        pageSize: { type: "integer", minimum: 1, maximum: 100 },
        next: {
          type: "string",
          description:
            "Opaque pagination cursor: the previous nextCursorUrl, or page[after].",
        },
        pageAfter: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get-transaction",
    description: "Get a single transaction by id, flattened to domain fields.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "list-categories",
    description:
      "List Up spending categories. Optional parent id returns children of that parent. Not paginated by the API.",
    inputSchema: {
      type: "object",
      properties: { parent: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "list-tags",
    description:
      "List tags currently in use. The tag id is the label. Paginate with next.",
    inputSchema: {
      type: "object",
      properties: {
        pageSize: { type: "integer", minimum: 1, maximum: 100 },
        next: {
          type: "string",
          description:
            "Opaque pagination cursor: the previous nextCursorUrl, or page[after].",
        },
        pageAfter: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "add-transaction-tags",
    description:
      "WRITE: add tags to a transaction (POST /transactions/{id}/relationships/tags). At most 6 tags per transaction.",
    inputSchema: {
      type: "object",
      properties: {
        transactionId: { type: "string" },
        tags: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          description: "Tag labels (the identifier).",
        },
      },
      required: ["transactionId", "tags"],
      additionalProperties: false,
    },
  },
  {
    name: "remove-transaction-tags",
    description:
      "WRITE: remove tags from a transaction (DELETE /transactions/{id}/relationships/tags).",
    inputSchema: {
      type: "object",
      properties: {
        transactionId: { type: "string" },
        tags: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          description: "Tag labels (the identifier).",
        },
      },
      required: ["transactionId", "tags"],
      additionalProperties: false,
    },
  },
  {
    name: "set-transaction-category",
    description:
      "WRITE: set or clear a transaction category (PATCH /transactions/{id}/relationships/category). Pass categoryId null to clear. Parent categories cannot be assigned.",
    inputSchema: {
      type: "object",
      properties: {
        transactionId: { type: "string" },
        categoryId: {
          type: ["string", "null"],
          description: "Child category id, or null to de-categorize.",
        },
      },
      required: ["transactionId"],
      additionalProperties: false,
    },
  },
];

const TOOL_BY_NAME = Object.fromEntries(TOOLS.map((tool) => [tool.name, tool]));

async function callTool(name, args) {
  const input = args && typeof args === "object" ? args : {};
  switch (name) {
    case "ping": {
      const body = await upFetch("GET", "/util/ping");
      const meta = (body && body.meta) || {};
      return { id: meta.id, statusEmoji: meta.statusEmoji };
    }
    case "list-accounts": {
      const page = paginationQuery(input);
      const query = { ...page.query };
      if (!page.nextUrl) {
        if (input.accountType) query["filter[accountType]"] = input.accountType;
        if (input.ownershipType) {
          query["filter[ownershipType]"] = input.ownershipType;
        }
      }
      const body = await upFetch("GET", "/accounts", {
        query,
        nextUrl: page.nextUrl,
      });
      const items = ((body && body.data) || []).map(flattenAccount);
      return pageResult(items, body && body.links);
    }
    case "get-account": {
      if (!input.id) throw new UpApiError(400, "Missing id", "id is required.");
      const body = await upFetch(
        "GET",
        `/accounts/${encodeURIComponent(input.id)}`,
      );
      return flattenAccount(body.data);
    }
    case "list-transactions": {
      const page = paginationQuery(input);
      const query = { ...page.query };
      if (!page.nextUrl) {
        if (input.status) query["filter[status]"] = input.status;
        if (input.since) query["filter[since]"] = input.since;
        if (input.until) query["filter[until]"] = input.until;
        if (input.category) query["filter[category]"] = input.category;
        if (input.tag) query["filter[tag]"] = input.tag;
      }
      const path = input.accountId && !page.nextUrl
        ? `/accounts/${encodeURIComponent(input.accountId)}/transactions`
        : "/transactions";
      const body = await upFetch("GET", path, {
        query,
        nextUrl: page.nextUrl,
      });
      const items = ((body && body.data) || []).map(flattenTransaction);
      return pageResult(items, body && body.links);
    }
    case "get-transaction": {
      if (!input.id) throw new UpApiError(400, "Missing id", "id is required.");
      const body = await upFetch(
        "GET",
        `/transactions/${encodeURIComponent(input.id)}`,
      );
      return flattenTransaction(body.data);
    }
    case "list-categories": {
      const query = {};
      if (input.parent) query["filter[parent]"] = input.parent;
      const body = await upFetch("GET", "/categories", { query });
      const items = ((body && body.data) || []).map(flattenCategory);
      return pageResult(items, { next: null });
    }
    case "list-tags": {
      const page = paginationQuery(input);
      const body = await upFetch("GET", "/tags", {
        query: page.query,
        nextUrl: page.nextUrl,
      });
      const items = ((body && body.data) || []).map(flattenTag);
      return pageResult(items, body && body.links);
    }
    case "add-transaction-tags":
    case "remove-transaction-tags": {
      if (!input.transactionId) {
        throw new UpApiError(
          400,
          "Missing transactionId",
          "transactionId is required.",
        );
      }
      const tags = Array.isArray(input.tags) ? input.tags : [];
      if (tags.length === 0) {
        throw new UpApiError(400, "Missing tags", "tags must be a non-empty array.");
      }
      const method = name === "add-transaction-tags" ? "POST" : "DELETE";
      await upFetch(
        method,
        `/transactions/${encodeURIComponent(input.transactionId)}/relationships/tags`,
        {
          body: {
            data: tags.map((id) => ({ type: "tags", id })),
          },
        },
      );
      return {
        ok: true,
        write: true,
        transactionId: input.transactionId,
        tags,
        action: name === "add-transaction-tags" ? "added" : "removed",
      };
    }
    case "set-transaction-category": {
      if (!input.transactionId) {
        throw new UpApiError(
          400,
          "Missing transactionId",
          "transactionId is required.",
        );
      }
      const categoryId =
        input.categoryId === undefined ? undefined : input.categoryId;
      const data =
        categoryId === undefined || categoryId === null || categoryId === ""
          ? null
          : { type: "categories", id: categoryId };
      await upFetch(
        "PATCH",
        `/transactions/${encodeURIComponent(input.transactionId)}/relationships/category`,
        { body: { data } },
      );
      return {
        ok: true,
        write: true,
        transactionId: input.transactionId,
        categoryId: data ? data.id : null,
      };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function ok(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function fail(id, code, message, data) {
  const error = { code, message: redactSecrets(message) };
  if (data !== undefined) error.data = data;
  send({ jsonrpc: "2.0", id, error });
}

function toolResult(value) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

function toolError(message) {
  return {
    content: [{ type: "text", text: redactSecrets(message) }],
    isError: true,
  };
}

function negotiateProtocolVersion(requested) {
  if (SUPPORTED_PROTOCOL_VERSIONS.includes(requested)) return requested;
  return DEFAULT_PROTOCOL_VERSION;
}

async function handleRequest(message) {
  const { id, method, params } = message;
  switch (method) {
    case "initialize": {
      const protocolVersion = negotiateProtocolVersion(
        params && params.protocolVersion,
      );
      ok(id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions:
          "Personal Up Bank MCP. Set UP_ACCESS_TOKEN. Read tools first; tag and category tools write.",
      });
      return;
    }
    case "ping": {
      ok(id, {});
      return;
    }
    case "tools/list": {
      ok(id, { tools: TOOLS });
      return;
    }
    case "tools/call": {
      const name = params && params.name;
      const arguments_ = (params && params.arguments) || {};
      if (!name || !TOOL_BY_NAME[name]) {
        ok(id, toolError(`Unknown tool: ${name || "(missing)"}`));
        return;
      }
      try {
        const result = await callTool(name, arguments_);
        ok(id, toolResult(result));
      } catch (err) {
        const message =
          err instanceof UpApiError
            ? err.message
            : "Tool failed.";
        ok(id, toolError(message));
      }
      return;
    }
    default:
      fail(id, -32601, `Method not found: ${method}`);
  }
}

function handleMessage(message) {
  if (!message || message.jsonrpc !== "2.0") {
    if (message && Object.prototype.hasOwnProperty.call(message, "id")) {
      fail(message.id, -32600, "Invalid Request");
    }
    return;
  }
  if (Object.prototype.hasOwnProperty.call(message, "id")) {
    handleRequest(message).catch((err) => {
      fail(message.id, -32603, "Internal error");
      process.stderr.write(`${redactSecrets(String(err && err.message))}\n`);
    });
    return;
  }
  // Notifications: ignore (initialized, cancelled, etc.)
}

function start() {
  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      fail(null, -32700, "Parse error");
      return;
    }
    handleMessage(message);
  });
  rl.on("close", () => {
    process.exit(0);
  });
}

start();
