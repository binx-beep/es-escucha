import { useCallback, useEffect, useImperativeHandle, useRef, useState, type RefObject } from "react";
import { api, cleanError, type Media, type PlaybackSource, type Video } from "../lib/api";

export type PlayerHandle = {
    toggle(): void;
    seek(delta: number): void;
    /** Play from `start`; stop (or loop back) at `end` when given. Works for local, TikTok and YouTube. */
    playRange(start: number, end?: number, loop?: boolean): void;
    pause(): void;
    currentTime(): number;
    hasSource(): boolean;
};

type PlaybackState = "idle" | "preparing" | "ready" | "refreshing" | "error";
type Range = { start: number; end: number; loop: boolean; token: number };

const LEAD_IN = 0.15; // start slightly early so the first syllable is not clipped

export function Player({ current, media, rate, controlRef, onStatus }: {
    current: Video | null;
    media: Media | null;
    rate: number;
    controlRef: RefObject<PlayerHandle | null>;
    onStatus: (message: string) => void;
}) {
    const video = useRef<HTMLVideoElement>(null), iframe = useRef<HTMLIFrameElement>(null);
    const yt = useRef({ time: 0, playing: false });
    const range = useRef<Range | null>(null), rangeToken = useRef(0);
    const timer = useRef<number | undefined>(undefined), frame = useRef(0), noticeTimer = useRef<number | undefined>(undefined);
    const pendingStart = useRef<number | null>(null), refreshing = useRef(false);
    const rateRef = useRef(rate);
    const [playback, setPlayback] = useState<PlaybackSource | null>(null);
    const [state, setState] = useState<PlaybackState>("idle");
    const [notice, setNotice] = useState("");
    const kind = current?.platform === "TikTok" ? "tiktok" : current?.platform === "YouTube" ? "youtube" : media ? "local" : "none";

    const flash = (text: string) => {
        setNotice(text);
        window.clearTimeout(noticeTimer.current);
        noticeTimer.current = window.setTimeout(() => setNotice(""), 600);
    };

    const sendYouTube = useCallback((func: string, args: unknown[] = []) => {
        iframe.current?.contentWindow?.postMessage(JSON.stringify({ event: "command", func, args, id: 1, channel: "widget" }), "*");
    }, []);

    const clearRange = () => {
        range.current = null;
        window.clearTimeout(timer.current);
        cancelAnimationFrame(frame.current);
    };

    // New video: reset local playback state and release the previous TikTok proxy session.
    useEffect(() => {
        setPlayback(null); setState("idle"); refreshing.current = false; pendingStart.current = null;
        yt.current = { time: 0, playing: false }; clearRange();
        const id = current?.platform === "TikTok" ? current.id : null;
        return () => { if (id) void api()?.releaseTikTokPlayback(id); };
    }, [current?.id, current?.platform, media?.path]);

    useEffect(() => {
        rateRef.current = rate;
        if (video.current) video.current.playbackRate = rate;
        if (kind === "youtube") sendYouTube("setPlaybackRate", [rate]);
    }, [rate, kind, sendYouTube]);

    /** Called when the playhead passes the end of the active range. */
    const reachedEnd = useCallback((r: Range) => {
        if (range.current?.token !== r.token) return;
        const target = Math.max(0, r.start - LEAD_IN);
        if (r.loop) {
            if (kind === "youtube") { sendYouTube("seekTo", [target, true]); yt.current.time = target; scheduleYouTubeEnd(r, target); }
            else if (video.current) video.current.currentTime = target;
            return;
        }
        clearRange();
        if (kind === "youtube") { sendYouTube("pauseVideo"); yt.current.playing = false; }
        else video.current?.pause();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [kind, sendYouTube]);

    // YouTube reports time only a few times per second, so also stop on a timer.
    const scheduleYouTubeEnd = (r: Range, from: number) => {
        window.clearTimeout(timer.current);
        const ms = Math.max(0, ((r.end - from) / rateRef.current) * 1000) + 120;
        timer.current = window.setTimeout(() => reachedEnd(r), ms);
    };

    // Precise end detection for <video> (timeupdate alone fires only ~4x per second).
    const watchVideo = (r: Range) => {
        cancelAnimationFrame(frame.current);
        const tick = () => {
            const v = video.current;
            if (!v || range.current?.token !== r.token) return;
            if (!v.paused && v.currentTime >= r.end) reachedEnd(r);
            frame.current = requestAnimationFrame(tick);
        };
        frame.current = requestAnimationFrame(tick);
    };

    useEffect(() => {
        const onMessage = (e: MessageEvent) => {
            if (!/^https:\/\/([\w-]+\.)*youtube(-nocookie)?\.com$/.test(e.origin)) return;
            try {
                const data = typeof e.data === "string" ? JSON.parse(e.data) : e.data;
                const info = data?.info;
                if (info && typeof info === "object") {
                    if (info.currentTime != null) yt.current.time = Number(info.currentTime);
                    if (info.playerState != null) yt.current.playing = info.playerState === 1;
                } else if (data?.event === "onStateChange" && typeof info === "number") yt.current.playing = info === 1;
                const r = range.current;
                if (r && yt.current.playing && yt.current.time >= r.end) reachedEnd(r);
            } catch { /* not a player message */ }
        };
        window.addEventListener("message", onMessage);
        return () => window.removeEventListener("message", onMessage);
    }, [reachedEnd]);

    const prepareTikTok = async (start: number | null) => {
        const desktop = api();
        if (!current || current.platform !== "TikTok" || !desktop || state === "preparing") return;
        pendingStart.current = start ?? 0;
        setState("preparing"); onStatus("正在准备 TikTok 视频…");
        try {
            const source = await desktop.prepareTikTokPlayback(current);
            setPlayback(source); setState("ready"); refreshing.current = false;
        } catch (e) {
            setState("error"); onStatus(cleanError(e));
        }
    };

    const refreshTikTok = async () => {
        const desktop = api();
        if (!current || !playback || refreshing.current || !desktop) return;
        refreshing.current = true; setState("refreshing");
        pendingStart.current = video.current?.currentTime || 0;
        try {
            setPlayback(await desktop.refreshTikTokPlayback(current.id)); setState("ready");
        } catch (e) {
            setState("error"); onStatus(cleanError(e));
        }
    };

    useImperativeHandle(controlRef, () => ({
        hasSource: () => kind !== "none",
        currentTime: () => (kind === "youtube" ? yt.current.time : video.current?.currentTime || 0),
        pause: () => {
            clearRange();
            if (kind === "youtube") { sendYouTube("pauseVideo"); yt.current.playing = false; }
            video.current?.pause();
        },
        toggle: () => {
            if (kind === "tiktok" && !playback) { void prepareTikTok(null); return; }
            if (kind === "youtube") {
                const playing = yt.current.playing;
                sendYouTube(playing ? "pauseVideo" : "playVideo");
                yt.current.playing = !playing;
                if (!playing && range.current) scheduleYouTubeEnd(range.current, yt.current.time);
                else window.clearTimeout(timer.current);
                return;
            }
            const v = video.current;
            if (v) v.paused ? v.play().catch(() => {}) : v.pause();
        },
        seek: (delta: number) => {
            if (kind === "youtube") {
                const t = Math.max(0, yt.current.time + delta);
                sendYouTube("seekTo", [t, true]); yt.current.time = t;
                if (range.current && yt.current.playing) scheduleYouTubeEnd(range.current, t);
            } else if (video.current) video.current.currentTime = Math.max(0, video.current.currentTime + delta);
            flash(delta < 0 ? `↶ ${-delta} 秒` : `${delta} 秒 ↷`);
        },
        playRange: (start: number, end?: number, loop = false) => {
            clearRange();
            const target = Math.max(0, start - LEAD_IN);
            const r: Range | null = end != null && end > start ? { start, end, loop, token: ++rangeToken.current } : null;
            range.current = r;
            if (kind === "tiktok" && !playback) { void prepareTikTok(target); if (r) watchVideo(r); return; }
            if (kind === "youtube") {
                sendYouTube("seekTo", [target, true]); yt.current.time = target;
                window.setTimeout(() => sendYouTube("playVideo"), 80);
                yt.current.playing = true;
                if (r) scheduleYouTubeEnd(r, target);
                return;
            }
            const v = video.current;
            if (!v) return;
            v.currentTime = target;
            v.play().catch(() => {});
            if (r) watchVideo(r);
        },
    }));

    const onTikTokCanPlay = () => {
        const v = video.current;
        if (!v || pendingStart.current == null) return;
        v.currentTime = pendingStart.current;
        pendingStart.current = null;
        v.play().catch(() => {});
    };

    return (
        <div className="player-wrap">
            {kind === "tiktok" && current ? (
                <div className="tiktok-native">
                    <video ref={video} key={`tt-${current.id}`} src={playback?.url} poster={current.thumbnail || undefined} controls={!!playback} preload="metadata"
                        onLoadedMetadata={(e) => { e.currentTarget.playbackRate = rateRef.current; }}
                        onCanPlay={onTikTokCanPlay}
                        onError={() => { if (playback && state === "ready") void refreshTikTok(); }} />
                    {!playback && (
                        <button className="tiktok-play" disabled={state === "preparing" || state === "refreshing"} onClick={() => void prepareTikTok(null)}>
                            <span>▶</span>
                            {state === "preparing" ? "正在准备 TikTok 视频…" : state === "error" ? "播放失败，点击重试" : "点击播放"}
                        </button>
                    )}
                </div>
            ) : kind === "youtube" && current ? (
                <iframe ref={iframe} key={`yt-${current.id}`}
                    src={`https://www.youtube.com/embed/${current.id}?autoplay=0&enablejsapi=1&playsinline=1&rel=0`}
                    allow="fullscreen; encrypted-media" title={current.title || "YouTube 视频"}
                    onLoad={() => {
                        yt.current.playing = false;
                        // Handshake so the player streams currentTime / state back to us.
                        iframe.current?.contentWindow?.postMessage(JSON.stringify({ event: "listening", id: 1, channel: "widget" }), "*");
                        window.setTimeout(() => { sendYouTube("pauseVideo"); sendYouTube("setPlaybackRate", [rateRef.current]); }, 150);
                        window.setTimeout(() => sendYouTube("pauseVideo"), 700);
                    }} />
            ) : kind === "local" && media ? (
                <video ref={video} key={media.path} src={media.url} controls preload="metadata"
                    onLoadedMetadata={(e) => { e.currentTarget.playbackRate = rateRef.current; }} />
            ) : (
                <div className="player-empty"><b>选择一个视频开始</b><span>视频不会自动播放</span></div>
            )}
            {notice && <div className="seek-notice">{notice}</div>}
        </div>
    );
}
