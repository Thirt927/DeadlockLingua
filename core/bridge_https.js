// Babel Tower - https panel channel: the loopback TLS terminator.
//
// Why this is a separate process (not part of core/bridge_server.js):
//   - the bridge keeps the invariant "exactly one listen() in the whole bridge";
//   - a missing/expired certificate or a failed TLS handshake must never take down
//     BTIPC, which is the only zero-friction download channel we have.
//
// What it does: terminate TLS on the two loopback addresses and reverse-proxy ONLY
//   GET/POST /bridge       ->  http://127.0.0.1:<upstream>
//   GET/POST /api/v1/*     ->  http://127.0.0.1:<upstream>
// Method, path, query, body, status code and end-to-end response headers are kept and
// the body is streamed (never buffered as a whole). Everything else is 404.
//
// Security:
//   - binds loopback only (127.0.0.1 and ::1), never a wildcard address;
//   - no authentication (it exists so the engine's certificate check can pass, it is
//     not an external attack surface);
//   - no arbitrary URL proxying: the upstream host is a fixed loopback address and
//     only the two route families above are forwarded;
//   - request bodies are never logged (they can contain raw chat text). Chat text in
//     the query string is redacted too.
//
// Exit codes (the launcher uses code 3 to skip this channel, not as a failure):
//   0  normal shutdown / https.enabled=false in --config
//   1  neither loopback listener could bind
//   2  bad command line
//   3  certificate missing/unreadable/passphrase wrong -> skip the https channel
//
// Usage:
//   node core/bridge_https.js [--port 8792] [--upstream 8791] [--pfx <file>]
//        [--pass-file <file>] [--log <file>] [--timeout <ms>] [--config <config.json>]
//
// --config reads the "https" section: { enabled, port, pfx, passFile, timeoutMs }.
// Explicit CLI flags win over the config file. Relative paths are resolved against the
// repository root (the directory containing core/), which is also where the default
// locations config/certs/bridge.pfx, config/certs/bridge.pass and
// logs/bridge_https.log live. The timeout defaults to 10s; pass a larger value (e.g.
// --timeout 30000) when the upstream bridge's provider timeout is longer, so a slow
// translation is not reported as bridge_down.
"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const tls = require("tls");

const ROOT = path.resolve(__dirname, "..");

const DEFAULT_PORT = 8792;
const DEFAULT_UPSTREAM = 8791;
const DEFAULT_PFX = path.join("config", "certs", "bridge.pfx");
const DEFAULT_PASS_FILE = path.join("config", "certs", "bridge.pass");
const DEFAULT_LOG = path.join("logs", "bridge_https.log");
const DEFAULT_TIMEOUT_MS = 10000;

// Never logged/forwarded: hop-by-hop headers belong to one connection only.
const REQ_HOP_BY_HOP = new Set([
  "host", "connection", "keep-alive", "proxy-connection", "transfer-encoding",
  "upgrade", "te", "trailer", "proxy-authenticate", "proxy-authorization",
]);
const RES_HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-connection", "transfer-encoding",
  "upgrade", "trailer",
]);

// ---------------------------------------------------------------------------
// Logging: local time, one line per event, file + stdout.
// Format: [YYYY-MM-DD HH:MM:SS] [level] msg
// The upstream project once used toISOString() here and the two log files ended up
// 8 hours apart, which caused a real mis-diagnosis. Local time is required.
// ---------------------------------------------------------------------------

let logFilePath = null;

function localTimestamp(d) {
  const pad = (n) => (n < 10 ? "0" + n : String(n));
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
    " " + pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
}

function log(level, msg) {
  const line = "[" + localTimestamp(new Date()) + "] [" + level + "] " + msg;
  try {
    console.log(line);
  } catch (e) {}
  if (!logFilePath) return;
  try {
    fs.appendFileSync(logFilePath, line + "\n", "utf8");
  } catch (e) {
    // A broken log file must never take the channel down.
  }
}

function setupLogFile(p) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    logFilePath = p;
    return true;
  } catch (e) {
    logFilePath = null;
    log("warn", "cannot open log file " + p + " (" + ((e && e.code) || String(e)) + "); logging to stdout only");
    return false;
  }
}

// Chat text may arrive in /bridge?text=... . Keep the request line useful for
// debugging (op/id/win) but never write raw chat content to disk.
function redactUrl(url) {
  let search = url.search || "";
  if (search) {
    search = search.replace(/([?&]text=)[^&]*/gi, "$1<redacted>");
  }
  let out = url.pathname + search;
  if (out.length > 300) out = out.slice(0, 300) + "...";
  return out;
}

function logRequest(method, url, status, startedAt) {
  log("info", "REQ " + method + " " + redactUrl(url) + " -> " + status + " " + (Date.now() - startedAt) + "ms");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function usage() {
  return [
    "Usage: node core/bridge_https.js [options]",
    "",
    "Options:",
    "  --port <n>         TLS port to listen on (default 8792)",
    "  --upstream <n>     loopback http bridge port to proxy to (default 8791)",
    "  --pfx <file>       PKCS#12 certificate bundle (default config/certs/bridge.pfx)",
    "  --pass-file <file> file containing the PFX passphrase (default config/certs/bridge.pass)",
    "  --log <file>       log file (default logs/bridge_https.log)",
    "  --timeout <ms>     upstream timeout; on expiry reply 502 (default 10000)",
    "  --config <file>    read the \"https\" section {enabled,port,pfx,passFile,timeoutMs} from this JSON file",
    "  --help             print this text",
  ].join("\n");
}

function parseArgs(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      values.help = true;
      continue;
    }
    const m = /^--([a-z][a-z0-9-]*)(?:=(.*))?$/.exec(arg);
    if (!m) {
      values.unknown = values.unknown || [];
      values.unknown.push(arg);
      continue;
    }
    const name = m[1];
    let value = m[2];
    if (value === undefined) {
      const next = argv[i + 1];
      if (next === undefined || (next.charAt(0) === "-" && next !== "-")) {
        values.bad = values.bad || [];
        values.bad.push(arg);
        continue;
      }
      value = next;
      i += 1;
    }
    const key = name.replace(/-([a-z])/g, (s, c) => c.toUpperCase());
    values[key] = value;
  }
  return values;
}

function resolvePath(p) {
  if (!p) return null;
  return path.isAbsolute(p) ? path.normalize(p) : path.resolve(ROOT, p);
}

function toPort(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return NaN;
  return n;
}

function toPositiveInt(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) return NaN;
  return n;
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

function sendText(res, status, text) {
  const body = Buffer.from(text, "utf8");
  try {
    res.writeHead(status, {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Length": body.length,
      "Cache-Control": "no-store",
    });
    res.end(body);
  } catch (e) {
    try { res.destroy(); } catch (e2) {}
  }
}

function makeHandler(upstreamPort, upstreamTimeoutMs) {
  return function handler(req, res) {
    const startedAt = Date.now();
    let url;
    try {
      url = new URL(req.url || "/", "https://127.0.0.1");
    } catch (e) {
      sendText(res, 400, "bad request");
      return;
    }

    let logged = false;
    function finishLog(status) {
      if (logged) return;
      logged = true;
      logRequest(req.method, url, status, startedAt);
    }

    const pathname = url.pathname;
    const allowed = pathname === "/bridge" || pathname.indexOf("/api/v1/") === 0;

    if (!allowed) {
      // Unknown path: do not touch the upstream, do not proxy arbitrary URLs.
      sendText(res, 404, "not found");
      finishLog(404);
      return;
    }
    if (req.method !== "GET" && req.method !== "POST") {
      sendText(res, 405, "method not allowed");
      finishLog(405);
      return;
    }

    const headers = {};
    for (const key of Object.keys(req.headers)) {
      const lower = key.toLowerCase();
      if (REQ_HOP_BY_HOP.has(lower)) continue;
      headers[lower] = req.headers[key];
    }
    headers.host = "127.0.0.1:" + upstreamPort;

    // agent:false -> a fresh connection per request. That keeps the channel
    // self-healing (a restarted bridge is picked up immediately) and makes a dead
    // upstream fail fast with ECONNREFUSED instead of sitting in a stale keep-alive
    // socket.
    const upstreamReq = http.request({
      host: "127.0.0.1",
      port: upstreamPort,
      method: req.method,
      path: pathname + (url.search || ""),
      headers: headers,
      agent: false,
    }, (upstreamRes) => {
      const outHeaders = {};
      for (const key of Object.keys(upstreamRes.headers)) {
        if (RES_HOP_BY_HOP.has(key.toLowerCase())) continue;
        outHeaders[key] = upstreamRes.headers[key];
      }
      try {
        res.writeHead(upstreamRes.statusCode || 502, outHeaders);
      } catch (e) {
        try { res.destroy(); } catch (e2) {}
        try { upstreamRes.destroy(); } catch (e2) {}
        finishLog(502);
        return;
      }
      upstreamRes.pipe(res);
      res.on("finish", () => finishLog(upstreamRes.statusCode || 502));
      res.on("close", () => {
        if (!res.writableFinished) finishLog(499); // client went away
      });
      upstreamRes.on("error", (e) => {
        log("warn", "upstream response error: " + ((e && e.message) || String(e)));
        try { res.destroy(); } catch (e2) {}
      });
    });

    let failed = false;
    function failUpstream(reason) {
      if (failed) return;
      failed = true;
      const code = (reason && reason.code) || "";
      const detail = code || (reason && reason.message) || String(reason);
      log("warn", "upstream unavailable (" + detail + ") for " + req.method + " " + pathname + "; replying 502 bridge_down");
      try { req.unpipe(upstreamReq); } catch (e) {}
      try { req.resume(); } catch (e) {}
      if (!res.headersSent) {
        const body = Buffer.from(JSON.stringify({ ok: false, error: "bridge_down" }), "utf8");
        try {
          res.writeHead(502, {
            "Content-Type": "application/json; charset=utf-8",
            "Content-Length": body.length,
            "Cache-Control": "no-store",
          });
          res.end(body);
        } catch (e) {
          try { res.destroy(); } catch (e2) {}
        }
      } else {
        try { res.destroy(); } catch (e) {}
      }
      finishLog(502);
    }

    upstreamReq.setTimeout(upstreamTimeoutMs, () => {
      failUpstream(new Error("timeout after " + upstreamTimeoutMs + "ms"));
      try { upstreamReq.destroy(); } catch (e) {}
    });
    upstreamReq.on("error", failUpstream);

    req.on("error", (e) => {
      log("warn", "client request error: " + ((e && e.message) || String(e)));
      try { upstreamReq.destroy(); } catch (e2) {}
    });
    res.on("close", () => {
      if (!res.writableFinished) {
        try { upstreamReq.destroy(); } catch (e) {}
      }
    });

    // Stream the request body straight through; nothing is buffered or logged.
    req.pipe(upstreamReq);
  };
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

function main() {
  const cli = parseArgs(process.argv.slice(2));
  if (cli.help) {
    console.log(usage());
    process.exit(0);
  }
  if (cli.bad && cli.bad.length) {
    console.error("missing value for: " + cli.bad.join(", "));
    process.exit(2);
  }
  if (cli.unknown && cli.unknown.length) {
    // Unknown flags are a warning, not a hard failure: a launcher may pass flags
    // this version does not know yet.
    console.error("ignoring unknown arguments: " + cli.unknown.join(", "));
  }

  let fileHttps = {};
  let configPath = null;
  if (cli.config) {
    configPath = resolvePath(cli.config);
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
      fileHttps = (parsed && parsed.https && typeof parsed.https === "object") ? parsed.https : {};
    } catch (e) {
      // A missing/broken config file is not a certificate problem: fall back to
      // defaults and let the CLI flags decide.
      log("warn", "cannot read config " + configPath + " (" + ((e && e.code) || String(e)) + "); using defaults");
      fileHttps = {};
    }
  }

  const logPath = resolvePath(cli.log || DEFAULT_LOG);
  setupLogFile(logPath);

  if (fileHttps.enabled === false) {
    log("info", "https panel channel disabled by config (https.enabled=false); exiting cleanly");
    process.exit(0);
  }

  const port = toPort(cli.port !== undefined ? cli.port : fileHttps.port, DEFAULT_PORT);
  const upstreamPort = toPort(cli.upstream, DEFAULT_UPSTREAM);
  const rawTimeout = cli.timeout !== undefined ? cli.timeout : fileHttps.timeoutMs;
  const upstreamTimeoutMs = toPositiveInt(rawTimeout, DEFAULT_TIMEOUT_MS);
  if (!Number.isInteger(port) || !Number.isInteger(upstreamPort) || !Number.isInteger(upstreamTimeoutMs)) {
    log("error", "invalid port/timeout (port=" + (cli.port !== undefined ? cli.port : fileHttps.port) +
      ", upstream=" + (cli.upstream !== undefined ? cli.upstream : DEFAULT_UPSTREAM) +
      ", timeout=" + rawTimeout + ")");
    process.exit(2);
  }

  const pfxPath = resolvePath(cli.pfx || fileHttps.pfx || DEFAULT_PFX);
  const passFile = resolvePath(cli.passFile || fileHttps.passFile || DEFAULT_PASS_FILE);

  log("info", "bridge_https starting (pid " + process.pid + "): tls port " + port + ", upstream http port " + upstreamPort +
    ", upstream timeout " + upstreamTimeoutMs + "ms");
  log("info", "certificate: " + pfxPath + ", passphrase file: " + passFile + ", log: " + (logFilePath || "stdout-only"));

  // Certificate problems are not faults of the machine: report once and exit 3 so
  // the launcher can skip this channel and stay on BTIPC.
  let pfx = null;
  try {
    pfx = fs.readFileSync(pfxPath);
  } catch (e) {
    log("error", "cannot read certificate " + pfxPath + " (" + ((e && e.code) || String(e)) + "); run scripts/gen_bridge_cert.ps1 -Trust; exiting with code 3");
    process.exit(3);
  }
  let passphrase = "";
  try {
    passphrase = fs.readFileSync(passFile, "utf8").trim();
  } catch (e) {
    log("error", "cannot read passphrase file " + passFile + " (" + ((e && e.code) || String(e)) + "); exiting with code 3");
    process.exit(3);
  }
  if (!passphrase) {
    log("error", "passphrase file " + passFile + " is empty; exiting with code 3");
    process.exit(3);
  }

  const tlsOptions = { pfx: pfx, passphrase: passphrase };
  try {
    // Fail before binding: a bad passphrase must never leave a half-started listener.
    tls.createSecureContext(tlsOptions);
  } catch (e) {
    log("error", "certificate/passphrase rejected (" + ((e && e.message) || String(e)) + "); exiting with code 3");
    process.exit(3);
  }

  const handler = makeHandler(upstreamPort, upstreamTimeoutMs);
  const servers = [];
  let okListeners = 0;
  let failedListeners = 0;
  let tlsRejects = 0;

  function tlsClientError(err) {
    tlsRejects += 1;
    // The game rejecting our self-signed certificate shows up here. That is the
    // positive evidence for "certificate not trusted (or Steam not restarted)".
    if (tlsRejects <= 10 || tlsRejects % 100 === 0) {
      log("warn", "TLS handshake rejected by client (#" + tlsRejects + "): " +
        (((err && err.code) ? err.code + " " : "") + ((err && err.message) || String(err))));
    }
  }

  function settle() {
    if (okListeners + failedListeners < 2) return;
    if (okListeners === 0) {
      log("error", "no loopback listener could bind on port " + port + " (tried 127.0.0.1 and ::1); exiting with code 1");
      process.exit(1);
    }
    log("info", "bridge_https ready: " + okListeners + " listener(s) up, " + failedListeners + " failed (port " + port + ")");
  }

  function listenOn(host, label) {
    const srv = https.createServer(tlsOptions, handler);
    servers.push(srv);
    srv.on("tlsClientError", tlsClientError);
    srv.on("error", (err) => {
      const detail = ((err && err.code) ? err.code : "") + " " + ((err && err.message) || String(err));
      if (srv.listening) {
        // Runtime error after a successful bind: log and stay up (other listener
        // may still serve).
        log("error", "listener error on " + label + ": " + detail.trim());
        return;
      }
      failedListeners += 1;
      log("warn", "cannot listen on " + label + ":" + port + " (" + detail.trim() + "); trying the other loopback address");
      settle();
    });
    srv.listen(port, host, () => {
      okListeners += 1;
      log("info", "listening on https://" + label + ":" + port);
      settle();
    });
  }

  listenOn("127.0.0.1", "127.0.0.1");
  listenOn("::1", "[::1]");

  let shuttingDown = false;
  function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    log("info", "received " + signal + "; shutting down");
    let remaining = servers.filter((s) => s.listening).length;
    if (remaining === 0) process.exit(0);
    const force = setTimeout(() => process.exit(0), 1500);
    if (force && typeof force.unref === "function") force.unref();
    for (const srv of servers) {
      if (!srv.listening) continue;
      srv.close(() => {
        remaining -= 1;
        if (remaining <= 0) process.exit(0);
      });
    }
  }
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Keep the process alive through unexpected single errors: this channel must not
  // flap BTIPC, and a hidden launcher cannot show a crash.
  process.on("uncaughtException", (e) => {
    log("error", "uncaughtException: " + ((e && e.stack) || (e && e.message) || String(e)));
  });
  process.on("unhandledRejection", (e) => {
    log("error", "unhandledRejection: " + ((e && e.stack) || (e && e.message) || String(e)));
  });
}

main();
