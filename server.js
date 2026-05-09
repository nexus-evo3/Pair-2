const express = require("express");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require("baileys");
const pino = require("pino");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;
const OWNER_NUMBER = process.env.OWNER_NUMBER || "";

app.use(express.json());
app.use(express.static("public"));

const activeSessions = new Map();

function generateToken() {
  return crypto.randomBytes(16).toString("hex");
}

function generateSessionId() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 10; i++) {
    id += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `Spectral-H-${id}-Beta`;
}

function encodeSession(authFolder) {
  const files = fs.readdirSync(authFolder);
  const authData = {};
  for (const file of files) {
    const filePath = path.join(authFolder, file);
    if (fs.statSync(filePath).isFile()) {
      authData[file] = fs.readFileSync(filePath, "utf8");
    }
  }
  return Buffer.from(JSON.stringify(authData)).toString("base64");
}

function cleanupSession(token) {
  const session = activeSessions.get(token);
  if (session?.authFolder && fs.existsSync(session.authFolder)) {
    fs.rmSync(session.authFolder, { recursive: true, force: true });
  }
  activeSessions.delete(token);
}

function sendSSE(token, data) {
  const session = activeSessions.get(token);
  if (session?.sseRes) {
    try {
      session.sseRes.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch (_) {}
  }
}

async function startConnection(token, phoneNumber) {
  const authFolder = path.join(__dirname, "sessions", token);
  fs.mkdirSync(authFolder, { recursive: true });

  const session = activeSessions.get(token);
  if (session) session.authFolder = authFolder;

  const { state, saveCreds } = await useMultiFileAuthState(authFolder);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: "silent" }),
    browser: ["Spectral Hunter", "Chrome", "1.0.0"],
    mobile: false,
  });

  if (activeSessions.has(token)) {
    activeSessions.get(token).sock = sock;
  }

  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {

    // QR reçu → demander pairing code
    if (qr) {
      setTimeout(async () => {
        try {
          const number = phoneNumber.replace(/[^0-9]/g, "");
          const code = await sock.requestPairingCode(number);
          const formatted = code?.match(/.{1,4}/g)?.join("-") || code;

          if (activeSessions.has(token)) {
            activeSessions.get(token).status = "awaiting";
            activeSessions.get(token).pairingCode = formatted;
          }

          sendSSE(token, { type: "code", code: formatted });
        } catch (e) {
          sendSSE(token, { type: "error", message: "Erreur génération code : " + e.message });
        }
      }, 2000);
    }

    if (connection === "open") {
      try {
        const encoded = encodeSession(authFolder);
        const sessionLabel = generateSessionId();
        const fullSessionId = `${sessionLabel}:${encoded}`;

        if (activeSessions.has(token)) {
          activeSessions.get(token).status = "connected";
          activeSessions.get(token).sessionId = sessionLabel;
        }

        const userJid = phoneNumber.replace(/[^0-9]/g, "") + "@s.whatsapp.net";
        await sock.sendMessage(userJid, {
          text:
            `🛡️ *SPECTRAL HUNTER MD V1*\n\n` +
            `✅ Connexion réussie !\n\n` +
            `📋 *Votre Session ID :*\n` +
            `\`\`\`${fullSessionId}\`\`\`\n\n` +
            `📌 *Sur Render :*\n` +
            `Settings > Environment Variables\n` +
            `SESSION_ID = (collez le code ci-dessus)\n\n` +
            `⚠️ Ne partagez jamais cette Session ID !`,
        });

        if (OWNER_NUMBER) {
          await sock.sendMessage(OWNER_NUMBER + "@s.whatsapp.net", {
            text:
              `🛡️ *SPECTRAL HUNTER PAIR SITE*\n\n` +
              `🆕 Nouvelle connexion !\n` +
              `📱 Numéro : ${phoneNumber}\n` +
              `🔑 Session : ${sessionLabel}\n` +
              `📅 ${new Date().toLocaleString("fr-FR")}`,
          });
        }

        sendSSE(token, {
          type: "connected",
          sessionId: sessionLabel,
          message: "Session ID envoyée sur votre WhatsApp !",
        });

        setTimeout(() => cleanupSession(token), 30000);

      } catch (e) {
        sendSSE(token, { type: "error", message: "Erreur : " + e.message });
      }
    }

    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code !== DisconnectReason.loggedOut) {
        sendSSE(token, { type: "error", message: "Connexion perdue. Réessayez." });
      }
      cleanupSession(token);
    }
  });

  sock.ev.on("creds.update", saveCreds);
}

// ─── ROUTES ──────────────────────────────────────────────────────────────────
app.post("/api/connect", async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: "Numéro requis" });

  const token = generateToken();
  activeSessions.set(token, {
    status: "connecting",
    pairingCode: null,
    sessionId: null,
    sseRes: null,
    authFolder: null,
    sock: null,
  });

  res.json({ token });

  startConnection(token, phone).catch((e) => {
    sendSSE(token, { type: "error", message: e.message });
  });
});

app.get("/api/status/:token", (req, res) => {
  const { token } = req.params;
  if (!activeSessions.has(token)) {
    return res.status(404).json({ error: "Session introuvable" });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  activeSessions.get(token).sseRes = res;
  const session = activeSessions.get(token);
  res.write(`data: ${JSON.stringify({ type: "status", status: session.status })}\n\n`);

  req.on("close", () => {
    if (activeSessions.has(token)) {
      activeSessions.get(token).sseRes = null;
    }
  });
});

app.get("/api/stats", (req, res) => {
  res.json({
    activeSessions: activeSessions.size,
    uptime: Math.floor(process.uptime()),
  });
});

fs.mkdirSync(path.join(__dirname, "sessions"), { recursive: true });

app.listen(PORT, () => {
  console.log(`🛡️ Spectral Hunter Pair Site en ligne sur le port ${PORT}`);
});
