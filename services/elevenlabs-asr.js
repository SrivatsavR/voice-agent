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

            // All configuration passed via query parameters as per the ElevenLabs Scribe API Reference.
            // This includes the API key for maximal environment compatibility.
            const params = new URLSearchParams({
                'xi-api-key': apiKey,
                'model_id': 'scribe_v2_realtime',
                'audio_format': 'ulaw_8000',
                'commit_strategy': 'auto',
                'enable_logging': 'true'
            });
            const url = `wss://api.elevenlabs.io/v1/speech-to-text/realtime?${params.toString()}`;

            this.ws = new WebSocket(url);

            this.ws.on('open', () => {
                console.log('[ASR] Connected to ElevenLabs Scribe V2 Realtime');
                // We assume readiness immediately as config is in the URL.
                this.isReady = true;
                resolve();
            });

            this.ws.on('message', (data) => {
                try {
                    const response = JSON.parse(data);
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
                    }
                } catch (err) {
                    console.error('[ASR] Failed to parse message:', err.message);
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
            // Using 'audio_base_64' as the field name as per ElevenLabs Scribe V2 Realtime documentation.
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
