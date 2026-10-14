# Gnito — Plugin SDK

## What a plugin is

A plugin is a directory containing:

```
my-plugin/
  manifest.json
  index.js          # optional; exports tools
```

## manifest.json

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "Does something useful.",
  "author": "you@example.com",
  "license": "MIT",
  "gnitoVersion": "0.1.0",
  "permissions": ["files:read", "network:fetch"],
  "tools": ["my_tool"],
  "configSchema": { "apiKey": "string" },
  "mcpServers": []
}
```

### Fields

| Field | Required | Notes |
|---|---|---|
| `name` | ✅ | unique slug |
| `version` | ✅ | semver |
| `description` | ✅ | shown in plugin center |
| `author` | ✅ | |
| `license` | ✅ | SPDX identifier |
| `gnitoVersion` | ✅ | minimum Gnito version |
| `permissions` | ✅ | array of permission slugs |
| `tools` | ❌ | tool names exposed to agent |
| `configSchema` | ❌ | user-editable config |
| `mcpServers` | ❌ | MCP server descriptors |

### Permission slugs

`files:read`, `files:write`, `files:delete`, `terminal:run`,
`network:fetch`, `network:web-search`, `git:read`, `git:write`,
`github:read`, `github:write`, `mcp:connect`, `memory:read`,
`memory:write`.

## index.js

Plugin code currently runs in the Gnito process with restricted
capabilities. This is **not** a secure sandbox — we disclose this
honestly. Only install plugins you trust.

```js
// index.js
export const tools = [
  {
    name: 'my_tool',
    description: 'Does something.',
    permissions: ['files:read'],
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    execute: async (input) => {
      // Use the global `gnito` (limited SDK).
      const files = await gnito.fs.readFile(input.path);
      return { output: { files } };
    },
  },
];
```

## Install

From Settings → Plugins:

1. Enter the absolute path to your plugin directory.
2. Click Install.
3. Review the manifest and permissions.

Or via API:

```bash
curl -X POST -H "X-Gnito-Session: $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"sourcePath":"/home/you/my-plugin"}' \
  http://127.0.0.1:8377/api/plugins/install
```

## Lifecycle

- Install → copied to `~/.gnito/plugins/<uuid>/`.
- Enable/disable via the plugin center.
- Uninstall removes the directory and DB row.

## See also

- `plugins/example/` — a working sample.
- `docs/security.md` — why plugin code is untrusted.
