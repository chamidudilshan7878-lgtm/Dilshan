const express = require('express');
const path = require('path');
const pino = require('pino');
const QRCode = require('qrcode');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());
app.use(express.static(path.join(__dirname)));

let sock = null;
let latestQrRaw = null;
let latestQrDataUrl = null;
let isConnected = false;
let connectedUser = null;
let isStartingSocket = false;

async function initWhatsAppSocket(resetSession = false) {
  if (isStartingSocket) return;
  isStartingSocket = true;

  try {
    const authDir = path.join(__dirname, 'auth_info');
    if (resetSession) {
      const fs = require('fs');
      fs.rmSync(authDir, { recursive: true, force: true });
      latestQrRaw = null;
      latestQrDataUrl = null;
      isConnected = false;
      connectedUser = null;
    }

    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      logger: pino({ level: 'silent' }),
      auth: state,
      printQRInTerminal: false,
      browser: ['Dilshan Hub', 'Chrome', '1.0.0']
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        latestQrRaw = qr;
        try {
          latestQrDataUrl = await QRCode.toDataURL(qr, { width: 240, margin: 2 });
        } catch (err) {
          latestQrDataUrl = null;
        }
      }

      if (connection === 'open') {
        isConnected = true;
        latestQrRaw = null;
        latestQrDataUrl = null;
        connectedUser = sock.user?.id || 'Paired Device';
        console.log('WhatsApp connected:', connectedUser);
      } else if (connection === 'close') {
        isConnected = false;
        connectedUser = null;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        console.log('WhatsApp connection closed. Reconnect:', shouldReconnect);
        if (shouldReconnect) {
          setTimeout(() => {
            isStartingSocket = false;
            initWhatsAppSocket(false);
          }, 2000);
          return;
        }
      }
    });
  } catch (err) {
    console.error('Failed to init WhatsApp socket:', err);
  } finally {
    isStartingSocket = false;
  }
}

initWhatsAppSocket(false);

// Check connection status
app.get('/api/pair/status', (req, res) => {
  res.json({
    connected: isConnected,
    user: connectedUser,
    hasQr: Boolean(latestQrDataUrl)
  });
});

// Get QR Code for WhatsApp pairing
app.get('/api/pair/qr', async (req, res) => {
  try {
    if (isConnected) {
      return res.json({
        connected: true,
        user: connectedUser,
        message: 'WhatsApp is already paired and connected.'
      });
    }

    if (!sock) {
      await initWhatsAppSocket(false);
    }

    // Wait briefly if QR is still generating
    let tries = 0;
    while (!latestQrDataUrl && tries < 10) {
      await new Promise((r) => setTimeout(r, 400));
      tries++;
    }

    if (!latestQrDataUrl) {
      return res.status(202).json({
        error: 'QR code is still generating. Please try again in a second.'
      });
    }

    res.json({
      connected: false,
      qrDataUrl: latestQrDataUrl,
      qrRaw: latestQrRaw
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Error generating QR code.' });
  }
});

// Request 8-character Pairing Code using phone number
app.post('/api/pair/code', async (req, res) => {
  try {
    const rawPhone = req.body?.phone || req.query?.phone || '';
    const phone = String(rawPhone).replace(/\D/g, '');

    if (!phone || phone.length < 8) {
      return res.status(400).json({
        error: 'Please enter a valid phone number with country code (e.g. 94771234567).'
      });
    }

    if (isConnected) {
      return res.json({
        connected: true,
        user: connectedUser,
        message: 'WhatsApp is already paired.'
      });
    }

    if (!sock) {
      await initWhatsAppSocket(false);
    }

    const code = await sock.requestPairingCode(phone);
    res.json({
      connected: false,
      phone,
      code
    });
  } catch (err) {
    res.status(500).json({
      error: err.message || 'Failed to request pairing code.'
    });
  }
});

// Reset session if needed
app.post('/api/pair/reset', async (req, res) => {
  try {
    await initWhatsAppSocket(true);
    res.json({ ok: true, message: 'Session reset. Generating new pairing session.' });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to reset session.' });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
