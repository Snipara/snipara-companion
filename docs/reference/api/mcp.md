# MCP API

This document describes three distinct MCP-facing contracts. They must not be
interchanged: the hosted MCP transport is JSON-RPC, while the web-app proxy and
the backend `/v1` endpoints are REST-shaped compatibility surfaces.

## Canonical hosted MCP transport

For Snipara Companion sessions and direct MCP clients, use the hosted
Streamable HTTP endpoint:

```text
POST https://api.snipara.com/mcp/{project_id_or_slug}
```

`GET` on the same URL is the server-sent events transport. `POST` accepts a
JSON-RPC 2.0 request and calls tools through `method: "tools/call"`:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "snipara_context_query",
    "arguments": {
      "query": "How does auth work?",
      "max_tokens": 4000
    }
  }
}
```

Authenticate with `Authorization: Bearer <SNIPARA_API_KEY>` or
`X-API-Key: <SNIPARA_API_KEY>`.

> Important: do not configure an MCP client or session with `/api/mcp/...` or
> `/v1/.../mcp`. Those are different REST contracts described below. The
> canonical direct agent route is `/mcp/{project_id_or_slug}`.

## Web app REST proxy

The web app exposes REST-shaped proxy routes for browser and application
integrations. They are not the direct hosted MCP transport and do not accept
the JSON-RPC body shown above:

## Overview

Snipara exposes two MCP proxy entry points:

| Scope   | Endpoint                         | Auth                |
| ------- | -------------------------------- | ------------------- |
| Project | `POST /api/mcp/:projectIdOrSlug` | Project API key     |
| Team    | `POST /api/mcp/team/:teamSlug`   | Service account key |

The proxy forwards requests to backend REST endpoints:

| Scope   | Endpoint                      |
| ------- | ----------------------------- |
| Project | `POST /v1/:projectId/mcp`     |
| Team    | `POST /v1/team/:teamSlug/mcp` |

Team MCP requests only allow the `snipara_multi_project_query` tool. These
`/api/mcp/...` and `/v1/.../mcp` routes are retained for the web-app/client
compatibility contract; they are not the route generated for Companion
sessions.

## Authentication

The web-app REST proxy uses the `X-API-Key` header. Direct hosted MCP clients
may use either `Authorization: Bearer <SNIPARA_API_KEY>` or `X-API-Key`.

Project keys are generated per project. Personal user keys follow the user's
effective project access. Bot/CI access uses service account keys with explicit
per-project grants.

## MCP Proxy (Project)

**POST** `/api/mcp/:projectIdOrSlug`

### Request

```json
{
  "tool": "snipara_context_query",
  "params": {
    "query": "How does auth work?",
    "max_tokens": 4000,
    "search_mode": "keyword",
    "include_metadata": true
  }
}
```

### Response

```json
{
  "success": true,
  "data": {
    "success": true,
    "result": {
      "sections": [],
      "total_tokens": 0,
      "max_tokens": 4000,
      "query": "How does auth work?",
      "search_mode": "keyword"
    },
    "usage": {
      "inputTokens": 0,
      "outputTokens": 0,
      "latencyMs": 0
    }
  }
}
```

## MCP Proxy (Team)

**POST** `/api/mcp/team/:teamSlug`

Only the `snipara_multi_project_query` tool is allowed for team requests.

### Request

```json
{
  "tool": "snipara_multi_project_query",
  "params": {
    "query": "How did we implement SSO in other projects?",
    "max_tokens": 8000,
    "per_project_limit": 3,
    "project_ids": ["docs-api", "snipara"],
    "exclude_project_ids": [],
    "search_mode": "keyword",
    "include_metadata": true,
    "prefer_summaries": false
  }
}
```

### Response

```json
{
  "success": true,
  "data": {
    "success": true,
    "result": {
      "query": "How did we implement SSO in other projects?",
      "max_tokens": 8000,
      "per_project_limit": 3,
      "search_mode": "keyword",
      "projects_queried": 2,
      "projects_skipped": 0,
      "results": [
        {
          "project_id": "proj_123",
          "project_slug": "docs-api",
          "success": true,
          "skipped": false,
          "result": {
            "sections": [],
            "total_tokens": 0,
            "max_tokens": 4000,
            "query": "How did we implement SSO in other projects?",
            "search_mode": "keyword"
          }
        }
      ]
    },
    "usage": {
      "inputTokens": 0,
      "outputTokens": 0,
      "latencyMs": 0
    }
  }
}
```

### Notes

- Rate limits apply per service account key.
- Usage limits are checked per project. Projects that exceed their monthly quota
  are returned with `skipped: true`.
- `max_tokens` is split evenly across included projects.
- `per_project_limit` caps the number of sections returned per project.
- Search modes may be downgraded based on the team plan.

## Service Account Key Management

Service accounts are the bot/CI key path for Team and Enterprise workspaces.
They require explicit project grants.

| Method | Endpoint                                                               | Description                    |
| ------ | ---------------------------------------------------------------------- | ------------------------------ |
| GET    | `/api/teams/:teamId/service-accounts`                                  | List service accounts          |
| POST   | `/api/teams/:teamId/service-accounts`                                  | Create service account + key   |
| PUT    | `/api/teams/:teamId/service-accounts/:serviceAccountId/project-access` | Replace project access grants  |
| POST   | `/api/teams/:teamId/service-accounts/:serviceAccountId/api-keys`       | Create another key             |
| DELETE | `/api/teams/:teamId/service-accounts/:serviceAccountId/api-keys`       | Revoke one service account key |

### Create Service Account

**POST** `/api/teams/:teamId/service-accounts`

```json
{
  "name": "CI deploy",
  "keyName": "Default key",
  "projectAccess": [{ "projectId": "prj_123", "accessLevel": "EDITOR" }]
}
```

### Response

```json
{
  "success": true,
  "data": {
    "serviceAccount": {
      "id": "svc_123",
      "name": "CI deploy"
    },
    "apiKey": {
      "id": "sak_123",
      "key": "snp-bot-abc123...",
      "keyPrefix": "snp-bot-abc123"
    }
  }
}
```

## cURL Examples

### Hosted MCP transport (Companion and direct MCP clients)

```bash
curl -X POST "https://api.snipara.com/mcp/snipara" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $SNIPARA_API_KEY" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"snipara_context_query","arguments":{"query":"Auth flow","max_tokens":2000}}}'
```

### Web app REST proxy

Project proxy:

```bash
curl -X POST "https://snipara.com/api/mcp/snipara" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: snipara_project_key" \
  -d '{"tool":"snipara_context_query","params":{"query":"Auth flow","max_tokens":2000}}'
```

Team proxy:

```bash
curl -X POST "https://www.snipara.com/api/mcp/team/snipara" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: snp-bot-key" \
  -d '{"tool":"snipara_multi_project_query","params":{"query":"SSO implementation","max_tokens":6000}}'
```
