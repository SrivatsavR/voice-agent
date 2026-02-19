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
             * ElevenLabs Scribe V2 Realtime Protocol (v5-fix):
             * 1. URL params for config.
             * 2. Headers for auth.
             * 3. No manual 'config' message.
             * 4. Audio chunks use 'audio_base_64' (standard) or 'audio'.
             */
            const params = new URLSearchParams({
                model_id: 'scribe_v2_realtime',
                audio_format: 'ulaw_8000',
                inactivity_timeout: '180'
            });
            const url = `wss://api.elevenlabs.io/v1/speech-to-text/realtime?${params.toString()}`;

            this.ws = new WebSocket(url, {
                headers: {
                    'xi-api-key': apiKey
                }
            });

            this.ws.on('open', () => {
                console.log('[ASR] Connected to ElevenLabs Scribe V2 Realtime');
                this.isReady = true;
                resolve();
            });

            this.ws.on('message', (data) => {
                try {
                    const response = JSON.parse(data);
                    const msgType = response.message_type || response.type;

                    if (msgType === 'transcript' || msgType === 'final_transcript' || msgType === 'committed_transcript_with_timestamps') {
                        // Check both 'text' and 'transcript' fields to be safe.
                        const text = (response.text || response.transcript || response.data?.text || '').trim();
                        if (text && this.onTranscript) {
                            console.log(`[ASR] FINAL: ${text}`);
                            this.onTranscript(text);
                        }
                    } else if (msgType === 'partial_transcript') {
                        const text = (response.text || response.transcript || '').trim();
                        if (text) console.log(`[ASR] partial: ${text}`);
                    } else if (msgType === 'input_error' || msgType === 'error') {
                        console.error('[ASR] Server error:', response.error || response.message || JSON.stringify(response));
                    } else if (msgType === 'session_begin' || msgType === 'session_started') {
                        console.log(`[ASR] Session started by server (${msgType})`);
                    } else {
                        // console.log(`[ASR] Message received: ${msgType}`);
                    }
                } catch (err) {
                    // Ignore binary or non-JSON
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
            // Sending both audio_base_64 and audio for maximal compatibility.
            // Scribe V2 Realtime uses 'audio_base_64', but some legacy variants use 'audio'.
            this.ws.send(JSON.stringify({
                message_type: 'input_audio_chunk',
                audio_base_64: base64Audio,
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
            try {
                // Using an empty audio chunk as EOS instead of message_type: 'eos'
                this.ws.send(JSON.stringify({
                    message_type: 'input_audio_chunk',
                    audio_base_64: ""
                }));
            } catch { }
            this.ws.close();
        }
    }
}
