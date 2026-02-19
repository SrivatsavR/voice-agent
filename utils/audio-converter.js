import { WaveFile } from 'wavefile';

/**
 * Decodes Mulaw base64 string to 16-bit PCM buffer (Twilio is 8kHz Mulaw).
 * Used only if ElevenLabs ASR requires PCM instead of Mulaw input.
 * @param {string} mulawBase64
 * @returns {Buffer}
 */
export function mulawToPcm(mulawBase64) {
    const mulawBuffer = Buffer.from(mulawBase64, 'base64');
    const wav = new WaveFile();
    wav.fromScratch(1, 8000, '8m', mulawBuffer);
    wav.fromMuLaw();
    return Buffer.from(wav.data.samples);
}

/**
 * Encodes 16-bit PCM buffer to Mulaw base64 string.
 * Used only if ElevenLabs TTS returns PCM and Twilio needs Mulaw.
 * @param {Buffer} pcmBuffer
 * @returns {string}
 */
export function pcmToMulaw(pcmBuffer) {
    const wav = new WaveFile();
    wav.fromScratch(1, 8000, '16', pcmBuffer);
    wav.toMuLaw();
    return Buffer.from(wav.data.samples).toString('base64');
}
