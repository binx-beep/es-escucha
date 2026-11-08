// Pure text helpers: normalisation, scoring, alignment, sentence grouping.
// No React or DOM here so everything can be unit-tested with plain Node.

export type Word = { raw: string; norm: string; loose: string };
export type TimedWord = { text: string; start: number; end: number };
export type Segment = { start: number; end: number; text: string; words?: TimedWord[] };
export type SentenceItem = { word: Word; index: number; timing: TimedWord };
export type SentenceGroup = { start: number; end: number; items: SentenceItem[]; text: string };

const ACCENTS: Record<string, string> = { á: "a", é: "e", í: "i", ó: "o", ú: "u", ü: "u" };

/** Lower-case, keep letters (incl. Spanish accents and ñ) and digits only. */
export const norm = (s: string) => s.normalize("NFC").toLocaleLowerCase("es").replace(/[^a-záéíóúüñ0-9]+/gi, "");
/** Same as norm, but accents folded (ñ is kept: it is a different letter). */
export const loose = (s: string) => norm(s).replace(/[áéíóúü]/g, (c) => ACCENTS[c]);

export const words = (s: string): Word[] =>
    s.split(/\s+/).map((raw) => ({ raw, norm: norm(raw), loose: loose(raw) })).filter((x) => x.norm);

export const countWords = (s: string) => {
    let n = 0;
    for (const raw of s.split(/\s+/)) if (norm(raw)) n++;
    return n;
};

export const time = (n: number) => `${Math.floor(n / 60)}:${String(Math.floor(n % 60)).padStart(2, "0")}`;
export const size = (n: number) =>
    !n ? "0 MB" : n >= 1073741824 ? `${(n / 1073741824).toFixed(2)} GB` : `${Math.max(0.1, n / 1048576).toFixed(1)} MB`;

export type Comparison = {
    /** reference indices (relative to the `ref` array) that were heard correctly */
    hits: Set<number>;
    /** reference indices matched only when accents are ignored (e.g. esta / está) */
    accentOnly: Set<number>;
    /** strict score and accent-tolerant score, 0-100 */
    accuracy: number;
    looseAccuracy: number;
    total: number;
};

/**
 * Longest-common-subsequence on accent-folded words, using one flat typed array
 * (much faster and lighter than an array of JS arrays for long transcripts).
 */
export function compareWords(ref: Word[], draft: Word[]): Comparison {
    const n = ref.length, m = draft.length;
    const hits = new Set<number>(), accentOnly = new Set<number>();
    if (!n || !m) return { hits, accentOnly, accuracy: 0, looseAccuracy: 0, total: n };
    const cols = m + 1;
    const big = n * cols > 50_000_000;
    // LCS length never exceeds min(n, m); Uint16 halves memory when it fits.
    const dp = Math.min(n, m) < 65535 && !big ? new Uint16Array((n + 1) * cols) : new Uint32Array((n + 1) * cols);
    for (let i = n - 1; i >= 0; i--) {
        const a = ref[i].loose, row = i * cols, next = row + cols;
        for (let j = m - 1; j >= 0; j--) {
            dp[row + j] = a === draft[j].loose ? dp[next + j + 1] + 1 : Math.max(dp[next + j], dp[row + j + 1]);
        }
    }
    let i = 0, j = 0;
    while (i < n && j < m) {
        if (ref[i].loose === draft[j].loose) {
            if (ref[i].norm === draft[j].norm) hits.add(i); else accentOnly.add(i);
            i++; j++;
        } else if (dp[(i + 1) * cols + j] >= dp[i * cols + j + 1]) i++;
        else j++;
    }
    const denom = Math.max(n, m);
    return {
        hits, accentOnly, total: n,
        accuracy: Math.round((hits.size / denom) * 100),
        looseAccuracy: Math.round(((hits.size + accentOnly.size) / denom) * 100),
    };
}

/**
 * Display-only alignment of the free-typed draft against reference words
 * (accent-folded keys). Every draft character is kept and attached to a reference word.
 */
export function alignDraft(reference: string[], draft: string): string[] {
    const tokens: { raw: string; key: string }[] = [];
    let prefix = "";
    for (const raw of draft.match(/\S+\s*/g) || []) {
        const key = loose(raw);
        if (key) { tokens.push({ raw: prefix + raw, key }); prefix = ""; }
        else if (tokens.length) tokens[tokens.length - 1].raw += raw;
        else prefix += raw;
    }
    const n = reference.length, m = tokens.length;
    if (!n) return [];
    const cols = m + 1;
    const dp = new Uint32Array((n + 1) * cols);
    for (let i = 0; i <= n; i++) dp[i * cols + m] = n - i;
    for (let j = 0; j <= m; j++) dp[n * cols + j] = m - j;
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
        const cost = reference[i] === tokens[j].key ? 0 : 1;
        dp[i * cols + j] = Math.min(dp[(i + 1) * cols + j + 1] + cost, dp[(i + 1) * cols + j] + 1, dp[i * cols + j + 1] + 1);
    }
    const result = Array<string>(n).fill("");
    if (!m) { result[0] = prefix; return result; }
    let i = 0, j = 0;
    while (j < m) {
        if (i === n) { result[n - 1] += tokens[j++].raw; continue; }
        const cost = reference[i] === tokens[j].key ? 0 : 1;
        if (dp[i * cols + j] === dp[(i + 1) * cols + j + 1] + cost) result[i++] += tokens[j++].raw;
        else if (dp[i * cols + j] === dp[(i + 1) * cols + j] + 1) i++;
        else result[i] += tokens[j++].raw; // insertions attach to the next reference word
    }
    return result;
}

/** Split recognised segments into sentences (by end punctuation, max 25 words) with per-word timing. */
export function groupSentences(segments: Segment[]): { groups: SentenceGroup[]; all: Word[] } {
    const groups: SentenceGroup[] = [], all: Word[] = [];
    let index = 0;
    const push = (items: SentenceItem[]) => groups.push({
        start: items[0].timing.start,
        end: items[items.length - 1].timing.end,
        items,
        text: items.map((x) => x.word.raw).join(" ").replace(/\s+/g, " ").trim(),
    });
    for (const segment of segments) {
        const list = words(segment.text);
        const duration = Math.max(0, segment.end - segment.start), count = Math.max(1, list.length);
        let items: SentenceItem[] = [];
        list.forEach((word, k) => {
            const w = segment.words?.[k];
            const timing = {
                text: word.raw,
                start: w?.start ?? segment.start + (duration * k) / count,
                end: w?.end ?? segment.start + (duration * (k + 1)) / count,
            };
            items.push({ word, index, timing });
            all.push(word);
            index++;
            if (/[.!?…]+["”’)\]]*$/.test(word.raw) || items.length >= 25) { push(items); items = []; }
        });
        if (items.length) push(items);
    }
    return { groups, all };
}

/** Index of the sentence playing at time t (last sentence that started before t). */
export function sentenceAt(groups: SentenceGroup[], t: number): number {
    let lo = 0, hi = groups.length - 1, found = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (groups[mid].start <= t + 0.05) { found = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return found;
}

/** CSV cell escaping (Excel / Anki friendly). */
export const csvCell = (v: unknown) => {
    const s = String(v ?? "");
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
