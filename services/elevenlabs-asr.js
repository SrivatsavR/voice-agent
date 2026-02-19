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

            const params = new URLSearchParams({
                model_id: 'scribe_v2_realtime',
                audio_format: 'ulaw_8000'
            });
            const url = `wss://api.elevenlabs.io/v1/speech-to-text/realtime?${params.toString()}`;

            this.ws = new WebSocket(url, {
                headers: { 'xi-api-key': apiKey }
            });

            this.ws.on('open', () => {
                console.log('[ASR] Connected to ElevenLabs Scribe V2');
                this.isReady = true;
                resolve();
            });

            this.ws.on('message', (data) => {
                try {
                    const response = JSON.parse(data);
                    const msgType = response.type || response.message_type;

                    if (msgType === 'transcript' || msgType === 'committed_transcript' || msgType === 'final_transcript') {
                        const text = (response.transcript || response.text || '').trim();
                        if (text && this.onTranscript) {
                            console.log(`[ASR] ${msgType.toUpperCase()}: ${text}`);
                            this.onTranscript(text);
                        }
                    } else if (msgType === 'partial_transcript') {
                        const text = (response.transcript || response.text || '').trim();
                        if (text) console.log(`[ASR] partial: ${text}`);
                    } else if (msgType === 'error' || response.error) {
                        console.error('[ASR] Server error:', response.error || response.message || JSON.stringify(response));
                    } else if (msgType === 'session_started') {
                        console.log(`[ASR] Session started`);
                    }
                } catch (err) {
                    // Ignore binary
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
            if (!base64Audio) return;
            const buffer = Buffer.from(base64Audio, 'base64');
            if (buffer.length === 0) return;

            // Scribe V2 Realtime expects raw binary audio frames
            this.ws.send(buffer);
        }
    }

    async waitReady() {
        await this._connectPromise;
    }

    close() {
        this.isReady = false;
        if (this.ws?.readyState === WebSocket.OPEN) {
            try {
                // Send an empty binary frame to signal EOS if needed
                this.ws.send(Buffer.alloc(0));
            } catch { }
            this.ws.close();
        }
    }
}
