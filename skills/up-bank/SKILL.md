---
name: up-bank
description: Use when the user asks about Up Bank balances, spending, accounts, transactions, categories, or tags. Call the Up Bank MCP tools; never invent balances or transaction data. Token is UP_ACCESS_TOKEN from the Up app → Data sharing → Personal Access Token, or https://api.up.com.au.
---

# Up Bank

Call the MCP tools in this plugin. Do not invent account balances, transactions, categories, or tags.

## Token

`UP_ACCESS_TOKEN` is a Personal Access Token from the Up mobile app (swipe right → **Data sharing** → **Personal Access Token**) or https://api.up.com.au. The server sends `Authorization: Bearer <token>` to `https://api.up.com.au/api/v1`. If `ping` fails, the token is missing or invalid — do not guess data.

## When to call which tool

- **Balances / which accounts exist** — `list-accounts` or `get-account`
- **Spending, transfers, a date range, or a merchant** — `list-transactions` (optional `accountId`, `status`, `since`, `until`, `category`, `tag`) or `get-transaction`
- **What categories exist / children of a parent** — `list-categories` (`parent` filter)
- **What tags exist** — `list-tags` (the tag `id` is the label)
- **Prove the token before anything else** — `ping`

Writes (only these two families):

- **Add or remove tags** — `add-transaction-tags` / `remove-transaction-tags`
- **Set or clear a category** — `set-transaction-category` (`categoryId` null clears). Parent categories cannot be assigned.

## Pagination

List tools return `{ items, nextCursorUrl }`. `nextCursorUrl` is the API’s opaque `links.next`. Pass it back as `next`. Do not invent offset pages.
