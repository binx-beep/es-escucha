import type { Segment } from "./text";

export type FocusKind = "none" | "player" | "text";
export type Mode = "dictation" | "check" | "words" | "settings";
export type ModelId = "small" | "turbo" | "large";
export type Platform = "TikTok" | "YouTube";

export type RecognitionProgress = {
    stage: "download" | "extract" | "recognize" | "done" | "error";
    percent: number;
    message: string;
    jobId: string;
    mediaKey: string;
};
export type PlaybackSource = { url: string; token: string; videoId: string };
export type DownloadedFile = { name: string; size: number; modified: number };
export type Media = { path: string; url: string; name: string };
export type Video = { id: string; platform: Platform; title: string; url: string; thumbnail: string; duration: number };

export type EntryType = "vocab" | "missed" | "phonetic";
/** Where a saved word came from, so it can be replayed from any video. */
export type EntrySource = { key: string; title: string; video?: Video; media?: Media };
export type Entry = {
    id: string;
    phrase: string;
    type: EntryType;
    sentence: string;
    start: number;
    end: number;
    draft: string;
    createdAt: number;
    source: EntrySource;
};

export type Settings = {
    cleanupPolicy: "immediate" | "7days" | "2gb" | "never";
    speed: "fast" | "accurate";
    threads: "auto" | number;
    vad: boolean;
};
export type Stats = {
    temp: number;
    media: number;
    models: number;
    records: number;
    settings: Settings;
    root: string;
    cpuCount: number;
    autoThreads: number;
    vadModel: boolean;
    legacyModels: boolean;
};
export type TranscribeResult = { segments: Segment[]; mediaDeleted: boolean };

export type API = {
    pickMedia(): Promise<Media | null>;
    readMedia(p: string): Promise<Uint8Array>;
    saveWav(b: ArrayBuffer): Promise<string>;
    modelStatus(): Promise<Record<ModelId, boolean>>;
    downloadModel(id: ModelId): Promise<boolean>;
    deleteModel(id: ModelId): Promise<boolean>;
    downloadVadModel(): Promise<boolean>;
    transcribe(v: { wavPath: string; modelId: ModelId; jobId: string; mediaKey: string; mediaPath: string }): Promise<TranscribeResult>;
    cancelRecognition(jobId: string): Promise<boolean>;
    cacheStats(): Promise<Stats>;
    clearCache(k: "temp" | "media"): Promise<boolean>;
    saveSettings(v: Partial<Settings>): Promise<Settings>;
    chooseStorageRoot(): Promise<string | null>;
    updateParser(): Promise<string>;
    exportText(v: { name: string; content: string }): Promise<string | null>;
    resolveVideo(u: string): Promise<Video>;
    downloadOnlineVideo(v: { item: Video; jobId: string; mediaKey: string }): Promise<Media>;
    prepareTikTokPlayback(v: Video): Promise<PlaybackSource>;
    refreshTikTokPlayback(videoId: string): Promise<PlaybackSource>;
    releaseTikTokPlayback(videoId: string): Promise<boolean>;
    listDownloadedVideos(): Promise<DownloadedFile[]>;
    openDownloadedVideosFolder(): Promise<boolean>;
    deleteDownloadedVideos(names: string[]): Promise<string[]>;
    openTikTokLogin(): Promise<boolean>;
    getTikTokLoginStatus(): Promise<boolean>;
    logoutTikTok(): Promise<boolean>;
    /** Where keyboard focus is, so the main process knows which arrow keys belong to the player. */
    setFocusKind(kind: FocusKind): void;
    mediaFetchUrl(path: string): string;
    onModelProgress(c: (v: { id: ModelId | "vad"; percent: number }) => void): () => void;
    onOnlineStatus(c: (v: string) => void): () => void;
    onRecognitionProgress(c: (v: RecognitionProgress) => void): () => void;
    onPlayerKey(c: (v: string) => void): () => void;
};

declare global {
    interface Window { desktopAPI?: API }
}

export const api = () => window.desktopAPI;

/** Main-process errors look like "CODE|中文说明"; show only the explanation. */
export const cleanError = (e: unknown, fallback = "读取失败，请稍后重试。") => {
    const raw = e instanceof Error ? e.message : String(e);
    const coded = raw.match(/(LOGIN_REQUIRED|REGION_BLOCKED|VIDEO_UNAVAILABLE|NETWORK_ERROR|PAGE_CHANGED)\|([^\n]+)/);
    if (coded) return coded[2];
    // Electron prefixes IPC errors with "Error invoking remote method '…': Error: "
    const plain = raw.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, "").trim();
    return plain && plain.length < 200 ? plain : fallback;
};

export const MODELS: { id: ModelId; name: string; size: string; note: string }[] = [
    { id: "turbo", name: "Large v3 Turbo", size: "约 1.5 GB", note: "准确且快 · 推荐" },
    { id: "large", name: "Large v3", size: "约 2.9 GB", note: "最高准确率 · 最慢" },
    { id: "small", name: "Small", size: "约 466 MB", note: "最快 · 准确率较低" },
];
