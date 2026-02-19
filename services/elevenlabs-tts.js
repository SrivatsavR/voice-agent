import { WebSocket } from 'ws';

const VOICE_ID = '21m00Tcm4TlvDq8ikWAM'; // Rachel
const ELEVENLABS_WS_URL = `wss://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream-input?model_id=eleven_flash_v2_5&output_format=ulaw_8000`;

export class ElevenLabsTTS {
    constructor(twilioWs, streamSid) {
        this.twilioWs = twilioWs;
        this.streamSid = streamSid;
        this.ws = null;
        this.isReady = false;
        this._connectPromise = this._connect();
    }

    _connect() {
        return new Promise((resolve) => {
            this.ws = new WebSocket(ELEVENLABS_WS_URL);

            this.ws.on('open', () => {
                console.log('[TTS] WebSocket open, sending BOS...');
                this.isReady = true;

                // Send BOS (Beginning of Stream) with voice settings
                this.ws.send(JSON.stringify({
                    text: " ",
                    voice_settings: { stability: 0.5, similarity_boost: 0.8 },
                    xi_api_key: process.env.ELEVENLABS_API_KEY
                }));

                console.log('[TTS] Connected to ElevenLabs Flash v2.5');
                resolve();
            });

            this.ws.on('message', (data) => {
                try {
                    const response = JSON.parse(data);
                    if (response.audio) {
                        this._sendToTwilio(response.audio);
                    }
                } catch (err) {
                    console.error('[TTS] Failed to parse message:', err.message);
                }
            });

            this.ws.on('error', (err) => {
                console.error('[TTS] Error:', err.message);
                this.isReady = false;
                resolve();
            });

            this.ws.on('close', () => {
                console.log('[TTS] Disconnected');
                this.isReady = false;
                resolve();
            });
        });
    }

    /**
     * Wait for the TTS connection to be ready.
     */
    async waitReady() {
        await this._connectPromise;
    }

    sendText(text) {
        if (this.isReady && text) {
            this.ws.send(JSON.stringify({
                text,
                try_trigger_generation: true,
                xi_api_key: process.env.ELEVENLABS_API_KEY
            }));
        }
    }

    flush() {
        if (this.isReady) {
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
        this.isReady = false;
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.close();
        }
    }
}
