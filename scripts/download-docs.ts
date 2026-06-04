#!/usr/bin/env node
/**
 * Script to download full Godot documentation pages locally for offline use.
 *
 * Usage:
 *   npm run download-docs            # defaults to "latest"
 *   npm run download-docs latest
 *   npm run download-docs stable
 *
 * This will:
 *  - (Re)download the searchindex.js and regenerate src/indexes/<version>/searchindex.js.json
 *  - Delete any existing local-docs/<version>/
 *  - Download every page's HTML, convert to Markdown, and store in local-docs/<version>/...
 *
 * Once the files exist, the MCP server (when using local stdio) will serve the
 * content from the local files instead of fetching from the network.
 *
 * This is especially useful for non-stable versions like "latest" when you're
 * on a dev build (e.g. Godot 4.2 dev or future versions).
 *
 * The local-docs/ directory is gitignored.
 */

import { createDocument } from '@mixmark-io/domino';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const turndownService = new TurndownService({
  hr: '---',
  codeBlockStyle: 'fenced',
}).use(gfm);

function toMarkdown(html: string): string {
  const doc = createDocument(html);
  const content = doc.querySelector('div[role="main"]');
  if (!content) return 'No main content found';
  return turndownService.turndown(content);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const INDEXES_DIR = path.join(PROJECT_ROOT, 'src', 'indexes');
const LOCAL_DOCS_ROOT = path.join(PROJECT_ROOT, 'local-docs');

type SearchIndexItem = {
  id: number;
  name: string;
  category: string;
  url: string;
};

async function downloadSearchIndex(version: string): Promise<SearchIndexItem[]> {
  const indexDir = path.join(INDEXES_DIR, version);
  mkdirSync(indexDir, { recursive: true });

  const jsPath = path.join(indexDir, 'searchindex.js');
  const jsonPath = path.join(indexDir, 'searchindex.js.json');

  const searchIndexUrl = `https://docs.godotengine.org/en/${version}/searchindex.js`;
  console.log(`[download] Fetching search index for ${version}: ${searchIndexUrl}`);

  const res = await fetch(searchIndexUrl);
  if (!res.ok) {
    throw new Error(`Failed to download searchindex.js for ${version}: ${res.status} ${res.statusText}`);
  }

  const jsContent = await res.text();
  writeFileSync(jsPath, jsContent, 'utf8');

  // Convert JS wrapper to clean JSON (same logic as the manual build step)
  let jsonStr = jsContent.replace(/^Search\.setIndex\(/, '').replace(/\);?\s*$/, '');
  const data = JSON.parse(jsonStr);

  const docnames: string[] = data.docnames || [];
  const searchIndex: SearchIndexItem[] = docnames.map((name: string, id: number) => ({
    id,
    name,
    category: (name.split('/')[0] || ''),
    url: `/${name}.html`,
  }));

  writeFileSync(jsonPath, JSON.stringify(searchIndex, null, 2), 'utf8');
  console.log(`[download] Regenerated ${jsonPath} (${searchIndex.length} pages)`);

  return searchIndex;
}

async function downloadAllDocs(version: string, searchIndex: SearchIndexItem[]) {
  const verLocalDir = path.join(LOCAL_DOCS_ROOT, version);

  if (existsSync(verLocalDir)) {
    console.log(`[download] Replacing existing local docs in ${verLocalDir}`);
    rmSync(verLocalDir, { recursive: true, force: true });
  }
  mkdirSync(verLocalDir, { recursive: true });

  console.log(`[download] Downloading ${searchIndex.length} pages for version "${version}"...`);
  let successCount = 0;
  let failCount = 0;

  for (const item of searchIndex) {
    const relUrl = item.url; // e.g. "/classes/class_node3d.html"
    const fullUrl = `https://docs.godotengine.org/en/${version}${relUrl}`;
    const mdRelPath = relUrl.replace(/^\//, '').replace(/\.html$/, '.md');
    const mdPath = path.join(verLocalDir, mdRelPath);

    mkdirSync(path.dirname(mdPath), { recursive: true });

    try {
      const res = await fetch(fullUrl, { headers: { 'User-Agent': 'godot-docs-mcp-downloader/1.0' } });
      if (!res.ok) {
        console.warn(`  [warn] ${relUrl} -> HTTP ${res.status}`);
        failCount++;
        continue;
      }

      const html = await res.text();
      const contentType = res.headers.get('content-type') || '';
      const isHTML = contentType.includes('html');

      const md = isHTML ? toMarkdown(html) : html;

      writeFileSync(mdPath, md, 'utf8');
      successCount++;

      if (successCount % 200 === 0) {
        console.log(`  [progress] ${successCount} pages downloaded...`);
      }
    } catch (err: any) {
      console.warn(`  [warn] ${relUrl} -> ${err.message || err}`);
      failCount++;
    }
  }

  console.log(`[download] Finished ${version}: ${successCount} succeeded, ${failCount} failed.`);
  console.log(`[download] Local docs stored in: ${verLocalDir}`);
}

async function main() {
  const version = process.argv[2] || 'latest';

  if (!/^[a-z0-9.]+$/.test(version)) {
    console.error('Invalid version. Use e.g. "latest", "stable", "4.3"');
    process.exit(1);
  }

  console.log(`=== Godot Docs Local Downloader (version: ${version}) ===`);
  console.log('This will refresh the search index JSON and replace the full local document cache.');

  const searchIndex = await downloadSearchIndex(version);
  await downloadAllDocs(version, searchIndex);

  console.log('\nDone!');
  console.log('The MCP server will now prefer local files when available (in local-docs/).');
  console.log('Run with the stdio entrypoint (see README for client config examples).');
  console.log('To force refresh again later: npm run download-docs latest');
}

main().catch((err) => {
  console.error('Download failed:', err);
  process.exit(1);
});
