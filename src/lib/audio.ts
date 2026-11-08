import type { API } from "./api";

/** 16-bit PCM mono WAV at 16 kHz (what whisper.cpp expects). */
export function encodeWav(samples: Float32Array, sampleRate = 16000): ArrayBuffer {
    const buffer = new ArrayBuffer(44 + samples.length * 2), v = new DataView(buffer);
    const tag = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    tag(0, "RIFF"); v.setUint32(4, 36 + samples.length * 2, true); tag(8, "WAVE"); tag(12, "fmt ");
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    tag(36, "data"); v.setUint32(40, samples.length * 2, true);
    const out = new Int16Array(buffer, 44, samples.length);
    for (let i = 0; i < samples.length; i++) {
        const x = samples[i] < -1 ? -1 : samples[i] > 1 ? 1 : samples[i];
        out[i] = x < 0 ? x * 32768 : x * 32767;
    }
    return buffer;
}

/** Read the media file without copying it through IPC when possible. */
async function readBytes(desktop: API, path: string): Promise<ArrayBuffer> {
    try {
        const res = await fetch(desktop.mediaFetchUrl(path));
        if (res.ok) return await res.arrayBuffer();
    } catch { /* fall back below */ }
    const bytes = await desktop.readMedia(path);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/**
 * Decode any audio/video file straight to 16 kHz: decodeAudioData on a 16 kHz
 * OfflineAudioContext resamples while decoding, so no extra render pass is needed.
 */
export async function extractWav(desktop: API, path: string, isCancelled: () => boolean): Promise<ArrayBuffer | null> {
    const data = await readBytes(desktop, path);
    if (isCancelled()) return null;
    const ctx = new OfflineAudioContext(1, 1, 16000);
    const decoded = await ctx.decodeAudioData(data);
    if (isCancelled()) return null;
    const channels = decoded.numberOfChannels, length = decoded.length;
    let mono: Float32Array;
    if (channels === 1) mono = decoded.getChannelData(0);
    else {
        mono = new Float32Array(length);
        for (let c = 0; c < channels; c++) {
            const d = decoded.getChannelData(c);
            for (let i = 0; i < length; i++) mono[i] += d[i];
        }
        const k = 1 / channels;
        for (let i = 0; i < length; i++) mono[i] *= k;
    }
    return encodeWav(mono);
}
