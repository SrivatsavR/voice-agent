import { WebSocket } from 'ws';

/**
 * ElevenLabs TTS WebSocket (Output)
 * We strictly filter JSON messages to extract the 'audio' field.
 * This prevents binary pings or metadata from being sent to Twilio as static.
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

            // max inactivity_timeout = 180s
            const url = `wss://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream-input?model_id=${MODEL_ID}&output_format=${OUTPUT_FORMAT}&inactivity_timeout=180`;

            this.ws = new WebSocket(url, {
                headers: { 'xi-api-key': apiKey }
            });

            this.ws.on('open', () => {
                this.isReady = true;
                console.log('[TTS] Connected to ElevenLabs (v10)');
                resolve();
            });

            this.ws.on('message', (data) => {
                try {
                    // Convert Buffer to string if necessary
                    const messageString = data.toString();

                    // ElevenLabs real-time TTS sends audio within a JSON wrapper.
                    // If we can't parse it as JSON, it's likely a binary ping/metadata frame—ignore it to avoid static.
                    const response = JSON.parse(messageString);

                    if (response.audio) {
                        // Extract base64 mulaw audio and ship to Twilio
                        this._sendToTwilio(response.audio);
                    }

                    if (response.error) {
                        console.error('[TTS] ElevenLabs error:', response.error);
                    }
                } catch (err) {
                    // This catch handles binary pings or malformed frames—ignoring them prevents static noise.
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
            console.log(`[TTS] Generating audio for: "${text.substring(0, 40)}..."`);
            this.ws.send(JSON.stringify({
                text,
                voice_settings: { stability: 0.5, similarity_boost: 0.8 },
                try_trigger_generation: true
            }));
        }
    }

    _sendToTwilio(audioBase64) {
        if (this.twilioWs?.readyState === WebSocket.OPEN) {
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
