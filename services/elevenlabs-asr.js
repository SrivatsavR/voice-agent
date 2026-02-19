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
        this._configResolved = false;
        this._connectRootPromise = null;
        this._sessionBeginPromise = this._connect();
    }

    _connect() {
        return new Promise((resolve) => {
            const apiKey = process.env.ELEVENLABS_API_KEY;

            // Standard ASR realtime endpoint
            const url = `wss://api.elevenlabs.io/v1/speech-to-text/realtime`;

            this.ws = new WebSocket(url, {
                headers: {
                    'xi-api-key': apiKey
                }
            });

            this.ws.on('open', () => {
                console.log('[ASR] WebSocket open, sending handshake JSON...');

                // Config message structure for Scribe V2 Realtime
                const config = {
                    message_type: 'config',
                    model_id: 'scribe_v2_realtime',
                    audio_format: 'ulaw_8000',
                    language_code: 'en',
                    commit_strategy: 'auto',
                    enable_logging: true
                };

                this.ws.send(JSON.stringify(config));
                // We do NOT resolve here. We wait for session_begin or error.
            });

            this.ws.on('message', (data) => {
                try {
                    const response = JSON.parse(data);
                    const msgType = response.message_type || response.type;

                    if (msgType === 'session_begin') {
                        console.log('[ASR] Session established (session_begin)');
                        this.isReady = true;
                        if (!this._configResolved) {
                            this._configResolved = true;
                            resolve();
                        }
                    } else if (msgType === 'transcript' || msgType === 'final_transcript' || msgType === 'committed_transcript_with_timestamps') {
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
                        // If we get an error during handshake, resolve anyway so call doesn't hang, 
                        // but isReady will be false.
                        if (!this._configResolved) {
                            this._configResolved = true;
                            resolve();
                        }
                    }
                } catch (err) {
                    console.error('[ASR] Failed to parse message:', err.message);
                }
            });

            this.ws.on('error', (err) => {
                console.error('[ASR] WebSocket Error:', err.message);
                this.isReady = false;
                if (!this._configResolved) {
                    this._configResolved = true;
                    resolve();
                }
            });

            this.ws.on('close', (code, reason) => {
                console.log(`[ASR] Disconnected (code=${code}, reason=${reason})`);
                this.isReady = false;
                if (!this._configResolved) {
                    this._configResolved = true;
                    resolve();
                }
            });
        });
    }

    sendAudio(base64Audio) {
        if (this.ws?.readyState === WebSocket.OPEN && this.isReady) {
            this.ws.send(JSON.stringify({
                message_type: 'input_audio_chunk',
                audio_base_64: base64Audio
            }));
        }
    }

    async waitReady() {
        await this._sessionBeginPromise;
    }

    close() {
        this.isReady = false;
        if (this.ws?.readyState === WebSocket.OPEN) {
            try { this.ws.send(JSON.stringify({ message_type: 'eos' })); } catch { }
            this.ws.close();
        }
    }
}
