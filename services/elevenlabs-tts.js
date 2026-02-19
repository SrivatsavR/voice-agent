import { WebSocket } from 'ws';

/**
 * ElevenLabs TTS WebSocket (Output)
 * Note: ElevenLabs TTS returns audio as base64 within a JSON message.
 * Sending binary messages to Twilio that aren't verified audio causes static.
 */
const VOICE_ID = '21m00Tcm4TlvDq8ikWAM';
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

            // max inactivity_timeout = 180s. 
            // We removed the "space" heartbeat to prevent any potential low-level noise synthesis.
            const url = `wss://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream-input?model_id=${MODEL_ID}&output_format=${OUTPUT_FORMAT}&inactivity_timeout=180`;

            this.ws = new WebSocket(url, {
                headers: { 'xi-api-key': apiKey }
            });

            this.ws.on('open', () => {
                this.isReady = true;
                console.log('[TTS] Connected to ElevenLabs');
                resolve();
            });

            this.ws.on('message', (data) => {
                try {
                    // CRITICAL: We only process JSON messages. 
                    // Binary messages from ElevenLabs (like pings) should NOT be forwarded to Twilio.
                    if (typeof data !== 'string') return;

                    const response = JSON.parse(data);
                    if (response.audio) {
                        this._sendToTwilio(response.audio);
                    }

                    if (response.error) {
                        console.error('[TTS] Server error:', response.error);
                    }
                } catch (err) {
                    // Ignore parsing errors for non-JSON strings
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
                voice_settings: { stability: 0.5, similarity_boost: 0.8 },
                try_trigger_generation: true
            }));
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
            try {
                this.ws.send(JSON.stringify({ text: "" }));
            } catch { }
            this.ws.close();
        }
    }
}
