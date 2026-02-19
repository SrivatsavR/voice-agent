import { WebSocket } from 'ws';

/**
 * VOICE_ID: Rachel (Proven, stable voice)
 * MODEL_ID: Flash v2.5 (Fastest for low-latency)
 * OUTPUT_FORMAT: Mulaw 8000Hz (Directly compatible with Twilio)
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
        this._chunksReceived = 0;
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
                // We NO LONGER send a warmup space here to ensure the FIRST real text message
                // gets the full priority and proper generation trigger.
                this.isReady = true;
                console.log('[TTS] Connected to ElevenLabs Flash v2.5 (Ready)');
                this._startHeartbeat();
                resolve();
            });

            this.ws.on('message', (data) => {
                try {
                    this._chunksReceived++;

                    // Handle binary chunks (ElevenLabs often streams raw bytes for Mulaw)
                    if (data instanceof Buffer || data instanceof ArrayBuffer || typeof data !== 'string') {
                        this._sendToTwilio(Buffer.from(data).toString('base64'));
                        return;
                    }

                    const response = JSON.parse(data);
                    if (response.audio) {
                        this._sendToTwilio(response.audio);
                    }

                    if (response.error) {
                        console.error('[TTS] Server error:', response.error);
                    }
                } catch (err) {
                    // Ignore non-standard messages
                }
            });

            this.ws.on('error', (err) => {
                console.error('[TTS] WebSocket Error:', err.message);
                this.isReady = false;
                this._stopHeartbeat();
                resolve();
            });

            this.ws.on('close', (code, reason) => {
                console.log(`[TTS] Disconnected (code=${code}, reason=${reason}) receivedChunks=${this._chunksReceived}`);
                this.isReady = false;
                this._stopHeartbeat();
                resolve();
            });
        });
    }

    _startHeartbeat() {
        this._stopHeartbeat();
        // Send a space every 15s to keep the input stream active during long user silences
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
            console.log(`[TTS] Sending text to ElevenLabs: "${text.substring(0, 30)}..."`);
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
        this._stopHeartbeat();
        if (this.ws?.readyState === WebSocket.OPEN) {
            try {
                // Signal end of stream
                this.ws.send(JSON.stringify({ text: "" }));
            } catch { }
            this.ws.close();
        }
    }
}
