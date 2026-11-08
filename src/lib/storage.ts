// Small localStorage layer. Every access is guarded: storage can be missing or throw.
import type { Entry, ModelId, Video } from "./api";
import type { Segment } from "./text";

const P = "escucha2:";

function read<T>(key: string, fallback: T): T {
    try {
        const s = localStorage.getItem(P + key);
        return s ? (JSON.parse(s) as T) : fallback;
    } catch {
        return fallback;
    }
}
function write(key: string, value: unknown) {
    try { localStorage.setItem(P + key, JSON.stringify(value)); } catch { /* full or blocked */ }
}

export type DictationStyle = "whole" | "sentence";
/** What the learner typed for one video. Small, so it is saved while typing. */
export type MediaRecord = {
    draft: string;
    sentenceDrafts: Record<number, string>;
    checked: number[];
    cursor: number;
    style: DictationStyle;
};
export const emptyRecord = (): MediaRecord => ({ draft: "", sentenceDrafts: {}, checked: [], cursor: 0, style: "sentence" });

export const loadRecord = (key: string): MediaRecord => ({ ...emptyRecord(), ...read<Partial<MediaRecord>>(`media:${key}`, {}) });
export const saveRecord = (key: string, rec: MediaRecord) => {
    if (key !== "empty") write(`media:${key}`, rec);
};

/** Subtitles are large and change only after recognition, so they live under their own key. */
export const loadSegments = (key: string) => read<Segment[]>(`subs:${key}`, []);
export const saveSegments = (key: string, segments: Segment[]) => {
    if (key !== "empty") write(`subs:${key}`, segments);
};

export const loadWordBank = () => read<Entry[]>("wordbank", []);
export const saveWordBank = (entries: Entry[]) => write("wordbank", entries);

export const loadRecent = () => read<Video[]>("recent", []);
export const saveRecent = (v: Video[]) => write("recent", v.slice(0, 30));

export type Prefs = { model: ModelId; rate: number; loop: boolean; ignoreAccents: boolean; showComparison: boolean };
export const defaultPrefs: Prefs = { model: "turbo", rate: 1, loop: false, ignoreAccents: false, showComparison: true };
export const loadPrefs = (): Prefs => ({ ...defaultPrefs, ...read<Partial<Prefs>>("prefs", {}) });
export const savePrefs = (p: Prefs) => write("prefs", p);
