import { WebSocket } from 'ws';

/**
 * Manages the WebSocket connection to ElevenLabs ASR (Scribe v2 Realtime).
 * Feed audio chunks via sendAudio(). Transcripts are delivered via onTranscript callback.
 */
export class ElevenLabsASR {
    constructor(onTranscript) {
        this.onTranscript = onTranscript;
        this.ws = null;
        this.isReady = false;
        this._connectPromise = this._connect();
    }

    _connect() {
        return new Promise((resolve) => {
            const apiKey = process.env.ELEVENLABS_API_KEY;

            /**
             * Based on ElevenLabs Scribe V2 Realtime documentation:
             * 1. Configuration is passed via query parameters.
             * 2. Authentication is via 'xi-api-key' header.
             * 3. No explicit "config" JSON message is sent if params are in the URL.
             * 4. Audio chunks use 'audio_base_64' field.
             */
            const params = new URLSearchParams({
                model_id: 'scribe_v2_realtime',
                audio_format: 'ulaw_8000'
            });
            const url = `wss://api.elevenlabs.io/v1/speech-to-text/realtime?${params.toString()}`;

            console.log(`[ASR] Connecting to: ${url}`);
            this.ws = new WebSocket(url, {
                headers: {
                    'xi-api-key': apiKey
                }
            });

            this.ws.on('open', () => {
                console.log('[ASR] WebSocket open, ready to stream...');
                this.isReady = true;
                resolve();
            });

            this.ws.on('message', (data) => {
                try {
                    const response = JSON.parse(data);
                    // Log all messages to see the protocol flow (session_begin, etc.)
                    // console.log('[ASR] Message:', JSON.stringify(response));

                    const msgType = response.message_type || response.type;

                    if (msgType === 'transcript' || msgType === 'final_transcript' || msgType === 'committed_transcript_with_timestamps') {
                        const text = (response.text || response.data?.text || '').trim();
                        if (text && this.onTranscript) {
                            console.log(`[ASR] FINAL: ${text}`);
                            this.onTranscript(text);
                        }
                    } else if (msgType === 'partial_transcript') {
                        const text = (response.text || '').trim();
                        if (text) console.log(`[ASR] partial: ${text}`);
                    } else if (msgType === 'input_error' || msgType === 'error') {
                        console.error('[ASR] Server error:', response.error || response.message || JSON.stringify(response));
                    } else if (msgType === 'session_begin') {
                        console.log('[ASR] Session started by server');
                    }
                } catch (err) {
                    // Ignore non-JSON messages if any
                }
            });

            this.ws.on('error', (err) => {
                console.error('[ASR] WebSocket Error:', err.message);
                this.isReady = false;
                resolve();
            });

            this.ws.on('close', (code, reason) => {
                console.log(`[ASR] Disconnected (code=${code}, reason=${reason})`);
                this.isReady = false;
                resolve();
            });
        });
    }

    sendAudio(base64Audio) {
        if (this.ws?.readyState === WebSocket.OPEN && this.isReady) {
            // Field name must be 'audio_base_64' for Scribe V2 Realtime
            this.ws.send(JSON.stringify({
                message_type: 'input_audio_chunk',
                audio_base_64: base64Audio
            }));
        }
    }

    async waitReady() {
        await this._connectPromise;
    }

    close() {
        this.isReady = false;
        if (this.ws?.readyState === WebSocket.OPEN) {
            try { this.ws.send(JSON.stringify({ message_type: 'eos' })); } catch { }
            this.ws.close();
        }
    }
}
