// bot.js
// Dependencies: axios, ws, tough-cookie, axios-cookiejar-support
const axios = require("axios");
const { wrapper } = require("axios-cookiejar-support");
const tough = require("tough-cookie");
const WebSocket = require("ws");
const http = require("http");

// ------------------ CONFIG ------------------
const WEBHOOK_URL = process.env.WEBHOOK";
const AUTH_URL = "https://console.altr.cc/auth/login";
const WS_URL = "wss://console.altr.cc/ws";
const COINS_URL = "https://console.altr.cc/api/coins";

const EMAIL = process.env.EMAIL;
const PASSWORD = process.env.PASSWORD;

// Timing
const CHECK_COINS_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const SEND_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2 hours
const RECONNECT_BACKOFF_MAX_MS = 30 * 1000; // cap backoff at 30s

// ------------------ GLOBALS ------------------
const jar = new tough.CookieJar();
const client = wrapper(axios.create({ jar, withCredentials: true }));
let ws = null;
let reconnecting = false;
let reconnectAttempt = 0;

let latestWsData = null;   // last afk_state from WS
let latestCoins = null;    // last coins from /api/coins
let lastSentTime = 0;

// Minimal console logging helper
const log = {
  info: (s) => console.log(`[+] ${s}`),
  warn: (s) => console.warn(`[!] ${s}`),
  err:  (s) => console.error(`[-] ${s}`)
};

// ------------------ Discord embed ------------------
async function sendDiscordEmbed(payload, isError = false) {
  if (!WEBHOOK_URL || WEBHOOK_URL.includes("xxxx")) {
    log.warn("WEBHOOK_URL not configured. Skipping Discord send.");
    return;
  }
  try {
    const embed = isError ? {
      title: "⚠️ WebSocket Notice",
      description: String(payload),
      color: 0xff0000,
      timestamp: new Date().toISOString()
    } : (() => {
      const fields = [];
      if (latestCoins !== null) fields.push({ name: "Coins", value: String(latestCoins), inline: true });
      if (latestWsData?.coinsPerMinute !== undefined) fields.push({ name: "Coins/Min", value: String(latestWsData.coinsPerMinute), inline: true });
      if (latestWsData?.multiplier !== undefined) fields.push({ name: "Multiplier", value: `${latestWsData.multiplier}x`, inline: true });
      if (latestWsData?.presenceCount !== undefined) fields.push({ name: "Presence", value: String(latestWsData.presenceCount), inline: true });
      fields.push({ name: "Party Mode", value: latestWsData?.partyModeActive ? "🟢 Active" : "🔴 Inactive", inline: true});
      fields.push({ name: "Plan Boost", value: latestWsData?.planBoostActive ? "🟢 Active" : "🔴 Inactive", inline: true});
      return {
        title: "📊 AFK State Update",
        color: 0xff69b4,
        fields,
        timestamp: new Date().toISOString()
      };
    })();

    await axios.post(WEBHOOK_URL, { embeds: [embed] }).catch(() => {}); // swallow network errors
    if (!isError) lastSentTime = Date.now();
    log.info(isError ? "Sent error to Discord" : "Sent update to Discord");
  } catch (e) {
    log.warn("Discord send failed");
  }
}

// ------------------ Auth / Login ------------------
async function doLogin() {
  try {
    await client.post(AUTH_URL, { email: EMAIL, password: PASSWORD }, {
      headers: { "Content-Type": "application/json", "Origin": "https://console.altr.cc" },
      validateStatus: () => true
    });
    log.info("Login OK (cookie refreshed)");
    reconnectAttempt = 0;
  } catch (e) {
    log.err("Login request failed: " + e.message);
    throw e;
  }
}

// ------------------ WebSocket logic ------------------
function getCookieHeader() {
  try {
    return jar.getCookieStringSync("https://console.altr.cc");
  } catch {
    return "";
  }
}

function openWS() {
  const cookie = getCookieHeader();
  try {
    ws = new WebSocket(WS_URL, {
      headers: {
        Cookie: cookie,
        Origin: "https://console.altr.cc",
        "User-Agent": "Mozilla/5.0"
      }
    });
  } catch (e) {
    log.err("WS create failed: " + e.message);
    triggerReauth("ws_create_fail");
    return;
  }

  ws.on("open", () => {
    log.info("WS connected");
    // Force immediate Discord send if we haven't sent in interval
    if (Date.now() - lastSentTime >= SEND_INTERVAL_MS) {
      lastSentTime = Date.now() - SEND_INTERVAL_MS;
    }
  });

  ws.on("message", (msg) => {
    try {
      const d = JSON.parse(msg.toString());
      // If server explicitly signals auth error in payload
      if (d?.type === "auth_error" || d?.code === 401 || /unauthor/i.test(String(d?.error ?? d?.message ?? ""))) {
        log.warn("WS message indicates auth error -> reauth");
        triggerReauth("ws_msg_auth");
        return;
      }
      // Save afk_state
      if (d?.type === "afk_state") {
        latestWsData = d;
      }
    } catch (e) {
      // ignore parse noise
    }
  });

  ws.on("close", (code, reason) => {
    const r = reason && reason.toString ? reason.toString() : "";
    log.warn(`WS closed (code=${code})`);
    // if close reason suggests auth or a typical auth-close code
    if (code === 4001 || code === 1008 || /auth|unauthor/i.test(r)) {
      triggerReauth("ws_close_auth");
    } else {
      // other closes: try reconnect but through triggerReauth to reuse backoff
      triggerReauth("ws_close_other");
    }
  });

  ws.on("error", (err) => {
    log.warn("WS error: " + (err && err.message ? err.message : String(err)));
  });

  // Catch upgrade failures (HTTP 401 on WS upgrade)
  ws.on("unexpected-response", (req, res) => {
    log.warn(`WS upgrade unexpected response ${res.statusCode}`);
    if (res.statusCode === 401) triggerReauth("upgrade_401");
  });
}

// ------------------ Reconnect / Reauth flow ------------------
function triggerReauth(reason = "unknown") {
  if (reconnecting) return;
  reconnecting = true;
  log.warn("Triggering reauth: " + reason);

  // terminate ws if any
  try { if (ws) ws.terminate(); } catch {}

  const attemptReconnect = async (attempt = 1) => {
    try {
      await doLogin();
      openWS();
      reconnecting = false;
      reconnectAttempt = 0;
      log.info("Reconnected successfully after reauth");
    } catch (e) {
      reconnectAttempt = attempt;
      const wait = Math.min(RECONNECT_BACKOFF_MAX_MS, 1000 * Math.pow(2, attempt));
      log.warn(`Reauth attempt ${attempt} failed, retrying in ${Math.round(wait/1000)}s`);
      setTimeout(() => attemptReconnect(attempt + 1), wait);
    }
  };

  attemptReconnect(reconnectAttempt + 1);
}

// ------------------ Periodic jobs ------------------
async function startPeriodicJobs() {
  // Reauth + reconnect mỗi 1 tiếng
  setInterval(() => {
    triggerReauth("scheduled_hourly");
  }, 60 * 60 * 1000); // 1h

  // discord send checker mỗi 1 phút (giữ nguyên)
  setInterval(() => {
    try {
      if (Date.now() - lastSentTime >= SEND_INTERVAL_MS && latestWsData) {
        sendDiscordEmbed("Periodic update", false).catch(() => {});
      }
    } catch {}
  }, 60 * 1000);
}

// ------------------ HTTP ping for uptime ------------------
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Bot is running");
}).listen(process.env.PORT || 3000);

// ------------------ Boot ------------------
(async () => {
  try {
    await doLogin();
    openWS();
    startPeriodicJobs();
    log.info("Bot started");
  } catch (e) {
    log.err("Boot failed, entering reauth flow");
    triggerReauth("boot_fail");
  }
})();

// ------------------ Graceful exit ------------------
process.on("SIGINT", async () => {
  log.warn("SIGINT received, shutting down");
  try { await sendDiscordEmbed("Bot stopped manually", true); } catch {}
  try { if (ws) ws.close(1000); } catch {}
  process.exit(0);
});
