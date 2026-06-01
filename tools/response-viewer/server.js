#!/usr/bin/env node
// Claude Code response viewer: streams session JSONL transcripts to a browser UI.
// - Multi-session aware: explicit session selection via ?session=<id>
// - No auto-switching; each browser window/tab pins to its own session
// - GET /sessions lists available sessions with previews
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { spawn } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 4850;
const PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");
// Bumped on every server start — used to cache-bust browser-side assets so a
// stale tab never loads old JS/CSS after a redeploy.
const SERVER_VERSION = Date.now().toString(36);

// Persistent headlines store. Keyed by session id; each entry tracks:
//   { headline: string, source: "auto"|"user", savedAt: number }
// User-edited entries are sticky — auto-extraction never overwrites them.
const HEADLINES_DIR = path.join(__dirname, "data");
const HEADLINES_PATH = path.join(HEADLINES_DIR, "headlines.json");
const headlinesStore = new Map();
let headlinesDirty = false;
let headlinesFlushTimer = null;

function loadHeadlinesSync() {
  try {
    if (!fs.existsSync(HEADLINES_DIR)) fs.mkdirSync(HEADLINES_DIR, { recursive: true });
    const raw = fs.readFileSync(HEADLINES_PATH, "utf8");
    const obj = JSON.parse(raw);
    for (const [id, val] of Object.entries(obj)) {
      if (val && typeof val.headline === "string") headlinesStore.set(id, val);
    }
    console.log(`[headlines] loaded ${headlinesStore.size} entries`);
  } catch (e) {
    if (e.code !== "ENOENT") console.warn("[headlines] load failed:", e.message);
  }
}

function flushHeadlines() {
  if (!headlinesDirty) return;
  headlinesDirty = false;
  const obj = Object.fromEntries(headlinesStore);
  const tmp = HEADLINES_PATH + ".tmp";
  fs.writeFile(tmp, JSON.stringify(obj, null, 2), (err) => {
    if (err) { console.warn("[headlines] write failed:", err.message); return; }
    fs.rename(tmp, HEADLINES_PATH, (err2) => {
      if (err2) console.warn("[headlines] rename failed:", err2.message);
    });
  });
}

function markHeadlinesDirty() {
  headlinesDirty = true;
  if (headlinesFlushTimer) return;
  // Debounce: coalesce bursts of writes into one disk hit.
  headlinesFlushTimer = setTimeout(() => {
    headlinesFlushTimer = null;
    flushHeadlines();
  }, 250);
}

// Sources, in priority order — higher index wins, so "auto" never overwrites
// a user-set / LLM-generated / asana-resolved headline.
// user > asana > llm > auto
const HEADLINE_SOURCES = ["auto", "llm", "asana", "user"];
function sourceRank(s) { return HEADLINE_SOURCES.indexOf(s); }

function setHeadline(id, headline, source) {
  if (!id || !headline) return;
  if (!HEADLINE_SOURCES.includes(source)) source = "user";
  const existing = headlinesStore.get(id);
  // Never let a lower-priority source overwrite a higher one (auto < asana < user).
  if (existing && sourceRank(source) < sourceRank(existing.source)) return;
  if (existing && existing.headline === headline && existing.source === source) return;
  headlinesStore.set(id, { headline, source, savedAt: Date.now() });
  markHeadlinesDirty();
}

loadHeadlinesSync();

// Persistent user-pinned sessions. Keyed by session id; each entry:
//   { pinnedAt: number }
// Pin is a binary state — sessions either are or aren't pinned. Order is
// derived from `pinnedAt` desc (most-recently-pinned first).
const PINS_PATH = path.join(HEADLINES_DIR, "pins.json");
const pinsStore = new Map();
let pinsDirty = false;
let pinsFlushTimer = null;

function loadPinsSync() {
  try {
    if (!fs.existsSync(HEADLINES_DIR)) fs.mkdirSync(HEADLINES_DIR, { recursive: true });
    const raw = fs.readFileSync(PINS_PATH, "utf8");
    const obj = JSON.parse(raw);
    for (const [id, val] of Object.entries(obj)) {
      if (val && typeof val.pinnedAt === "number") pinsStore.set(id, val);
    }
    console.log(`[pins] loaded ${pinsStore.size} entries`);
  } catch (e) {
    if (e.code !== "ENOENT") console.warn("[pins] load failed:", e.message);
  }
}

function flushPins() {
  if (!pinsDirty) return;
  pinsDirty = false;
  const obj = Object.fromEntries(pinsStore);
  const tmp = PINS_PATH + ".tmp";
  fs.writeFile(tmp, JSON.stringify(obj, null, 2), (err) => {
    if (err) { console.warn("[pins] write failed:", err.message); return; }
    fs.rename(tmp, PINS_PATH, (err2) => {
      if (err2) console.warn("[pins] rename failed:", err2.message);
    });
  });
}

function markPinsDirty() {
  pinsDirty = true;
  if (pinsFlushTimer) return;
  pinsFlushTimer = setTimeout(() => {
    pinsFlushTimer = null;
    flushPins();
  }, 250);
}

loadPinsSync();

// Defensive filter: hide JSONLs whose first user message is one of our own
// internal LLM prompts (e.g. headline summarization). They're side-effect
// transcripts from `claude -p` calls and have no value in the picker.
// Cached per file by mtime so we don't keep re-reading.
const INTERNAL_PROMPT_PREFIXES = [
  "You are titling a Claude Code conversation transcript",
  "You are summarizing this conversation",
];
const internalSessionCache = new Map(); // filePath -> { mtime, isInternal }

async function isInternalHeadlinePromptSession(file, mtime) {
  const cached = internalSessionCache.get(file);
  if (cached && cached.mtime === mtime) return cached.isInternal;
  let isInternal = false;
  try {
    const fh = await fsp.open(file, "r");
    try {
      // Only need the first few KB to find the first user message.
      const buf = Buffer.alloc(8192);
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      const head = buf.slice(0, bytesRead).toString("utf8");
      for (const line of head.split("\n")) {
        if (!line) continue;
        let o; try { o = JSON.parse(line); } catch { continue; }
        // `last-prompt` orphan records (no actual conversation, just the prompt
        // that was about to run) — flag if the prompt body matches our markers.
        if (o.type === "last-prompt" && typeof o.lastPrompt === "string") {
          if (INTERNAL_PROMPT_PREFIXES.some(p => o.lastPrompt.startsWith(p))) {
            isInternal = true;
          }
          break;
        }
        if (o.type !== "user" || !o.message) continue;
        const c = o.message.content;
        const text = typeof c === "string"
          ? c
          : Array.isArray(c) ? (c.find(p => p.type === "text")?.text || "") : "";
        if (INTERNAL_PROMPT_PREFIXES.some(p => text.startsWith(p))) {
          isInternal = true;
        }
        break;
      }
    } finally { await fh.close(); }
  } catch {}
  internalSessionCache.set(file, { mtime, isInternal });
  return isInternal;
}

// session-id -> Set<res> of SSE listeners
const sessionListeners = new Map();
// session-id -> fs.FSWatcher
const watchers = new Map();
// SSE listeners for "session list changed" events
const sessionListListeners = new Set();

const STATIC_FILES = {
  "/marked.min.js": ["marked.min.js", "application/javascript; charset=utf-8"],
  "/highlight.min.js": ["highlight.min.js", "application/javascript; charset=utf-8"],
  "/diff.min.js": ["diff.min.js", "application/javascript; charset=utf-8"],
  "/highlight-github-dark.css": ["highlight-github-dark.css", "text/css; charset=utf-8"],
  "/highlight-github.css": ["highlight-github.css", "text/css; charset=utf-8"],
};

// Serve the HTML page with strict no-cache + asset URL cache-busting.
// Every <script src="…js"> and <link href="…css"> gets a ?v=<version> appended
// using the server-start timestamp so browsers can't load stale JS/CSS.
function servePage(res) {
  fs.readFile(path.join(__dirname, "page.html"), "utf8", (err, html) => {
    if (err) { res.writeHead(404); res.end("not found"); return; }
    const versioned = html
      .replace(/(<script[^>]+src=")(\/[^"]+\.js)(")/g, `$1$2?v=${SERVER_VERSION}$3`)
      .replace(/(<link[^>]+href=")(\/[^"]+\.css)(")/g, `$1$2?v=${SERVER_VERSION}$3`);
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      "Pragma": "no-cache",
      "Expires": "0",
      "X-Server-Version": SERVER_VERSION,
    });
    res.end(versioned);
  });
}

async function listSessions() {
  const sessions = [];
  let projects;
  try { projects = await fsp.readdir(PROJECTS_DIR, { withFileTypes: true }); }
  catch { return sessions; }

  for (const p of projects) {
    if (!p.isDirectory()) continue;
    const dir = path.join(PROJECTS_DIR, p.name);
    let files;
    try { files = await fsp.readdir(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const full = path.join(dir, f);
      let st;
      try { st = await fsp.stat(full); } catch { continue; }
      // Skip transcripts that are byproducts of our own LLM prompts.
      if (await isInternalHeadlinePromptSession(full, st.mtimeMs)) continue;
      const id = f.replace(/\.jsonl$/, "");
      const project = p.name;
      const meta = await sessionPreview(full, st.mtimeMs);
      const pin = pinsStore.get(id);
      sessions.push({
        id,
        project,
        path: full,
        mtime: st.mtimeMs,
        size: st.size,
        messageCount: meta.messageCount,
        preview: meta.preview,
        headlineSource: meta.headlineSource || "auto",
        firstMessageAt: meta.firstMessageAt,
        lastMessageAt: meta.lastMessageAt,
        cwd: meta.cwd,
        pinned: !!pin,
        pinnedAt: pin ? pin.pinnedAt : null,
      });
    }
  }
  // Most-recent first
  sessions.sort((a, b) => b.mtime - a.mtime);
  return sessions;
}

// In-memory cache of per-session metadata, keyed by file path. Each entry
// stores the source-file mtime — if the file hasn't been modified since the
// last scan, the cached metadata is reused without re-reading the JSONL.
// This is the difference between scanning 362MB on every /sessions call vs.
// only re-reading whichever file is currently being written to.
const sessionMetaCache = new Map();

// Strip Claude Code's wrapper tags/noise so the headline reflects the user's
// actual request, not transcript scaffolding.
function cleanForHeadline(raw) {
  if (!raw) return "";
  let t = String(raw);
  // BEFORE stripping tags, capture any slash command invocation and any
  // <command-args>. Sessions that start with `/skill .` would otherwise
  // collapse to empty after tag-stripping and fall through to system noise.
  let slashName = null;
  let cmdArgs = null;
  const nameMatch = t.match(/<command-name>\s*\/?([\w-]+)\s*<\/command-name>/i);
  if (nameMatch) slashName = nameMatch[1];
  const argsMatch = t.match(/<command-args>([\s\S]*?)<\/command-args>/i);
  if (argsMatch) cmdArgs = argsMatch[1].trim();
  // Remove paired tag blocks Claude Code injects around the user prompt.
  const blockTags = [
    "command-name", "command-message", "command-args",
    "local-command-stdout", "local-command-stderr",
    "bash-input", "bash-stdout", "bash-stderr",
    "system-reminder", "user-prompt-submit-hook",
    "user-memory-input",
  ];
  for (const tag of blockTags) {
    t = t.replace(new RegExp(`<${tag}[^>]*>[\\s\\S]*?</${tag}>`, "gi"), " ");
  }
  // Re-introduce the slash command as a leading token so the downstream
  // toHeadline() builds e.g. "/graphify" or "/graphify — arg" headlines.
  if (slashName) {
    const argTail = cmdArgs && cmdArgs !== "." ? " " + cmdArgs : "";
    t = `/${slashName}${argTail} ${t}`;
  }
  // Self-closing / orphan tags
  t = t.replace(/<\/?[a-z][\w-]*[^>]*>/gi, " ");
  // Pasted-content + image refs
  t = t.replace(/\[(?:Image|Pasted text)\s*#[^\]]*\]/gi, " ");
  // Caveat lines Claude Code prepends for `--continue` / resume runs.
  // Match anywhere, with optional leading whitespace; tolerate end-of-string.
  t = t.replace(/(?:^|\n)\s*Caveat:[^\n]*/gi, " ");
  return t.replace(/\s+/g, " ").trim();
}

const PREAMBLE_RE = /^(?:hi(?:\s+claude)?|hey(?:\s+claude)?|hello(?:\s+claude)?|yo|ok(?:ay)?|so|alright|please|pls|can\s+you(?:\s+please)?|could\s+you(?:\s+please)?|would\s+you|i\s+(?:want|need|would\s+like|'?d\s+like)\s+(?:you\s+)?to|let'?s|let\s+us|i\s+think\s+we\s+should)[\s,:!.-]+/i;

function toHeadline(text) {
  if (!text) return "";
  let t = text;
  // Strip a leading slash-command prefix but keep its name as a hint.
  let slashHint = "";
  const slashMatch = t.match(/^\/([\w-]+)\b\s*(.*)/);
  if (slashMatch) {
    slashHint = "/" + slashMatch[1];
    t = slashMatch[2] || "";
  }
  // Peel up to two preamble phrases ("hi claude, can you please ...").
  for (let i = 0; i < 2; i++) {
    const next = t.replace(PREAMBLE_RE, "");
    if (next === t) break;
    t = next;
  }
  t = t.trim();
  if (!t && slashHint) return slashHint;
  // First sentence-ish chunk, then first 10 words, capped at 72 chars.
  const sentence = t.split(/(?<=[.!?])\s+/)[0] || t;
  const allWords = sentence.split(/\s+/);
  const truncated = allWords.length > 10 || sentence.length > 72;
  const words = allWords.slice(0, 10).join(" ");
  let head = words.length > 72 ? words.slice(0, 69).trimEnd() : words;
  // Capitalize first letter unless it begins with a URL or code-ish token.
  const isUrlish = /^(https?:\/\/|www\.|\/|#|`)/i.test(head);
  if (head && /[a-z]/.test(head[0]) && !isUrlish) {
    head = head[0].toUpperCase() + head.slice(1);
  }
  if (truncated && !head.endsWith("…")) head = head.replace(/[.,;:!?]*$/, "") + "…";
  if (slashHint && !head.toLowerCase().startsWith(slashHint.toLowerCase())) {
    head = `${slashHint} — ${head}`;
  }
  return head;
}

function extractUserText(obj) {
  if (!obj || !obj.message) return "";
  const c = obj.message.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .filter(p => p && p.type === "text" && typeof p.text === "string")
      .map(p => p.text)
      .join("\n");
  }
  return "";
}

function sessionIdFromPath(file) {
  return path.basename(file).replace(/\.jsonl$/, "");
}

async function sessionPreview(file, fileMtime) {
  const cached = sessionMetaCache.get(file);
  if (cached && cached.cachedMtime === fileMtime) {
    // Always re-overlay the latest store value — user could have renamed
    // between requests without the file changing.
    const stored = headlinesStore.get(sessionIdFromPath(file));
    if (stored && stored.headline !== cached.preview) {
      return { ...cached, preview: stored.headline, headlineSource: stored.source };
    }
    return { ...cached, headlineSource: stored?.source || "auto" };
  }
  let raw;
  try { raw = await fsp.readFile(file, "utf8"); }
  catch {
    const empty = { messageCount: 0, preview: "", firstMessageAt: null, lastMessageAt: null, cwd: null, cachedMtime: fileMtime };
    sessionMetaCache.set(file, empty);
    return { ...empty, headlineSource: "auto" };
  }
  const lines = raw.split("\n").filter(Boolean);
  let count = 0;
  let autoHeadline = "";
  let firstMessageAt = null;
  let lastMessageAt = null;
  let cwd = null;
  for (const line of lines) {
    let obj; try { obj = JSON.parse(line); } catch { continue; }
    if (!cwd && typeof obj.cwd === "string" && obj.cwd) cwd = obj.cwd;
    if (obj.type !== "user" && obj.type !== "assistant") continue;
    count++;
    const ts = obj.timestamp ? Date.parse(obj.timestamp) : null;
    if (ts && !Number.isNaN(ts)) {
      if (firstMessageAt === null) firstMessageAt = ts;
      lastMessageAt = ts;
    }
    if (!autoHeadline && obj.type === "user") {
      const cleaned = cleanForHeadline(extractUserText(obj));
      // Require either 2+ words (skip single-word greetings) OR a slash
      // command (those are topical even when standalone, e.g. "/graphify").
      const isSlashOnly = cleaned.startsWith("/") && /^\/[\w-]+/.test(cleaned);
      if (cleaned && (cleaned.split(/\s+/).length >= 2 || isSlashOnly)) {
        autoHeadline = toHeadline(cleaned);
      }
    }
  }
  const id = sessionIdFromPath(file);
  const stored = headlinesStore.get(id);
  let preview;
  let headlineSource;
  // Anything stored at higher priority than "auto" (user, asana, etc.) wins
  // outright over a freshly-extracted headline.
  if (stored && sourceRank(stored.source) > sourceRank("auto")) {
    preview = stored.headline;
    headlineSource = stored.source;
  } else if (autoHeadline) {
    preview = autoHeadline;
    headlineSource = "auto";
    setHeadline(id, autoHeadline, "auto");
  } else if (stored) {
    preview = stored.headline;
    headlineSource = stored.source;
  } else {
    preview = "";
    headlineSource = "auto";
  }
  const result = { messageCount: count, preview, firstMessageAt, lastMessageAt, cwd, cachedMtime: fileMtime };
  sessionMetaCache.set(file, result);
  return { ...result, headlineSource };
}

async function searchAcrossSessions(query, limit) {
  const all = await listSessions();
  const needle = query.toLowerCase();

  // Read every session in parallel. Capped by Promise.all concurrency
  // (Node handles this fine; OS does the actual scheduling).
  const reads = await Promise.all(all.map(async (s) => {
    try { return { s, raw: await fsp.readFile(s.path, "utf8") }; }
    catch { return { s, raw: "" }; }
  }));

  // Sort by mtime desc so newest sessions surface first
  reads.sort((a, b) => b.s.mtime - a.s.mtime);

  const matches = [];
  for (const { s, raw } of reads) {
    if (matches.length >= limit) break;
    if (!raw) continue;
    // Fast-path: if the needle isn't anywhere in the raw text, skip entirely.
    if (!raw.toLowerCase().includes(needle)) continue;
    const lines = raw.split("\n");
    let msgIdx = -1;
    for (const line of lines) {
      if (!line) continue;
      let obj; try { obj = JSON.parse(line); } catch { continue; }
      if (obj.type !== "user" && obj.type !== "assistant") continue;
      msgIdx++;
      const msg = obj.message;
      if (!msg) continue;
      const parts = Array.isArray(msg.content) ? msg.content : [{ type: "text", text: msg.content }];
      for (const part of parts) {
        const text = part.type === "text" ? (part.text || "")
          : part.type === "thinking" ? (part.thinking || "")
          : "";
        if (!text) continue;
        const idx = text.toLowerCase().indexOf(needle);
        if (idx === -1) continue;
        const start = Math.max(0, idx - 80);
        const end = Math.min(text.length, idx + needle.length + 80);
        const snippet = (start > 0 ? "…" : "") + text.slice(start, end).replace(/\s+/g, " ").trim() + (end < text.length ? "…" : "");
        matches.push({
          sessionId: s.id,
          project: s.project,
          msgIdx,
          role: msg.role || obj.type,
          snippet,
          timestamp: obj.timestamp || null,
          preview: s.preview,
          mtime: s.mtime,
        });
        if (matches.length >= limit) break;
      }
      if (matches.length >= limit) break;
    }
  }
  return matches;
}

async function readTranscript(sessionId) {
  if (!sessionId) return { session: null, messages: [], usage: [] };
  // Locate file by id
  const all = await listSessions();
  const found = all.find(s => s.id === sessionId);
  if (!found) return { session: null, messages: [], usage: [] };

  let raw;
  try { raw = await fsp.readFile(found.path, "utf8"); }
  catch { return { session: sessionId, messages: [], usage: [] }; }

  const lines = raw.split("\n").filter(Boolean);
  const messages = [];
  const usage = []; // one entry per assistant turn that reports usage
  for (const line of lines) {
    let obj; try { obj = JSON.parse(line); } catch { continue; }
    if (obj.type !== "user" && obj.type !== "assistant") continue;
    const msg = obj.message;
    if (!msg) continue;
    const content = Array.isArray(msg.content)
      ? msg.content
      : [{ type: "text", text: typeof msg.content === "string" ? msg.content : "" }];
    messages.push({
      role: msg.role || obj.type,
      timestamp: obj.timestamp || null,
      content,
    });
    if (obj.type === "assistant" && msg.usage) {
      const u = msg.usage;
      const input = Number(u.input_tokens) || 0;
      const cacheCreation = Number(u.cache_creation_input_tokens) || 0;
      const cacheRead = Number(u.cache_read_input_tokens) || 0;
      const output = Number(u.output_tokens) || 0;
      usage.push({
        msgIdx: messages.length - 1,
        timestamp: obj.timestamp || null,
        input, cacheCreation, cacheRead, output,
        contextSize: input + cacheCreation + cacheRead, // input-side budget at this turn
        totalInOut: input + cacheCreation + cacheRead + output,
      });
    }
  }
  return { session: sessionId, project: found.project, messages, usage };
}

// Per-session debounce timers — coalesce rapid appends into a single broadcast.
const sessionDebounces = new Map();
// Track last seen user/assistant message count per file so we only broadcast
// when actual conversation messages change — not every time the JSONL is
// touched by attachment/permission-mode/ai-title metadata writes.
const lastConvCount = new Map();

async function recomputeMessageCount(file) {
  try {
    const raw = await fsp.readFile(file, "utf8");
    let count = 0;
    for (const line of raw.split("\n")) {
      if (!line) continue;
      let obj; try { obj = JSON.parse(line); } catch { continue; }
      if (obj.type === "user" || obj.type === "assistant") count++;
    }
    return count;
  } catch { return null; }
}

function ensureWatcher(sessionId, file) {
  if (watchers.has(sessionId)) return;
  // fs.watchFile (polling) is dramatically more reliable than fs.watch on
  // macOS — fs.watch silently stops firing after long uptimes or after the
  // file is touched in certain ways. Polling at 1s adds negligible CPU.
  const listener = (curr, prev) => {
    if (curr.mtimeMs === prev.mtimeMs) return;
    clearTimeout(sessionDebounces.get(sessionId));
    sessionDebounces.set(sessionId, setTimeout(async () => {
      // Only broadcast if the conversation actually grew, not just metadata.
      const newCount = await recomputeMessageCount(file);
      const prevCount = lastConvCount.get(file);
      if (newCount === null) return;
      if (prevCount !== undefined && newCount === prevCount) return;
      lastConvCount.set(file, newCount);
      broadcast(sessionId, "update", { ts: Date.now(), messageCount: newCount });
    }, 300));
  };
  try {
    fs.watchFile(file, { interval: 1000, persistent: false }, listener);
    watchers.set(sessionId, {
      unwatch: () => { try { fs.unwatchFile(file, listener); } catch {} },
    });
    // Seed the count so first real change is correctly detected
    recomputeMessageCount(file).then(c => { if (c !== null) lastConvCount.set(file, c); });
  } catch (err) {
    console.error("watchFile failed for", sessionId, err.message);
  }
}

function broadcast(sessionId, event, data) {
  const set = sessionListeners.get(sessionId);
  if (!set) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of set) {
    try { res.write(payload); } catch {}
  }
}

function broadcastSessionListChange() {
  const payload = `event: session-list-change\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`;
  // Fan out to per-session listeners too — so each tab only needs ONE SSE
  // connection (not two), avoiding Chrome's 6-per-origin connection limit.
  for (const set of sessionListeners.values()) {
    for (const res of set) {
      try { res.write(payload); } catch {}
    }
  }
  for (const res of sessionListListeners) {
    try { res.write(payload); } catch {}
  }
}

// Watch the projects directory recursively so the picker reflects newly
// opened Claude Code sessions within ~500ms instead of waiting for the
// client-side poll. Debounced to coalesce burst writes.
let sessionListDebounce = null;
try {
  fs.watch(PROJECTS_DIR, { recursive: true }, (_event, filename) => {
    if (!filename || !filename.endsWith(".jsonl")) return;
    clearTimeout(sessionListDebounce);
    sessionListDebounce = setTimeout(broadcastSessionListChange, 500);
  });
} catch (err) {
  console.error("[response-viewer] projects-dir watcher failed:", err.message);
}

function serveStatic(res, fileName, contentType) {
  fs.readFile(path.join(__dirname, fileName), (err, data) => {
    if (err) { res.writeHead(404); res.end("not found"); return; }
    res.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-store" });
    res.end(data);
  });
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req, limit = 65536) {
  return new Promise((resolve, reject) => {
    let buf = "";
    let size = 0;
    req.setEncoding("utf8");
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { req.destroy(); reject(new Error("body too large")); return; }
      buf += c;
    });
    req.on("end", () => resolve(buf));
    req.on("error", reject);
  });
}

// Same shaping rules as auto-extraction so the picker stays visually consistent
// — collapse whitespace, cap to 80 chars, no newlines in the title bar.
function normalizeUserHeadline(s) {
  if (!s) return "";
  let t = String(s).replace(/\s+/g, " ").trim();
  if (t.length > 80) t = t.slice(0, 77).trimEnd() + "…";
  return t;
}

// ----------------------------------------------------------------------------
// LLM-generated headlines (one-time per session; persisted)
// Shell out to `claude -p --model haiku` so the user's existing subscription
// is used — no API key required. Sends a tight excerpt of the conversation
// (first 2 user messages + most recent exchange) to keep cost negligible.
// ----------------------------------------------------------------------------
function pickUserText(obj) {
  if (!obj || !obj.message) return "";
  const c = obj.message.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .filter(p => p && p.type === "text" && typeof p.text === "string")
      .map(p => p.text)
      .join(" ");
  }
  return "";
}

async function buildConversationExcerpt(file) {
  const raw = await fsp.readFile(file, "utf8");
  const lines = raw.split("\n").filter(Boolean);
  const userMsgs = [];
  const assistantMsgs = [];
  for (const line of lines) {
    let obj; try { obj = JSON.parse(line); } catch { continue; }
    if (obj.type !== "user" && obj.type !== "assistant") continue;
    const txt = pickUserText(obj).replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (!txt) continue;
    if (obj.type === "user") userMsgs.push(txt);
    else assistantMsgs.push(txt);
  }
  const trunc = (s, n) => s.length > n ? s.slice(0, n) + "…" : s;
  const parts = [];
  if (userMsgs[0]) parts.push(`User opening: ${trunc(userMsgs[0], 600)}`);
  if (userMsgs[1]) parts.push(`User follow-up: ${trunc(userMsgs[1], 400)}`);
  if (userMsgs.length > 3 && userMsgs[userMsgs.length - 1] !== userMsgs[0]) {
    parts.push(`User latest: ${trunc(userMsgs[userMsgs.length - 1], 400)}`);
  }
  if (assistantMsgs[assistantMsgs.length - 1]) {
    parts.push(`Assistant latest excerpt: ${trunc(assistantMsgs[assistantMsgs.length - 1], 400)}`);
  }
  return parts.join("\n\n");
}

function runClaudePrompt(prompt, { timeoutMs = 45000 } = {}) {
  return new Promise((resolve, reject) => {
    // --no-session-persistence: these are one-shot summarization calls; do
    // NOT save them to ~/.claude/projects/ where they'd clutter the picker.
    const cp = spawn("claude", ["-p", "--no-session-persistence", "--model", "haiku"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    let out = "";
    let err = "";
    const t = setTimeout(() => {
      try { cp.kill("SIGTERM"); } catch {}
      reject(new Error("claude -p timeout after " + timeoutMs + "ms"));
    }, timeoutMs);
    cp.stdout.on("data", (c) => out += c.toString());
    cp.stderr.on("data", (c) => err += c.toString());
    cp.on("error", (e) => { clearTimeout(t); reject(e); });
    cp.on("close", (code) => {
      clearTimeout(t);
      if (code !== 0) {
        reject(new Error(`claude -p exited ${code}: ${err.slice(0, 300)}`));
        return;
      }
      resolve(out);
    });
    cp.stdin.write(prompt);
    cp.stdin.end();
  });
}

const LLM_HEADLINE_PROMPT = `You are titling a Claude Code conversation transcript. Read the excerpt below and produce a single concise topic title.

Rules:
- 5 to 10 words
- Capture the MAIN subject of the conversation, not just the opening line
- No quotes, no trailing period, no Markdown
- No prefix like "Title:" or "Topic:"
- Output the title and nothing else

Excerpt:
{EXCERPT}

Title:`;

async function generateLLMHeadline(file) {
  const excerpt = await buildConversationExcerpt(file);
  if (!excerpt) throw new Error("empty excerpt");
  const prompt = LLM_HEADLINE_PROMPT.replace("{EXCERPT}", excerpt);
  const raw = await runClaudePrompt(prompt);
  // Strip common LLM artifacts: leading "Title:", quotes, surrounding whitespace.
  let title = String(raw)
    .replace(/^\s*Title\s*:\s*/i, "")
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\.\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
  // Take the first line only — defensive against the model adding commentary.
  title = title.split(/\n+/)[0].trim();
  return normalizeUserHeadline(title);
}

// Small HTTP GET helper for proxying to the agentation MCP on localhost:4747.
function fetchAgentation(pathOnAgentation) {
  return new Promise((resolve, reject) => {
    const req = http.get({
      hostname: "localhost",
      port: 4747,
      path: pathOnAgentation,
      timeout: 5000,
    }, (resp) => {
      let buf = "";
      resp.setEncoding("utf8");
      resp.on("data", (c) => buf += c);
      resp.on("end", () => {
        try { resolve(JSON.parse(buf)); }
        catch (e) { reject(new Error("invalid json from agentation: " + e.message)); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(new Error("agentation timeout")); });
  });
}

async function handle(req, res) {
  const url = new URL(req.url, "http://localhost");
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (url.pathname === "/" || url.pathname === "/index.html") {
    return servePage(res);
  }
  if (STATIC_FILES[url.pathname]) {
    const [file, type] = STATIC_FILES[url.pathname];
    return serveStatic(res, file, type);
  }
  // Stub favicon to suppress the 404 noise in browser console.
  if (url.pathname === "/favicon.ico") {
    res.writeHead(204, { "Cache-Control": "public, max-age=86400" });
    res.end();
    return;
  }
  // Version endpoint so the page can detect a server-side redeploy if needed.
  if (url.pathname === "/version") {
    return json(res, 200, { version: SERVER_VERSION });
  }

  if (url.pathname === "/sessions") {
    const sessions = await listSessions();
    return json(res, 200, { sessions });
  }

  // LLM-generated headline (single session). Body: { id }. Returns the new
  // headline and stores it with source="llm". Skips if the stored value is
  // already user- or asana-sourced (those outrank llm).
  if (url.pathname === "/headlines/llm" && req.method === "POST") {
    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch { return json(res, 400, { error: "invalid json body" }); }
    const id = String(body.id || "").trim();
    if (!id) return json(res, 400, { error: "id required" });
    const all = await listSessions();
    const found = all.find(s => s.id === id);
    if (!found) return json(res, 404, { error: "session not found" });
    const existing = headlinesStore.get(id);
    if (existing && sourceRank(existing.source) > sourceRank("llm")) {
      return json(res, 200, {
        id,
        headline: existing.headline,
        source: existing.source,
        skipped: true,
        reason: `outranked by ${existing.source}`,
      });
    }
    try {
      const headline = await generateLLMHeadline(found.path);
      if (!headline) return json(res, 502, { error: "empty headline from model" });
      setHeadline(id, headline, "llm");
      // Bust per-file meta cache so /sessions sees the new value immediately.
      for (const [filePath, entry] of sessionMetaCache) {
        if (sessionIdFromPath(filePath) === id) {
          sessionMetaCache.set(filePath, { ...entry, preview: headline });
        }
      }
      broadcastSessionListChange();
      return json(res, 200, { id, headline, source: "llm" });
    } catch (err) {
      return json(res, 502, { error: "llm failed: " + err.message });
    }
  }

  // Batch LLM regeneration with SSE progress. Query param ?filter=auto (only
  // sessions currently with auto headline — the default and safest), or =all
  // (re-title everything except user-set ones; asana stays).
  if (url.pathname === "/headlines/llm/batch") {
    const filter = url.searchParams.get("filter") || "auto";
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const send = (event, data) => {
      try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch {}
    };
    const all = await listSessions();
    const targets = all.filter(s => {
      const stored = headlinesStore.get(s.id);
      if (filter === "all") {
        // Re-title everything except user-protected entries
        return !stored || stored.source !== "user";
      }
      // Default: only sessions whose current preview is auto-extracted
      return !stored || stored.source === "auto";
    });
    send("start", { total: targets.length, filter });
    let done = 0, succeeded = 0, failed = 0;
    // Serial — claude -p is rate-limited per account; parallel would back up.
    for (const s of targets) {
      done++;
      send("progress", { done, total: targets.length, id: s.id, status: "generating" });
      try {
        const headline = await generateLLMHeadline(s.path);
        if (headline) {
          setHeadline(s.id, headline, "llm");
          for (const [filePath, entry] of sessionMetaCache) {
            if (sessionIdFromPath(filePath) === s.id) {
              sessionMetaCache.set(filePath, { ...entry, preview: headline });
            }
          }
          send("progress", { done, total: targets.length, id: s.id, status: "done", headline });
          succeeded++;
        } else {
          send("progress", { done, total: targets.length, id: s.id, status: "empty" });
          failed++;
        }
      } catch (err) {
        send("progress", { done, total: targets.length, id: s.id, status: "error", error: err.message });
        failed++;
      }
    }
    broadcastSessionListChange();
    send("complete", { total: targets.length, succeeded, failed });
    res.end();
    return;
  }

  // Persistent user pins. GET returns the whole map (id -> {pinnedAt}).
  // POST /pins/toggle with {id} flips the pin state and broadcasts a
  // session-list-change so all open Atlas tabs re-render the rail.
  if (url.pathname === "/pins" && req.method === "GET") {
    return json(res, 200, { pins: Object.fromEntries(pinsStore) });
  }
  if (url.pathname === "/pins/toggle" && req.method === "POST") {
    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch { return json(res, 400, { error: "invalid json body" }); }
    const id = String(body.id || "").trim();
    if (!id) return json(res, 400, { error: "id required" });
    let pinned;
    if (pinsStore.has(id)) {
      pinsStore.delete(id);
      pinned = false;
    } else {
      pinsStore.set(id, { pinnedAt: Date.now() });
      pinned = true;
    }
    markPinsDirty();
    broadcastSessionListChange();
    return json(res, 200, { id, pinned, pinnedAt: pinsStore.get(id)?.pinnedAt || null });
  }

  // Persistent headlines: GET the whole store, POST {id, headline} to set a
  // user-named title, DELETE ?id=... to revert to auto-extract.
  if (url.pathname === "/headlines") {
    if (req.method === "GET") {
      return json(res, 200, { headlines: Object.fromEntries(headlinesStore) });
    }
    if (req.method === "POST") {
      let body;
      try { body = JSON.parse(await readBody(req)); }
      catch { return json(res, 400, { error: "invalid json body" }); }
      const id = String(body.id || "").trim();
      const headline = normalizeUserHeadline(body.headline);
      const source = HEADLINE_SOURCES.includes(body.source) ? body.source : "user";
      if (!id) return json(res, 400, { error: "id required" });
      if (!headline) return json(res, 400, { error: "headline required" });
      setHeadline(id, headline, source);
      const finalSource = headlinesStore.get(id)?.source || source;
      // Invalidate the per-file meta cache so /sessions reflects the change
      // without waiting for the JSONL mtime to bump.
      for (const [filePath, entry] of sessionMetaCache) {
        if (sessionIdFromPath(filePath) === id) {
          sessionMetaCache.set(filePath, { ...entry, preview: headlinesStore.get(id)?.headline || headline });
        }
      }
      broadcastSessionListChange();
      return json(res, 200, { id, headline: headlinesStore.get(id)?.headline || headline, source: finalSource });
    }
    if (req.method === "DELETE") {
      const id = url.searchParams.get("id");
      if (!id) return json(res, 400, { error: "id query param required" });
      headlinesStore.delete(id);
      markHeadlinesDirty();
      for (const [filePath, entry] of sessionMetaCache) {
        if (sessionIdFromPath(filePath) === id) {
          sessionMetaCache.delete(filePath);
        }
      }
      broadcastSessionListChange();
      return json(res, 200, { id, reset: true });
    }
    return json(res, 405, { error: "method not allowed" });
  }

  // Proxy + filter for sent annotations belonging to a given Claude Code
  // session. Walks agentation's session list, finds ones tagged with our
  // cc_session, and fetches each session's annotations (which include the
  // `thread` field with Claude's replies).
  if (url.pathname === "/annotations-for-session") {
    const ccSession = url.searchParams.get("session");
    if (!ccSession) return json(res, 400, { error: "session query param required" });
    try {
      const sessions = await fetchAgentation("/sessions");
      const matches = (sessions || []).filter(s =>
        typeof s.url === "string" && s.url.includes(`cc_session=${ccSession}`)
      );
      const all = [];
      for (const ms of matches) {
        try {
          const details = await fetchAgentation(`/sessions/${ms.id}`);
          for (const ann of (details.annotations || [])) {
            all.push({ ...ann, agentationSessionId: ms.id, agentationSessionUrl: ms.url });
          }
        } catch {}
      }
      all.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
      return json(res, 200, { annotations: all });
    } catch (err) {
      return json(res, 502, { error: "agentation unreachable: " + err.message });
    }
  }

  if (url.pathname === "/search") {
    const q = (url.searchParams.get("q") || "").trim();
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "100", 10) || 100, 500);
    if (!q || q.length < 2) {
      return json(res, 200, { query: q, matches: [] });
    }
    const matches = await searchAcrossSessions(q, limit);
    return json(res, 200, { query: q, matches });
  }

  if (url.pathname === "/transcript") {
    let sessionId = url.searchParams.get("session");
    if (!sessionId) {
      const all = await listSessions();
      sessionId = all[0]?.id || null;
    }
    const data = await readTranscript(sessionId);
    // Lazy: ensure watcher on this file
    if (data.session) {
      const all = await listSessions();
      const found = all.find(s => s.id === data.session);
      if (found) ensureWatcher(data.session, found.path);
    }
    return json(res, 200, data);
  }

  if (url.pathname === "/sessions-events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(`event: hello\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);
    sessionListListeners.add(res);
    const keepalive = setInterval(() => {
      try { res.write(":keepalive\n\n"); } catch {}
    }, 25000);
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearInterval(keepalive);
      sessionListListeners.delete(res);
    };
    req.on("close", cleanup);
    req.on("aborted", cleanup);
    res.on("close", cleanup);
    res.on("finish", cleanup);
    return;
  }

  if (url.pathname === "/debug") {
    const watcherCount = watchers.size;
    let sessionListenerTotal = 0;
    const perSession = {};
    for (const [sid, set] of sessionListeners) {
      sessionListenerTotal += set.size;
      perSession[sid] = set.size;
    }
    return json(res, 200, {
      version: SERVER_VERSION,
      uptime_seconds: Math.round(process.uptime()),
      watchers: watcherCount,
      session_listeners_total: sessionListenerTotal,
      session_listeners_per_session: perSession,
      session_list_listeners: sessionListListeners.size,
      cached_session_metas: sessionMetaCache.size,
    });
  }

  if (url.pathname === "/events") {
    const sessionId = url.searchParams.get("session");
    if (!sessionId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "session query param required" }));
      return;
    }
    // Ensure watcher
    const all = await listSessions();
    const found = all.find(s => s.id === sessionId);
    if (found) ensureWatcher(sessionId, found.path);

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(`event: hello\ndata: ${JSON.stringify({ session: sessionId, ts: Date.now() })}\n\n`);
    if (!sessionListeners.has(sessionId)) sessionListeners.set(sessionId, new Set());
    sessionListeners.get(sessionId).add(res);

    const keepalive = setInterval(() => {
      try { res.write(":keepalive\n\n"); } catch {}
    }, 25000);
    // Listen on BOTH events — Node's http occasionally fires only one of them
    // depending on how the connection was severed. Idempotent cleanup.
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearInterval(keepalive);
      sessionListeners.get(sessionId)?.delete(res);
    };
    req.on("close", cleanup);
    req.on("aborted", cleanup);
    res.on("close", cleanup);
    res.on("finish", cleanup);
    return;
  }

  res.writeHead(404); res.end("not found");
}

const server = http.createServer(handle);
server.listen(PORT, "127.0.0.1", async () => {
  console.log(`response-viewer on http://localhost:${PORT}`);
});
