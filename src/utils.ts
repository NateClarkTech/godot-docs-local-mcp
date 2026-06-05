import { createDocument } from '@mixmark-io/domino';
import MiniSearch, { type Options as MiniSearchOptions } from 'minisearch';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

// Adapted from https://github.com/james2doyle/godot-docs-mcp (credit to James Doyle).
// This version adds first-class local stdio + optional full-offline content cache.

type Version = 'stable' | 'latest' | '4.6' | '4.5' | '4.4' | '4.3';

type SearchIndexItem = {
  id: number;
  name: string;
  category: string;
  url: string;
};

// --- Local documentation cache support ---
// When files exist in local-docs/<version>/ they are preferred over network fetches.
// Use `npm run download-docs latest` (or other version) to populate/refresh.
// This is only for the local stdio/Node runtime. In the Cloudflare Workers
// runtime (wrangler dev / deploy), import.meta.url may be undefined, so we
// gracefully disable the local cache and always use network fetches.
function getLocalDocsRoot(): string | null {
  if (typeof import.meta === 'undefined' || typeof import.meta.url === 'undefined') {
    return null;
  }
  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    return path.resolve(__dirname, '..', '..', 'local-docs');
  } catch {
    return null;
  }
}

const LOCAL_DOCS_ROOT = getLocalDocsRoot();

function getLocalDocPath(version: Version, relativeUrl: string): string | null {
  if (!LOCAL_DOCS_ROOT) return null;
  // relativeUrl e.g. "/classes/class_node3d.html"
  const docPath = relativeUrl.replace(/^\//, '').replace(/\.html$/, '.md');
  return path.join(LOCAL_DOCS_ROOT, version, docPath);
}

function ensureDirForFile(filePath: string) {
  try {
    mkdirSync(path.dirname(filePath), { recursive: true });
  } catch {
    // FS not available (e.g. some test pools or deployed workers without disk) — ignore
  }
}

function saveLocalDoc(version: Version, relativeUrl: string, markdownContent: string) {
  const localPath = getLocalDocPath(version, relativeUrl);
  if (!localPath) return;
  ensureDirForFile(localPath);
  try {
    writeFileSync(localPath, markdownContent, 'utf8');
    console.info(`Saved local markdown: ${version}${relativeUrl}`);
  } catch {
    // ignore write failures (read-only FS, permissions, test sandbox, etc.)
  }
}

function loadLocalDoc(version: Version, relativeUrl: string): string | null {
  const localPath = getLocalDocPath(version, relativeUrl);
  if (!localPath || !existsSync(localPath)) {
    return null;
  }
  try {
    return readFileSync(localPath, 'utf8');
  } catch (e) {
    console.error(`Failed to read local doc at ${localPath}:`, e);
    return null;
  }
}

/** Bucket of miniseaches for each version */
const miniSearches = new Map<Version, MiniSearch<SearchIndexItem>>();

/** The markdown version of docs pages - avoids refetching them */
const fetchedPages = new Map();

const miniSearchOptions: MiniSearchOptions = {
  fields: ['name'], // fields to index for full-text search
  storeFields: ['name', 'category', 'url'], // fields to return with search results
  searchOptions: {
    boostDocument: (_, __, storedFields) => {
      // boost class pages
      return storedFields?.category === 'classes' ? 2 : 1;
    },
    fuzzy: 0.2,
  },
};

const turndownService = new TurndownService({
  hr: '---',
  codeBlockStyle: 'fenced',
});

function makeFullUrl(version: Version, page: string) {
  return `https://docs.godotengine.org/en/${version}${page}`;
}

export function toMarkdown(html: string): string {
  const doc = createDocument(html);
  const content = doc.querySelector('div[role="main"]');
  if (!content) return 'No main content found on page.';

  return turndownService.use(gfm).turndown(content);
}

async function search(searchTerm: string, version: Version = 'stable'): Promise<SearchIndexItem[]> {
  // keep the DB from being recreated/reindexed over and over
  if (!miniSearches.has(version)) {
    console.info(`Creating index for ${version}`);
    const miniSearch = new MiniSearch<SearchIndexItem>(miniSearchOptions);

    const searchIndex: SearchIndexItem[] = await import(
      `./indexes/${version}/searchindex.js.json`
    ).then((mod) => mod.default);

    miniSearch.removeAll();
    miniSearch.addAll(searchIndex);

    miniSearches.set(version, miniSearch);
  }

  const miniSearch = miniSearches.get(version);

  if (!miniSearch) {
    throw new Error(`No minisearch could be created for ${version}`);
  }

  const output = miniSearch.search(searchTerm);
  // Return the full stored items (they include id, name, category, url from the index)
  // We map to ensure we only return the fields we care about.
  return output.map((o: any) => ({
    id: o.id,
    name: o.name,
    category: o.category,
    url: o.url,
  }));
}

export const searchDocs = async (
  searchTerm: string,
  version: Version = 'stable',
) => {
  const results = await search(searchTerm, version);

  if (results.length < 1) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Failed to find any documentation for "${searchTerm}"`,
        },
      ],
      isError: true,
    };
  }

  const urls = results.map((r) => makeFullUrl(version, r.url));
  return {
    content: [
      {
        type: 'text' as const,
        text: urls.join('\n'),
      },
    ],
  };
};

export const getDocsPageForTerm = async (
  searchTerm: string,
  version: Version = 'stable',
) => {
  const results = await search(searchTerm, version);

  if (results.length < 1) {
    return {
      content: [
        {
          type: 'text',
          text: `Failed to find any documentation for "${searchTerm}"`,
        },
      ],
      isError: true,
    };
  }

  const first = results[0];
  const fullUrl = makeFullUrl(version, first.url);
  const relUrl = first.url;

  // 1. Prefer locally stored docs (populated by `npm run download-docs`)
  const localMd = loadLocalDoc(version, relUrl);
  if (localMd !== null) {
    console.info(`Using local markdown for ${fullUrl}`);
    const output = `URL: ${fullUrl}\nContent: ${localMd}`;
    return {
      content: [
        {
          type: 'text' as const,
          text: output,
        },
      ],
    };
  }

  // 2. In-memory cache from previous fetches in this process
  if (fetchedPages.has(fullUrl)) {
    console.info(`Reused existing markdown for ${fullUrl}`);
    return {
      content: [
        {
          type: 'text' as const,
          text: fetchedPages.get(fullUrl),
        },
      ],
    };
  }

  // 3. Fetch from network and cache locally for future offline use
  const res = await fetch(fullUrl);

  if (res.ok) {
    const contentType = res.headers.get('content-type') || '';

    const isHTML = contentType.includes('html');
    const body = await res.text();
    const content = !isHTML ? body : toMarkdown(body);

    console.info(`Created markdown for ${fullUrl}`);

    const output = [`URL: ${fullUrl}`, `Content: ${content}`].join('\n');

    fetchedPages.set(fullUrl, output);

    // Persist to local disk so subsequent runs (and the stdio server) can be offline
    saveLocalDoc(version, relUrl, content);

    return {
      content: [
        {
          type: 'text' as const,
          text: output,
        },
      ],
    };
  }

  return {
    content: [
      {
        type: 'text' as const,
        text: `Failed to fetch ${fullUrl}: ${res.status} ${res.statusText}\n${res.body}`,
      },
    ],
    isError: true,
  };
};
