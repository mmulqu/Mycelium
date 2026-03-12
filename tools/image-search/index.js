#!/usr/bin/env node
/**
 * image-search — search & download images for Mycelium canvas sessions
 *
 * Usage:
 *   node index.js <query> [options]
 *
 * Options:
 *   --count N          Images to download (default: 5)
 *   --dir PATH         Download directory (default: ./downloads)
 *   --source NAME      openverse | unsplash | pexels (default: openverse)
 *   --orientation      landscape | portrait | square (default: any)
 *   --min-width N      Minimum width in px (default: 800)
 *   --dry-run          Search only, print results, don't download
 *   --format           json | paths (default: json)
 *
 * Environment variables (optional — enables that source):
 *   UNSPLASH_ACCESS_KEY
 *   PEXELS_API_KEY
 *
 * Output (JSON):
 *   {
 *     query, source, dir,
 *     results: [{ path, filename, url, title, credit, width, height, license }]
 *   }
 *
 * Examples:
 *   node index.js "ocean waves at sunset" --count 3
 *   node index.js "brutalist architecture" --source unsplash --orientation landscape
 *   node index.js "mycelium fungi macro" --dir /tmp/canvas-session --format paths
 */

import { createWriteStream, mkdirSync, existsSync } from "fs";
import { join, extname, resolve } from "path";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import https from "https";
import http from "http";

// ─── ARG PARSING ────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
if (!args.length || args[0] === "--help" || args[0] === "-h") {
  console.log(`Usage: node index.js <query> [--count N] [--dir PATH] [--source NAME]
         [--orientation landscape|portrait|square] [--min-width N]
         [--dry-run] [--format json|paths]

Sources: openverse (no key), unsplash (UNSPLASH_ACCESS_KEY), pexels (PEXELS_API_KEY)
`);
  process.exit(0);
}

// Separate positional args (query words) from --flag value pairs
const positional = [];
const flagValues = {};
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith("--")) {
    const name = args[i].slice(2);
    // If next arg exists and isn't itself a flag, it's this flag's value
    if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
      flagValues[name] = args[++i];
    } else {
      flagValues[name] = true; // boolean flag
    }
  } else {
    positional.push(args[i]);
  }
}

const query = positional.join(" ");
if (!query) { console.error("Error: provide a search query"); process.exit(1); }

const flag = (name, def) => flagValues[name] !== undefined ? flagValues[name] : def;
const hasFlag = (name) => name in flagValues;

const count       = Math.min(20, Math.max(1, parseInt(flag("count", "5"))));
const dir         = resolve(flag("dir", join(import.meta.dirname, "downloads")));
const source      = flag("source", process.env.UNSPLASH_ACCESS_KEY ? "unsplash"
                                 : process.env.PEXELS_API_KEY    ? "pexels"
                                 : "openverse");
const orientation = flag("orientation", null);   // null = any
const minWidth    = parseInt(flag("min-width", "800"));
const dryRun      = hasFlag("dry-run");
const format      = flag("format", "json");

// ─── SOURCES ────────────────────────────────────────────────────────────────

async function searchOpenverse(q, n, orientation) {
  const params = new URLSearchParams({
    q,
    page_size: Math.min(n * 3, 30), // over-fetch to allow filtering
    license_type: "all",
    media_type: "image",
  });
  if (orientation) params.set("aspect_ratio", orientation === "landscape" ? "wide"
                                             : orientation === "portrait"  ? "tall"
                                             : "square");

  const res = await fetch(`https://api.openverse.org/v1/images/?${params}`, {
    headers: { "User-Agent": "mycelium-image-search/1.0" },
  });
  if (!res.ok) throw new Error(`Openverse API error ${res.status}: ${await res.text()}`);
  const data = await res.json();

  return (data.results || []).map(r => ({
    url:     r.url,
    thumb:   r.thumbnail,
    title:   r.title || q,
    credit:  r.creator || "unknown",
    width:   r.width  || 0,
    height:  r.height || 0,
    license: r.license || "unknown",
    ext:     extname(r.url.split("?")[0]) || ".jpg",
  }));
}

async function searchUnsplash(q, n, orientation) {
  const key = process.env.UNSPLASH_ACCESS_KEY;
  if (!key) throw new Error("UNSPLASH_ACCESS_KEY not set");

  const params = new URLSearchParams({ query: q, per_page: Math.min(n * 2, 30) });
  if (orientation) params.set("orientation", orientation);

  const res = await fetch(`https://api.unsplash.com/search/photos?${params}`, {
    headers: { Authorization: `Client-ID ${key}` },
  });
  if (!res.ok) throw new Error(`Unsplash API error ${res.status}: ${await res.text()}`);
  const data = await res.json();

  return (data.results || []).map(r => ({
    // Use 'regular' (1080px) — large enough for canvas, not huge
    url:     r.urls.regular,
    thumb:   r.urls.thumb,
    title:   r.alt_description || r.description || q,
    credit:  r.user.name,
    width:   r.width,
    height:  r.height,
    license: "Unsplash License",
    ext:     ".jpg",
  }));
}

async function searchPexels(q, n, orientation) {
  const key = process.env.PEXELS_API_KEY;
  if (!key) throw new Error("PEXELS_API_KEY not set");

  const params = new URLSearchParams({ query: q, per_page: Math.min(n * 2, 40) });
  if (orientation) params.set("orientation", orientation);

  const res = await fetch(`https://api.pexels.com/v1/search?${params}`, {
    headers: { Authorization: key },
  });
  if (!res.ok) throw new Error(`Pexels API error ${res.status}: ${await res.text()}`);
  const data = await res.json();

  return (data.photos || []).map(r => ({
    url:     r.src.large2x,  // ~1880px, good canvas resolution
    thumb:   r.src.small,
    title:   r.alt || q,
    credit:  r.photographer,
    width:   r.width,
    height:  r.height,
    license: "Pexels License",
    ext:     ".jpg",
  }));
}

const SOURCES = { openverse: searchOpenverse, unsplash: searchUnsplash, pexels: searchPexels };

// ─── DOWNLOAD ───────────────────────────────────────────────────────────────

function sanitize(str, maxLen = 40) {
  return str.replace(/[^a-z0-9]+/gi, "_").toLowerCase().slice(0, maxLen);
}

async function downloadFile(url, destPath) {
  const res = await fetch(url, {
    headers: { "User-Agent": "mycelium-image-search/1.0" },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`Download failed ${res.status} for ${url}`);
  const ws = createWriteStream(destPath);
  await pipeline(Readable.fromWeb(res.body), ws);
}

// ─── MAIN ───────────────────────────────────────────────────────────────────

async function main() {
  const searchFn = SOURCES[source];
  if (!searchFn) {
    console.error(`Unknown source "${source}". Choose: openverse, unsplash, pexels`);
    process.exit(1);
  }

  // Search
  let candidates;
  try {
    candidates = await searchFn(query, count, orientation);
  } catch (err) {
    console.error(`Search failed: ${err.message}`);
    process.exit(1);
  }

  // Filter by min width
  const filtered = candidates.filter(c => c.width === 0 || c.width >= minWidth);
  const selected = filtered.slice(0, count);

  if (selected.length === 0) {
    console.error("No results matched the criteria. Try lowering --min-width or changing the query.");
    process.exit(1);
  }

  if (dryRun) {
    console.log(JSON.stringify({ query, source, count: selected.length, results: selected.map(r => ({
      url: r.url, title: r.title, credit: r.credit, width: r.width, height: r.height, license: r.license,
    })) }, null, 2));
    return;
  }

  // Create download directory
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  // Download
  const results = [];
  const slug = sanitize(query, 30);
  const ts = Date.now();

  for (let i = 0; i < selected.length; i++) {
    const item = selected[i];
    const filename = `${slug}_${ts}_${i + 1}${item.ext}`;
    const destPath = join(dir, filename);

    try {
      await downloadFile(item.url, destPath);
      results.push({
        path:     destPath,
        filename,
        url:      item.url,
        title:    item.title,
        credit:   item.credit,
        width:    item.width,
        height:   item.height,
        license:  item.license,
      });
      process.stderr.write(`  [${i + 1}/${selected.length}] ${filename}\n`);
    } catch (err) {
      process.stderr.write(`  [${i + 1}/${selected.length}] FAILED: ${err.message}\n`);
    }
  }

  // Output
  if (format === "paths") {
    console.log(results.map(r => r.path).join("\n"));
  } else {
    console.log(JSON.stringify({ query, source, dir, results }, null, 2));
  }
}

main();
