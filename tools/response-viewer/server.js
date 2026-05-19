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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 4850;
const PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");
// Bumped on every server start — used to cache-bust browser-side assets so a
// stale tab never loads old JS/CSS after a redeploy.
const SERVER_VERSION = Date.now().toString(36);

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
      const id = f.replace(/\.jsonl$/, "");
      const project = p.name;
      const meta = await sessionPreview(full, st.mtimeMs);
      sessions.push({
        id,
        project,
        path: full,
        mtime: st.mtimeMs,
        size: st.size,
        messageCount: meta.messageCount,
        preview: meta.preview,
        firstMessageAt: meta.firstMessageAt,
        lastMessageAt: meta.lastMessageAt,
        cwd: meta.cwd,
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

async function sessionPreview(file, fileMtime) {
  const cached = sessionMetaCache.get(file);
  if (cached && cached.cachedMtime === fileMtime) {
    return cached;
  }
  let raw;
  try { raw = await fsp.readFile(file, "utf8"); }
  catch {
    const empty = { messageCount: 0, preview: "", firstMessageAt: null, lastMessageAt: null, cwd: null, cachedMtime: fileMtime };
    sessionMetaCache.set(file, empty);
    return empty;
  }
  const lines = raw.split("\n").filter(Boolean);
  let count = 0;
  let preview = "";
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
    if (!preview && obj.type === "user" && obj.message) {
      const c = obj.message.content;
      const text = typeof c === "string"
        ? c
        : Array.isArray(c) ? (c.find(p => p.type === "text")?.text || "") : "";
      preview = text.replace(/\s+/g, " ").trim().slice(0, 80);
    }
  }
  const result = { messageCount: count, preview, firstMessageAt, lastMessageAt, cwd, cachedMtime: fileMtime };
  sessionMetaCache.set(file, result);
  return result;
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
