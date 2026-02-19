import 'dotenv/config';
import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'http';
import bodyParser from 'body-parser';
import { ElevenLabsASR } from './services/elevenlabs-asr.js';
import { ElevenLabsTTS } from './services/elevenlabs-tts.js';
import { createCallSession } from './services/agent-workflow.js';

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ─── Twilio Webhook ───────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.send('Voice AI Platform is running!');
});

app.post('/incoming', (req, res) => {
  console.log('[Twilio] Incoming call from:', req.body.From || 'unknown');

  const host = req.headers.host;
  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Connect>
        <Stream url="wss://${host}/media-stream">
            <Parameter name="caller_phone" value="${req.body.From || ''}" />
        </Stream>
    </Connect>
</Response>`;

  res.set('Content-Type', 'text/xml');
  res.send(twimlResponse);
});

// ─── WebSocket (Media Stream) ─────────────────────────────────────────────────

wss.on('connection', (ws) => {
  console.log('[WS] New Twilio connection');

  let asr = null;
  let tts = null;
  let callSession = null;

  ws.on('message', async (message) => {
    let msg;
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }

    switch (msg.event) {
      case 'start': {
        const streamSid = msg.start.streamSid;
        const callerPhone = msg.start.customParameters?.caller_phone ?? '';
        console.log(`[WS] Stream started: ${streamSid}`);

        // Initialize TTS and ASR — start connections in parallel
        tts = new ElevenLabsTTS(ws, streamSid);
        asr = new ElevenLabsASR(async (transcript) => {
          if (!transcript?.trim()) return;
          console.log(`[User] ${transcript}`);

          const prevNode = callSession.getCurrentNode();
          const { say, next_node, notes, session } = await callSession.processTranscript(transcript);
          console.log(`[Agent] ${prevNode} → ${next_node} | ${say}`);
          if (notes) console.log(`  ↳ notes: ${notes}`);

          // Speak the agent's response
          if (say && tts) {
            tts.sendText(say);
          }

          // Handle terminal nodes — log session and hang up after TTS drains
          if (callSession.isTerminal()) {
            console.log(`\n[Call ended] outcome=${session.call_outcome} | node=${next_node}`);
            console.log('[Final Session]', JSON.stringify(session, null, 2));
            setTimeout(() => ws.close(), 4000);
          }
        });

        // Initialize the agent session
        callSession = createCallSession(callerPhone);

        // Wait for TTS + ASR connections AND the welcome text in parallel
        const [welcomeText] = await Promise.all([
          callSession.getWelcome(),
          tts.waitReady(),
          asr.waitReady()
        ]);

        // Now TTS is guaranteed ready — speak the welcome
        console.log(`[Welcome] ${welcomeText}`);
        if (tts && welcomeText) {
          tts.sendText(welcomeText);
          tts.flush();
        }

        break;
      }

      case 'media': {
        // Forward raw mulaw audio from Twilio to ElevenLabs ASR
        asr?.sendAudio(msg.media.payload);
        break;
      }

      case 'stop': {
        console.log('[WS] Stream stopped');
        asr?.close();
        break;
      }
    }
  });

  ws.on('close', () => {
    console.log('[WS] Connection closed');
    asr?.close();
    tts?.close();

    if (callSession) {
      const session = callSession.getSession();
      console.log('[Final Session]', JSON.stringify(session, null, 2));
    }
  });

  ws.on('error', (err) => {
    console.error('[WS] Error:', err.message);
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[Server] Running on port ${PORT}`);
});
