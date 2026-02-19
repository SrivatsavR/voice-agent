import { WebSocket } from 'ws';

const VOICE_ID = '21m00Tcm4TlvDq8ikWAM'; // Rachel
const MODEL_ID = 'eleven_flash_v2_5';
const OUTPUT_FORMAT = 'ulaw_8000';

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
            const apiKey = process.env.ELEVENLABS_API_KEY;

            // Reverting to official headers-based auth as query param auth is not supported for TTS.
            const url = `wss://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream-input?model_id=${MODEL_ID}&output_format=${OUTPUT_FORMAT}`;

            this.ws = new WebSocket(url, {
                headers: {
                    'xi-api-key': apiKey
                }
            });

            this.ws.on('open', () => {
                console.log('[TTS] WebSocket open, sending BOS...');

                // Send Beginning of Stream with voice settings
                // Using a space to ensure the stream starts without closing.
                this.ws.send(JSON.stringify({
                    text: " ",
                    voice_settings: { stability: 0.5, similarity_boost: 0.8 }
                }));

                this.isReady = true;
                console.log('[TTS] Connected to ElevenLabs Flash v2.5');
                resolve();
            });

            this.ws.on('message', (data) => {
                try {
                    const response = JSON.parse(data);
                    if (response.audio) {
                        this._sendToTwilio(response.audio);
                    }
                    if (response.error) {
                        console.error('[TTS] Server error:', response.error);
                    }
                } catch (err) {
                    // Binary audio chunks are not JSON, but the ws library handles them.
                    // If we get an error here, it might just be the audio data.
                }
            });

            this.ws.on('error', (err) => {
                console.error('[TTS] WebSocket Error:', err.message);
                this.isReady = false;
                resolve();
            });

            this.ws.on('close', (code, reason) => {
                console.log(`[TTS] Disconnected (code=${code}, reason=${reason})`);
                this.isReady = false;
                resolve();
            });
        });
    }

    async waitReady() {
        await this._connectPromise;
    }

    sendText(text) {
        if (this.isReady && text && this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({
                text,
                try_trigger_generation: true
            }));
        } else {
            console.warn(`[TTS] Cannot send text. ready=${this.isReady}, wsState=${this.ws?.readyState}`);
        }
    }

    flush() {
        // No-op for now to keep connection persistent throughout the call.
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
            try {
                // Send final EOS signal before closing
                this.ws.send(JSON.stringify({ text: "" }));
            } catch { }
            this.ws.close();
        }
    }
}
