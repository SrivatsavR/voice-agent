import { WebSocket } from 'ws';

const ELEVENLABS_WS_URL = 'wss://api.elevenlabs.io/v1/speech-to-text/realtime';

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
            // Use query params for model_id, and xi-api-key header for auth
            const url = `${ELEVENLABS_WS_URL}?model_id=scribe_v2_realtime`;

            this.ws = new WebSocket(url, {
                headers: {
                    'xi-api-key': apiKey
                }
            });

            this.ws.on('open', () => {
                console.log('[ASR] WebSocket open, sending config...');

                // Send config message for audio format and VAD
                const initMessage = {
                    message_type: 'config',
                    audio_format: 'ulaw_8000',
                    commit_strategy: 'auto',
                    vad_silence_threshold_secs: 1.0,
                    vad_threshold: 0.4,
                    min_speech_duration_ms: 100,
                    min_silence_duration_ms: 300,
                    enable_logging: true
                };
                this.ws.send(JSON.stringify(initMessage));

                this.isReady = true;
                console.log('[ASR] Connected and configured');
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
                    } else if (msgType === 'auth_error' || msgType === 'error') {
                        console.error('[ASR] Server error:', response.error || response.message || JSON.stringify(response));
                    } else if (msgType === 'session_begin' || msgType === 'config_ack' || msgType === 'ready') {
                        console.log('[ASR] Session started / config acknowledged');
                    } else {
                        console.log('[ASR] Message:', JSON.stringify(response).substring(0, 300));
                    }
                } catch (err) {
                    console.error('[ASR] Failed to parse message:', err.message);
                }
            });

            this.ws.on('error', (err) => {
                console.error('[ASR] Error:', err.message);
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
            this.ws.send(JSON.stringify({
                message_type: 'input_audio_chunk',
                audio: base64Audio
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
