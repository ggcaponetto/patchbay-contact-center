/**
 * Creates an API key for the MCP server (or any other integration) and prints it once.
 *
 *   node apps/mcp/scripts/create-api-key.mjs [apiUrl] [name] [adminKey]
 *
 * The key cannot be generated locally: `POST /api/admin/api-keys` creates it, stores only
 * a hash and returns the secret once. Settings are arguments rather than environment
 * variables so the same command works in bash, zsh, PowerShell and cmd.
 *
 * - Dev API (`DEV_USER_EMAIL` set): no credentials needed, the dev user owns the key.
 * - Otherwise pass an existing key with `api-keys:manage` as `adminKey`.
 *
 * @see apps/mcp/README.md
 */
const [apiUrl = 'http://localhost:4000', name = 'Claude MCP', adminKey] = process.argv.slice(2);

const res = await fetch(`${apiUrl.replace(/\/+$/, '')}/api/admin/api-keys`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    ...(adminKey ? { authorization: `Bearer ${adminKey}` } : {}),
  },
  body: JSON.stringify({
    name,
    // Trim to what the MCP client should be allowed to do.
    permissions: ['calls:read', 'calls:answer', 'calls:supervise', 'tenant:read'],
  }),
}).catch((err) => {
  console.error(
    `Cannot reach the API at ${apiUrl} (${err.cause?.code ?? err.message}). Is it running?`,
  );
  process.exit(1);
});
if (!res.ok) {
  console.error(`${res.status} ${await res.text()}`);
  process.exit(1);
}
const { id, secret } = await res.json();
console.log(`MCP_API_KEY=${secret}`);
console.log(`(key id ${id}; the secret is shown only once, store it now)`);
