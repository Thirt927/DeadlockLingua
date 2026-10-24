// Offline acceptance test for the https panel channel bridge side.
//
// Covers core/bridge_https.js end to end without the game, without the real bridge and
// without network access:
//   - a temporary self-signed certificate from scripts/gen_bridge_cert.ps1 -NoTrust
//     (if PowerShell is missing or refuses to run here the TLS/proxy groups are SKIPped
//     with a printed reason, never turned into a fake pass; the exit-code checks still run);
//   - a stub upstream http server that serves /api/v1/health and /bridge;
//   - the real core/bridge_https.js child process on a random loopback port.
//
// Asserts: TLS handshake + certificate CN/SAN (localhost + both loopback IP SANs),
// proxying of /api/v1/health and /bridge (query, method, status and end-to-end headers
// kept), 404 for unknown paths (without touching the upstream), 405 for other methods,
// 502 + process survives when the upstream is down, self-heal when it comes back,
// local-time log format, request-body redaction, both loopback listeners, reading the
// "https" section via --config, and exit code 3 for a missing certificate or a wrong
// passphrase.
//
// Run: node tests/https_panel_server.test.js
//
// Sandbox note: child stdout/stderr are never piped here (stdio "ignore"/"inherit");
// capturing a child's stdio through pipes is blocked in the confined environment.
"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const net = require("net");
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const BRIDGE_HTTPS = path.join(ROOT, "core", "bridge_https.js");
const CERT_SCRIPT = path.join(ROOT, "scripts", "gen_bridge_cert.ps1");

let passCount = 0;
let failCount = 0;
let skipCount = 0;

function ok(name, cond, extra) {
  if (cond) {
    passCount += 1;
    console.log("  ok   " + name);
  } else {
    failCount += 1;
    console.log("  FAIL " + name + (extra === undefined ? "" : "  " + JSON.stringify(extra)));
  }
}

function skip(name, reason) {
  skipCount += 1;
  console.log("  SKIP " + name + "  (" + reason + ")");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function canListenV6() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen(0, "::1", () => srv.close(() => resolve(true)));
  });
}

function httpsRequest(options) {
  const opts = options || {};
  const host = opts.host || "127.0.0.1";
  const method = opts.method || "GET";
  const body = opts.body === undefined ? null : opts.body;
  const timeout = opts.timeout || 6000;
  const headers = {};
  if (body !== null) {
    headers["Content-Type"] = "text/plain; charset=utf-8";
    headers["Content-Length"] = Buffer.byteLength(body);
  }
  return new Promise((resolve) => {
    const req = https.request({
      host,
      port: opts.port,
      path: opts.path || "/",
      method,
      headers,
      rejectUnauthorized: false,
      agent: false,
      timeout,
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks);
        const sock = res.socket || req.socket;
        let cert = null;
        try {
          if (sock && typeof sock.getPeerCertificate === "function") cert = sock.getPeerCertificate();
        } catch (e) {}
        resolve({ status: res.statusCode, headers: res.headers, body: raw.toString("utf8"), raw, cert });
      });
    });
    req.on("timeout", () => req.destroy(new Error("client_timeout")));
    req.on("error", (e) => resolve({ status: 0, headers: {}, body: "", raw: Buffer.alloc(0), cert: null, error: e }));
    if (body !== null) req.write(body);
    req.end();
  });
}

async function waitReady(port, logPath, state, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    if (state && state.exitCode !== null) break; // process already gone: no point waiting
    const r = await httpsRequest({ port, path: "/api/v1/health" });
    if (r.status === 200) return { ok: true, first: r };
    lastError = r.error ? (r.error.code || r.error.message) : ("status " + r.status);
    await sleep(120);
  }
  let logText = "";
  try {
    logText = fs.readFileSync(logPath, "utf8");
  } catch (e) {}
  return { ok: false, reason: lastError || "timeout", log: logText };
}

function startStub(port) {
  const hits = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      hits.push({ method: req.method, url: req.url, body: raw.toString("utf8"), bytes: raw.length });
      if (req.url === "/api/v1/health" || req.url.indexOf("/api/v1/health?") === 0) {
        const payload = JSON.stringify({ ok: true, stub: true, method: req.method, bodyLen: raw.length });
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Stub-Marker": "health",
        });
        res.end(payload);
        return;
      }
      if (req.url === "/bridge" || req.url.indexOf("/bridge?") === 0) {
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end("<!doctype html><html><head><title>stub-bridge-page</title></head><body>STUB_BRIDGE_MARKER</body></html>");
        return;
      }
      if (req.url === "/api/v1/slow") {
        // Deliberately never answers: bridge_https must cut this off with its timeout.
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("stub 404");
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port || 0, "127.0.0.1", () => resolve({ server, hits, port: server.address().port }));
  });
}

function stopServer(server) {
  return new Promise((resolve) => {
    if (!server || !server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}

function startBridgeHttps(args) {
  const child = spawn(process.execPath, [BRIDGE_HTTPS].concat(args), { stdio: "ignore" });
  const state = { child, exitCode: null, signal: null };
  child.on("exit", (code, signal) => {
    state.exitCode = code;
    state.signal = signal;
  });
  return state;
}

function waitExit(state, timeoutMs) {
  return new Promise((resolve) => {
    if (!state || state.exitCode !== null) {
      resolve(state);
      return;
    }
    const timer = setTimeout(() => resolve(state), timeoutMs);
    state.child.once("exit", () => {
      clearTimeout(timer);
      resolve(state);
    });
  });
}

async function stopBridge(state) {
  if (!state || state.exitCode !== null) return;
  try {
    state.child.kill();
  } catch (e) {}
  await waitExit(state, 3000);
  if (state.exitCode === null) {
    try {
      state.child.kill("SIGKILL");
    } catch (e) {}
    await waitExit(state, 2000);
  }
}

function sanEntries(cert) {
  const raw = String((cert && cert.subjectaltname) || "");
  return raw.split(/,\s*/).filter(Boolean);
}

function isIpv6Loopback(value) {
  return value === "::1" ||
    value === "0:0:0:0:0:0:0:1" ||
    value === "0000:0000:0000:0000:0000:0000:0000:0001";
}

// Generate the temporary certificate. Returns { ok, pfx, passFile, cer } or { ok:false, reason }.
function generateCertificate(certDir) {
  const candidates = [
    path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    "powershell.exe",
  ];
  let lastError = "";
  for (const ps of candidates) {
    const args = [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", CERT_SCRIPT, "-NoTrust", "-OutDir", certDir,
    ];
    // stdio "inherit": the reason for a failure must be visible; pipes are not usable here.
    const r = spawnSync(ps, args, { stdio: "inherit" });
    if (r.error) {
      lastError = ps + ": " + (r.error.code || r.error.message);
      continue;
    }
    if (r.status !== 0) {
      lastError = "gen_bridge_cert.ps1 exited with code " + r.status;
      continue;
    }
    const pfx = path.join(certDir, "bridge.pfx");
    const passFile = path.join(certDir, "bridge.pass");
    const cer = path.join(certDir, "bridge.cer");
    if (![pfx, passFile, cer].every((p) => fs.existsSync(p))) {
      lastError = "gen_bridge_cert.ps1 exited 0 but did not write the expected files";
      continue;
    }
    return { ok: true, pfx, passFile, cer };
  }
  return { ok: false, reason: lastError || "no usable PowerShell found" };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

(async function main() {
  const logsDir = path.join(ROOT, "logs");
  try {
    fs.mkdirSync(logsDir, { recursive: true });
  } catch (e) {}
  const tmpDir = fs.mkdtempSync(path.join(logsDir, "_https_test_"));
  const children = [];
  const servers = [];

  try {
    const certDir = path.join(tmpDir, "certs");
    fs.mkdirSync(certDir, { recursive: true });
    const cert = generateCertificate(certDir);
    const logPath = path.join(tmpDir, "bridge_https.log");

    let bridgeState = null;
    let stub = null;
    let stubPort = 0;
    let tlsPort = 0;
    let ready = null;

    if (!cert.ok) {
      skip("https panel acceptance (TLS handshake / proxy / log checks)",
        "temporary certificate could not be generated: " + cert.reason);
    } else {
      // Certificate content checks independent of TLS (verifies the generator itself).
      try {
        const x509 = new crypto.X509Certificate(fs.readFileSync(cert.cer));
        ok("generated certificate CN = BabelTower-localhost",
          typeof x509.subject === "string" && /CN=BabelTower-localhost/.test(x509.subject), x509.subject);
        ok("generated certificate SAN has DNS:localhost + both loopback IPs",
          /DNS:localhost/.test(x509.subjectAltName || "") &&
          /IP Address:127\.0\.0\.1/.test(x509.subjectAltName || "") &&
          /IP Address:(0:0:0:0:0:0:0:1|::1|(0{4}:){7}0{3}1)/.test(x509.subjectAltName || ""),
          x509.subjectAltName);
        const keyUsage = Array.isArray(x509.keyUsage) ? x509.keyUsage : [];
        ok("generated certificate EKU = serverAuth (1.3.6.1.5.5.7.3.1)",
          keyUsage.some((u) => String(u).indexOf("1.3.6.1.5.5.7.3.1") >= 0), keyUsage);
      } catch (e) {
        ok("read generated certificate with crypto.X509Certificate", false, String(e && e.message));
      }

      stub = await startStub(0);
      servers.push(stub.server);
      stubPort = stub.port;
      tlsPort = await findFreePort();

      bridgeState = startBridgeHttps([
        "--port", String(tlsPort),
        "--upstream", String(stubPort),
        "--pfx", cert.pfx,
        "--pass-file", cert.passFile,
        "--log", logPath,
        // Shorter than the 10s default so the timeout path can be tested quickly.
        "--timeout", "1200",
      ]);
      children.push(bridgeState);

      ready = await waitReady(tlsPort, logPath, bridgeState, 15000);
      ok("bridge_https started and answered over TLS on port " + tlsPort, ready.ok,
        ready.ok ? undefined : { reason: ready.reason, log: String(ready.log || "").slice(-800) });

      if (!ready.ok) {
        skip("proxy / 404 / 502 / log checks", "bridge_https never became ready");
      } else {
        // 1) TLS handshake + certificate identity seen by a real client.
        const peer = ready.first.cert || {};
        const entries = sanEntries(peer);
        const ipValues = entries
          .filter((e) => e.indexOf("IP Address:") === 0)
          .map((e) => e.slice("IP Address:".length));
        ok("TLS handshake succeeded and peer certificate CN is BabelTower-localhost",
          !!(peer.subject && peer.subject.CN === "BabelTower-localhost"), peer.subject);
        ok("peer certificate SAN contains DNS:localhost", entries.indexOf("DNS:localhost") >= 0, entries);
        ok("peer certificate SAN contains IP:127.0.0.1 as an IP SAN", ipValues.indexOf("127.0.0.1") >= 0, entries);
        ok("peer certificate SAN contains IP:::1 (IPv6 loopback) as an IP SAN",
          ipValues.some(isIpv6Loopback), entries);

        // 2) /api/v1/health proxied to the stub, status/body/headers preserved.
        const health = await httpsRequest({ port: tlsPort, path: "/api/v1/health" });
        let healthJson = null;
        try {
          healthJson = JSON.parse(health.body);
        } catch (e) {}
        ok("GET /api/v1/health proxied -> 200", health.status === 200, health.status);
        ok("GET /api/v1/health returns the stub JSON {ok:true,stub:true}",
          !!healthJson && healthJson.ok === true && healthJson.stub === true, health.body);
        ok("proxied response keeps Content-Type",
          String(health.headers["content-type"] || "").indexOf("application/json") >= 0, health.headers);
        ok("proxied response keeps Cache-Control: no-store", health.headers["cache-control"] === "no-store", health.headers);
        ok("proxied response keeps custom end-to-end header X-Stub-Marker",
          health.headers["x-stub-marker"] === "health", health.headers);

        // 3) POST body streamed through, query string preserved.
        const marker = "SECRET-CHAT-MARKER-" + Date.now();
        const post = await httpsRequest({
          port: tlsPort, path: "/api/v1/health?op=probe&id=7", method: "POST", body: marker,
        });
        ok("POST /api/v1/health proxied -> 200", post.status === 200, post.status);
        const lastHit = stub.hits[stub.hits.length - 1] || {};
        ok("POST body arrived at upstream unchanged",
          lastHit.method === "POST" && lastHit.body === marker, lastHit);
        ok("query string preserved when proxying",
          lastHit.url === "/api/v1/health?op=probe&id=7", lastHit.url);

        // 4) /bridge page proxied as HTML.
        const page = await httpsRequest({ port: tlsPort, path: "/bridge?op=health&id=probe" });
        ok("GET /bridge proxied -> 200", page.status === 200, page.status);
        ok("/bridge response is the stub HTML", page.body.indexOf("STUB_BRIDGE_MARKER") >= 0, page.body.slice(0, 120));
        ok("/bridge keeps Content-Type text/html",
          String(page.headers["content-type"] || "").indexOf("text/html") >= 0, page.headers);

        // 5) Unknown path -> 404, and the upstream is never contacted for it.
        const hitsBefore404 = stub.hits.length;
        const miss = await httpsRequest({ port: tlsPort, path: "/definitely-not-proxied?x=1" });
        ok("unknown path -> 404", miss.status === 404, miss.status);
        ok("unknown path body is text/plain", String(miss.headers["content-type"] || "").indexOf("text/plain") >= 0, miss.headers);
        ok("unknown path was not proxied to the upstream", stub.hits.length === hitsBefore404, stub.hits.length);

        // 6) Only GET/POST are proxied.
        const del = await httpsRequest({ port: tlsPort, path: "/api/v1/health", method: "DELETE" });
        ok("other methods are rejected with 405 instead of proxied", del.status === 405, del.status);

        // 7) Log format: local time (no ISO/UTC marker), one-line request log.
        const logText1 = fs.readFileSync(logPath, "utf8");
        const logLines = logText1.split(/\r?\n/).filter(Boolean);
        ok("every log line matches \"[YYYY-MM-DD HH:MM:SS] [level] msg\"",
          logLines.length > 0 && logLines.every((l) => /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] \[(info|warn|error|debug)\] /.test(l)),
          logLines.slice(0, 3));
        ok("log timestamps are local, not toISOString() UTC",
          !/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(logText1));
        ok("request log line uses \"REQ <method> <url> -> <status> <ms>\"",
          /\[info\] REQ GET \/api\/v1\/health -> 200 \d+ms/.test(logText1));
        ok("request-body content never reaches the log", logText1.indexOf(marker) < 0);

        // 8) Both loopback listeners; ::1 is exercised when the environment has IPv6.
        ok("log records a listener on 127.0.0.1", /listening on https:\/\/127\.0\.0\.1:\d+/.test(logText1));
        const v6Listening = /listening on https:\/\/\[::1\]:\d+/.test(logText1);
        if (v6Listening) {
          ok("log records a listener on [::1]", true);
          const viaV6 = await httpsRequest({ host: "::1", port: tlsPort, path: "/api/v1/health" });
          ok("requests over [::1] are proxied too", viaV6.status === 200 && viaV6.body.indexOf("\"stub\":true") >= 0,
            { status: viaV6.status, error: viaV6.error && (viaV6.error.code || viaV6.error.message) });
        } else {
          skip("listener on [::1]", "IPv6 loopback is not available in this environment (see " + logPath + ")");
        }

        // 9) Upstream down -> 502 JSON, process survives; upstream back -> self-heal.
        await stopServer(stub.server);
        const down = await httpsRequest({ port: tlsPort, path: "/api/v1/health" });
        let downJson = null;
        try {
          downJson = JSON.parse(down.body);
        } catch (e) {}
        ok("upstream down -> 502", down.status === 502, down.status);
        ok("upstream down body is {\"ok\":false,\"error\":\"bridge_down\"}",
          !!downJson && downJson.ok === false && downJson.error === "bridge_down", down.body);
        ok("bridge_https process is still alive after upstream failure", bridgeState.exitCode === null, bridgeState.exitCode);
        const healStub = await startStub(stubPort);
        servers.push(healStub.server);
        const healed = await httpsRequest({ port: tlsPort, path: "/api/v1/health" });
        ok("channel self-heals once the upstream is back -> 200", healed.status === 200, healed.status);
        stub = healStub;

        // 9b) Upstream that never answers: the configured timeout becomes a 502, not a hang.
        const slowStart = Date.now();
        const slow = await httpsRequest({ port: tlsPort, path: "/api/v1/slow", timeout: 8000 });
        const slowMs = Date.now() - slowStart;
        let slowJson = null;
        try {
          slowJson = JSON.parse(slow.body);
        } catch (e) {}
        ok("hanging upstream -> 502 bridge_down",
          slow.status === 502 && !!slowJson && slowJson.error === "bridge_down",
          { status: slow.status, body: slow.body });
        ok("timeout uses the configured 1.2s instead of a hard-coded 10s",
          slowMs >= 900 && slowMs < 5000, slowMs);
        ok("process is still alive after an upstream timeout", bridgeState.exitCode === null, bridgeState.exitCode);
        const timeoutLogText = fs.readFileSync(logPath, "utf8");
        ok("upstream timeout is logged with its configured duration",
          /timeout after 1200ms/.test(timeoutLogText), timeoutLogText.slice(-400));

        // 10) --config reads the "https" section {enabled,port,pfx,passFile}.
        const cfgPort = await findFreePort();
        const cfgPath = path.join(tmpDir, "config.json");
        const cfgLog = path.join(tmpDir, "bridge_https_config.log");
        fs.writeFileSync(cfgPath, JSON.stringify({
          https: { enabled: true, port: cfgPort, pfx: cert.pfx, passFile: cert.passFile },
        }, null, 2), "utf8");
        const cfgState = startBridgeHttps([
          "--config", cfgPath,
          "--upstream", String(stubPort),
          "--log", cfgLog,
        ]);
        children.push(cfgState);
        const cfgReady = await waitReady(cfgPort, cfgLog, cfgState, 12000);
        ok("--config https section is applied (listens on the configured port and proxies)",
          cfgReady.ok && cfgReady.first.status === 200,
          cfgReady.ok ? undefined : { reason: cfgReady.reason, log: String(cfgReady.log || "").slice(-600) });
        await stopBridge(cfgState);

        // 11) https.enabled=false -> clean exit 0 (launcher must not treat it as a fault).
        const disabledCfg = path.join(tmpDir, "config.disabled.json");
        const disabledLog = path.join(tmpDir, "bridge_https_disabled.log");
        fs.writeFileSync(disabledCfg, JSON.stringify({ https: { enabled: false } }), "utf8");
        const disabledState = startBridgeHttps(["--config", disabledCfg, "--log", disabledLog]);
        children.push(disabledState);
        await waitExit(disabledState, 8000);
        ok("https.enabled=false exits with code 0",
          disabledState.exitCode === 0, disabledState.exitCode);
        let disabledLogText = "";
        try {
          disabledLogText = fs.readFileSync(disabledLog, "utf8");
        } catch (e) {}
        ok("https.enabled=false is logged", disabledLogText.indexOf("disabled by config") >= 0, disabledLogText.slice(-300));
      }

      // 12) Loopback listener failure semantics:
      //     one address busy -> log it, keep serving the other;
      //     both addresses busy -> exit 1.
      const v6Available = await canListenV6();
      if (!v6Available) {
        skip("listener-failure semantics", "IPv6 loopback is not available in this environment");
      } else {
        // 12a) 127.0.0.1 busy but ::1 free -> the process must keep running on ::1.
        const onePort = await findFreePort();
        const busyV4 = net.createServer();
        servers.push(busyV4);
        await new Promise((resolve, reject) => {
          busyV4.once("error", reject);
          busyV4.listen(onePort, "127.0.0.1", resolve);
        });
        const oneLog = path.join(tmpDir, "one_listener_fails.log");
        const oneState = startBridgeHttps([
          "--port", String(onePort),
          "--upstream", String(stubPort),
          "--pfx", cert.pfx,
          "--pass-file", cert.passFile,
          "--log", oneLog,
        ]);
        children.push(oneState);
        await sleep(1500);
        let oneLogText = "";
        try {
          oneLogText = fs.readFileSync(oneLog, "utf8");
        } catch (e) {}
        ok("busy 127.0.0.1 does not abort startup (process still running)", oneState.exitCode === null, oneState.exitCode);
        ok("busy 127.0.0.1 is logged and the [::1] listener still comes up",
          /cannot listen on 127\.0\.0\.1:\d+/.test(oneLogText) && /listening on https:\/\/\[::1\]:\d+/.test(oneLogText),
          oneLogText.slice(-500));
        const viaV6After = await httpsRequest({ host: "::1", port: onePort, path: "/api/v1/health" });
        ok("the surviving [::1] listener still proxies", viaV6After.status === 200, viaV6After.status);
        await stopBridge(oneState);
        await stopServer(busyV4);

        // 12b) both loopback addresses busy -> exit code 1.
        const bothPort = await findFreePort();
        const busyV4b = net.createServer();
        const busyV6b = net.createServer();
        servers.push(busyV4b);
        servers.push(busyV6b);
        await new Promise((resolve, reject) => {
          busyV4b.once("error", reject);
          busyV4b.listen(bothPort, "127.0.0.1", resolve);
        });
        let bothBound = true;
        try {
          await new Promise((resolve, reject) => {
            busyV6b.once("error", reject);
            busyV6b.listen(bothPort, "::1", resolve);
          });
        } catch (e) {
          bothBound = false;
        }
        if (!bothBound) {
          skip("both listeners busy -> exit 1", "could not occupy the same port on [::1]");
        } else {
          const bothLog = path.join(tmpDir, "both_listeners_fail.log");
          const bothState = startBridgeHttps([
            "--port", String(bothPort),
            "--upstream", String(stubPort),
            "--pfx", cert.pfx,
            "--pass-file", cert.passFile,
            "--log", bothLog,
          ]);
          children.push(bothState);
          await waitExit(bothState, 10000);
          ok("both loopback listeners busy -> exit code 1", bothState.exitCode === 1, bothState.exitCode);
        }
        await stopServer(busyV4b);
        await stopServer(busyV6b);
      }
    }

    // -------------------------------------------------------------------
    // Exit code 3 checks (independent of the certificate that was generated).
    // -------------------------------------------------------------------
    const missingPort = await findFreePort();
    const missingLog = path.join(tmpDir, "missing_cert.log");
    const missingState = startBridgeHttps([
      "--port", String(missingPort),
      "--pfx", path.join(tmpDir, "does-not-exist.pfx"),
      "--pass-file", path.join(tmpDir, "does-not-exist.pass"),
      "--log", missingLog,
    ]);
    children.push(missingState);
    await waitExit(missingState, 10000);
    ok("missing certificate exits with code 3 (launcher skips the channel)",
      missingState.exitCode === 3, missingState.exitCode);
    let missingLogText = "";
    try {
      missingLogText = fs.readFileSync(missingLog, "utf8");
    } catch (e) {}
    ok("missing certificate is logged as an error", /\[error\] cannot read certificate/.test(missingLogText),
      missingLogText.slice(-400));

    if (cert.ok) {
      const badPassPort = await findFreePort();
      const badPassLog = path.join(tmpDir, "bad_pass.log");
      const badPassFile = path.join(tmpDir, "wrong.pass");
      fs.writeFileSync(badPassFile, "definitely-not-the-passphrase", "utf8");
      const badPassState = startBridgeHttps([
        "--port", String(badPassPort),
        "--pfx", cert.pfx,
        "--pass-file", badPassFile,
        "--log", badPassLog,
      ]);
      children.push(badPassState);
      await waitExit(badPassState, 10000);
      ok("wrong passphrase exits with code 3", badPassState.exitCode === 3, badPassState.exitCode);
    } else {
      skip("wrong passphrase exits with code 3", "no temporary certificate available");
    }
  } finally {
    for (const state of children) await stopBridge(state);
    for (const server of servers) await stopServer(server);
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (e) {}
  }

  console.log("");
  console.log("https_panel_server.test: PASS " + passCount + " / FAIL " + failCount + " / SKIP " + skipCount);
  process.exit(failCount > 0 ? 1 : 0);
})().catch((e) => {
  console.log("https_panel_server.test CRASH: " + ((e && e.stack) || String(e)));
  process.exit(1);
});
