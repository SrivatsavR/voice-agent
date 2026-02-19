import { WebSocket } from 'ws';

/**
 * ElevenLabs TTS (Rachel / Flash v2.5 / Mulaw 8kHz)
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
        this._heartbeatInterval = null;
        this._connectPromise = this._connect();
    }

    _connect() {
        return new Promise((resolve) => {
            const apiKey = process.env.ELEVENLABS_API_KEY;

            // max inactivity_timeout = 180s
            const url = `wss://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream-input?model_id=${MODEL_ID}&output_format=${OUTPUT_FORMAT}&inactivity_timeout=180`;

            this.ws = new WebSocket(url, {
                headers: { 'xi-api-key': apiKey }
            });

            this.ws.on('open', () => {
                this.isReady = true;
                console.log('[TTS] Connected');

                // IMPORTANT: Send a Beginning-of-Stream with voice settings to ensure stability
                this.ws.send(JSON.stringify({
                    text: " ",
                    voice_settings: { stability: 0.5, similarity_boost: 0.8 },
                    generation_config: { chunk_length_schedule: [50] }
                }));

                this._startHeartbeat();
                resolve();
            });

            this.ws.on('message', (data) => {
                try {
                    // ElevenLabs sends audio as base64 strings in JSON.
                    // We must convert Buffer or ArrayBuffer to string before parsing.
                    const text = data.toString();
                    if (!text.startsWith('{')) return; // Skip binary pings/frames to avoid static noise

                    const response = JSON.parse(text);
                    if (response.audio) {
                        this._sendToTwilio(response.audio);
                    }
                    if (response.error) {
                        console.error('[TTS] Server error:', response.error);
                    }
                } catch (err) {
                    // Ignore parsing errors for pings/binary data
                }
            });

            this.ws.on('error', (err) => {
                console.error('[TTS] Error:', err.message);
                this.isReady = false;
                this._stopHeartbeat();
                resolve();
            });

            this.ws.on('close', (code, reason) => {
                console.log(`[TTS] Closed (code=${code}, reason=${reason})`);
                this.isReady = false;
                this._stopHeartbeat();
                resolve();
            });
        });
    }

    _startHeartbeat() {
        this._stopHeartbeat();
        // Send a space character every 15s to prevent the 20s inactivity disconnect
        this._heartbeatInterval = setInterval(() => {
            if (this.isReady && this.ws?.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({ text: " " }));
            }
        }, 15000);
    }

    _stopHeartbeat() {
        if (this._heartbeatInterval) {
            clearInterval(this._heartbeatInterval);
            this._heartbeatInterval = null;
        }
    }

    async waitReady() {
        await this._connectPromise;
    }

    sendText(text) {
        if (this.isReady && text && this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({
                text: text + " ",
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
        this._stopHeartbeat();
        if (this.ws?.readyState === WebSocket.OPEN) {
            try { this.ws.send(JSON.stringify({ text: "" })); } catch { }
            this.ws.close();
        }
    }
}
