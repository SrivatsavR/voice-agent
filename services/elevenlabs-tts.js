import { WebSocket } from 'ws';

const VOICE_ID = '21m00Tcm4TlvDq8ikWAM'; // Rachel — change to any ElevenLabs voice ID
// Request ulaw_8000 output so Twilio can play it directly without conversion
const ELEVENLABS_WS_URL = `wss://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream-input?model_id=eleven_flash_v2_5&output_format=ulaw_8000`;

export class ElevenLabsTTS {
    constructor(twilioWs, streamSid) {
        this.twilioWs = twilioWs;
        this.streamSid = streamSid;
        this.ws = null;
        this.isReady = false;
        this._connect();
    }

    _connect() {
        this.ws = new WebSocket(ELEVENLABS_WS_URL);

        this.ws.on('open', () => {
            console.log('[TTS] Connected to ElevenLabs');
            this.isReady = true;

            // Send BOS (Beginning of Stream) with voice settings
            this.ws.send(JSON.stringify({
                text: " ",
                voice_settings: { stability: 0.5, similarity_boost: 0.8 },
                xi_api_key: process.env.ELEVENLABS_API_KEY
            }));
        });

        this.ws.on('message', (data) => {
            try {
                const response = JSON.parse(data);
                if (response.audio) {
                    // response.audio is base64 ulaw_8000, send directly to Twilio
                    this._sendToTwilio(response.audio);
                }
            } catch (err) {
                console.error('[TTS] Failed to parse message:', err);
            }
        });

        this.ws.on('error', (err) => {
            console.error('[TTS] Error:', err.message);
        });

        this.ws.on('close', () => {
            console.log('[TTS] Disconnected');
            this.isReady = false;
        });
    }

    /**
     * Send a text chunk to ElevenLabs for synthesis.
     * Call this for each chunk received from the LLM stream.
     * @param {string} text 
     */
    sendText(text) {
        if (this.isReady && text) {
            this.ws.send(JSON.stringify({
                text,
                try_trigger_generation: true, // generate audio as soon as possible
                xi_api_key: process.env.ELEVENLABS_API_KEY
            }));
        }
    }

    /**
     * Signal end of the current utterance — flushes any buffered audio.
     */
    flush() {
        if (this.isReady) {
            // Sending empty string signals ElevenLabs to flush remaining audio
            this.ws.send(JSON.stringify({ text: "" }));
        }
    }

    _sendToTwilio(audioBase64) {
        if (this.twilioWs.readyState === WebSocket.OPEN) {
            this.twilioWs.send(JSON.stringify({
                event: 'media',
                streamSid: this.streamSid,
                media: { payload: audioBase64 }
            }));
        }
    }

    close() {
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.close();
        }
    }
}
