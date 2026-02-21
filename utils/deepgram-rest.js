import fetch from 'node-fetch';

/**
 * Deepgram Pre-recorded (REST) API Wrapper
 * Used for ultra-accurate correction of specific bursts (like GST numbers)
 */
export async function transcribeAudioBurst(buffer, options = {}) {
    if (!buffer || buffer.length === 0) return null;

    const apiKey = process.env.DEEPGRAM_API_KEY;
    const {
        model = 'nova-2',
        smart_format = true,
        punctuate = true,
        language = 'hi' // Default to Hindi as per core settings
    } = options;

    const url = `https://api.deepgram.com/v1/listen?model=${model}&smart_format=${smart_format}&punctuate=${punctuate}&language=${language}`;

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Token ${apiKey}`,
                'Content-Type': 'audio/mulaw', // Matches Twilio L16-to-mulaw codec used in this platform
            },
            body: buffer
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Deepgram REST error: ${response.status} - ${error}`);
        }

        const result = await response.json();
        const transcript = result.results?.channels[0]?.alternatives[0]?.transcript;

        return {
            transcript,
            confidence: result.results?.channels[0]?.alternatives[0]?.confidence,
            raw: result
        };
    } catch (err) {
        console.error('[DeepgramREST] Transcription failed:', err);
        return null;
    }
}
