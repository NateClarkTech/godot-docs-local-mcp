#!/usr/bin/env node
/**
 * Local stdio entrypoint for godot-docs-mcp.
 *
 * This is the primary entrypoint for the local on-demand Godot documentation MCP server.
 * It runs as a plain stdio process (no Cloudflare Worker, wrangler, or mcp-remote bridge required).
 *
 * The design allows AI clients (Grok Build, Claude, Cursor, etc.) to start the server on-demand
 * only when godot-docs tools are needed — no manual server start is required.
 *
 * Based on / adapted from the original work at https://github.com/james2doyle/godot-docs-mcp
 * (credit to James Doyle). This version prioritizes simple local stdio + optional full-offline cache.
 *
 * Usage (recommended — after `npm install` in the repo):
 *   ./node_modules/.bin/tsx src/stdio.ts
 *
 * Or via npm script (for manual testing):
 *   npm run dev:stdio
 *
 * In MCP client configs (Grok .grok/config.toml, Claude desktop config, .mcp.json, etc.):
 *   command = "/absolute/path/to/godot-docs-mcp/node_modules/.bin/tsx"
 *   args = ["src/stdio.ts"]
 *   # or with cwd set to the repo root: command + relative ./node_modules/.bin/tsx
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import packageJson from '../package.json';
import { getDocsPageForTerm, searchDocs } from './utils.js';

const supportedVersions = [
  'stable',
  'latest',
  '4.6',
  '4.5',
  '4.4',
  '4.3',
] as const;

const server = new McpServer({
  name: 'Godot Documentation',
  version: packageJson.version,
});

// Register the exact same tools as the Worker version.
server.tool(
  'search_docs',
  'Search the Godot documentation by term. Returns URLs to the full documentation for each matching term. The resulting URLs will need to have their page content fetched to see the documentation.',
  {
    searchTerm: z.string(),
    version: z.enum(supportedVersions).optional().default('stable'),
  },
  ({ searchTerm, version }) => searchDocs(searchTerm, version) as any,
);

server.tool(
  'get_docs_page_for_term',
  'Fetch content from the Godot documentation by term. Will only return a single documentation page for the first matching result.',
  {
    searchTerm: z.string(),
    version: z.enum(supportedVersions).optional().default('stable'),
  },
  ({ searchTerm, version }) => getDocsPageForTerm(searchTerm, version) as any,
);

// Connect over stdio — this is what Grok Build / other clients talk to directly.
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error('MCP server error:', error);
  process.exit(1);
});
