import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, cleanError, type Entry, type FocusKind, type EntryType, type Media, type Mode, type ModelId, type RecognitionProgress, type Stats, type Video } from "./lib/api";
import { extractWav } from "./lib/audio";
import {
    defaultPrefs, loadPrefs, loadRecent, loadRecord, loadSegments, loadWordBank, savePrefs, saveRecent, saveRecord, saveSegments, saveWordBank,
    type MediaRecord, type Prefs,
} from "./lib/storage";
import { groupSentences, sentenceAt, type Segment } from "./lib/text";
import { CheckPanel, type Selected } from "./components/Check";
import { DictationPanel } from "./components/Dictation";
import { Library } from "./components/Library";
import { Player, type PlayerHandle } from "./components/Player";
import { SettingsPanel } from "./components/Settings";
import { entriesToCsv, WordsPanel } from "./components/Words";

const RATES = [0.5, 0.75, 0.9, 1];
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
const isEditable = (el: Element | null) =>
    !!el && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || (el as HTMLElement).isContentEditable);
/** "player" = dictation box (↑/↓ still drive the player), "text" = any other text field, "none" = not typing. */
const focusKindOf = (el: Element | null): FocusKind => !isEditable(el) ? "none" : (el as HTMLElement).dataset.playerKeys === "on" ? "player" : "text";
/** Same rules as playerKey() in electron/main.cjs: Ctrl+←/→ always seek; plain ←/→ only when not typing. */
function playerKeyFor(e: KeyboardEvent, kind: FocusKind): string | null {
    if (e.altKey || e.metaKey || e.shiftKey) return null;
    const lr = e.key === "ArrowLeft" || e.key === "ArrowRight", ud = e.key === "ArrowUp" || e.key === "ArrowDown";
    if (e.ctrlKey) return lr ? e.key : null;
    if (lr) return kind === "none" ? e.key : null;
    if (ud) return kind === "text" ? null : e.key;
    return null;
}

export default function App() {
    const player = useRef<PlayerHandle>(null);
    const [mode, setMode] = useState<Mode>("dictation");
    const [prefs, setPrefsState] = useState<Prefs>(defaultPrefs);
    const setPrefs = (patch: Partial<Prefs>) => setPrefsState((p) => { const next = { ...p, ...patch }; savePrefs(next); return next; });

    const [current, setCurrent] = useState<Video | null>(null);
    const [media, setMedia] = useState<Media | null>(null);
    const [recent, setRecent] = useState<Video[]>([]);
    const [url, setUrl] = useState(""), [online, setOnline] = useState("");
    const [tiktokLogin, setTikTokLogin] = useState(false), [authBusy, setAuthBusy] = useState(false);
    const [installed, setInstalled] = useState<Record<ModelId, boolean>>({ small: false, turbo: false, large: false });
    const [down, setDown] = useState<{ id: string; percent: number } | null>(null);
    const [stats, setStats] = useState<Stats | null>(null);
    const [busy, setBusy] = useState(false), [status, setStatus] = useState(""), [progress, setProgress] = useState<RecognitionProgress | null>(null);
    const [entries, setEntries] = useState<Entry[]>([]);
    const [toast, setToast] = useState("");
    const activeJob = useRef<string | null>(null), activeMediaKey = useRef("empty");

    const key = current ? `online:${current.platform}:${current.id}` : media?.path || "empty";
    const title = current?.title || media?.name || "";

    // ---- per-video record (drafts) + subtitles; switched synchronously when the video changes
    const [rec, setRec] = useState<{ key: string; rec: MediaRecord; segments: Segment[] }>(() => ({ key: "empty", rec: loadRecord("empty"), segments: [] }));
    if (rec.key !== key) {
        saveRecord(rec.key, rec.rec);
        setRec({ key, rec: loadRecord(key), segments: loadSegments(key) });
    }
    const record = rec.key === key ? rec.rec : loadRecord(key);
    const segments = rec.key === key ? rec.segments : [];
    const update = useCallback((fn: (r: MediaRecord) => MediaRecord) => setRec((s) => ({ ...s, rec: fn(s.rec) })), []);
    const pending = useRef(rec);
    useEffect(() => {
        pending.current = rec;
        const t = window.setTimeout(() => saveRecord(rec.key, rec.rec), 300);
        return () => window.clearTimeout(t);
    }, [rec]);
    useEffect(() => {
        const flush = () => saveRecord(pending.current.key, pending.current.rec);
        window.addEventListener("beforeunload", flush);
        return () => window.removeEventListener("beforeunload", flush);
    }, []);

    const { groups, all } = useMemo(() => groupSentences(segments), [segments]);
    const hasReference = groups.length > 0;

    const flashToast = (text: string) => { setToast(text); window.setTimeout(() => setToast(""), 2500); };
    const refreshStats = useCallback(async () => { const s = await api()?.cacheStats(); if (s) setStats(s); }, []);
    const refreshModels = useCallback(async () => { const m = await api()?.modelStatus(); if (m) setInstalled(m); }, []);

    // ---- startup
    useEffect(() => {
        setPrefsState(loadPrefs());
        setRecent(loadRecent());
        setEntries(loadWordBank());
        const desktop = api();
        if (!desktop) return;
        void refreshModels(); void refreshStats();
        desktop.getTikTokLoginStatus().then(setTikTokLogin).catch(() => {});
        const offs = [
            desktop.onModelProgress((v) => { if (v.id !== "vad") setDown(v); }),
            desktop.onOnlineStatus(setOnline),
            desktop.onRecognitionProgress((v) => { if (v.jobId === activeJob.current && v.mediaKey === activeMediaKey.current) setProgress(v); }),
        ];
        return () => offs.forEach((off) => off?.());
    }, [refreshModels, refreshStats]);
    useEffect(() => { if (mode === "settings") void refreshStats(); }, [mode, refreshStats]);

    // ---- recognition
    const cancelActive = () => {
        const old = activeJob.current;
        activeJob.current = null;
        if (old) void api()?.cancelRecognition(old);
        setBusy(false);
    };
    const resetForMedia = (nextKey: string) => {
        cancelActive();
        activeMediaKey.current = nextKey;
        setStatus(""); setProgress(null);
    };

    const transcribe = async (source: Media, jobId: string, mediaKey: string) => {
        const desktop = api();
        if (!desktop || activeJob.current !== jobId) return;
        const model = prefs.model;
        const alive = () => activeJob.current === jobId;
        try {
            setProgress({ stage: "extract", percent: 36, message: "正在提取音频 36%", jobId, mediaKey });
            setStatus("正在提取音频…");
            const wavData = await extractWav(desktop, source.path, () => !alive());
            if (!wavData || !alive()) return;
            setProgress({ stage: "extract", percent: 44, message: "音频提取完成 44%", jobId, mediaKey });
            const wavPath = await desktop.saveWav(wavData);
            if (!alive()) return;
            setStatus("正在识别…");
            const result = await desktop.transcribe({ wavPath, modelId: model, jobId, mediaKey, mediaPath: source.path });
            if (alive() && activeMediaKey.current === mediaKey) {
                saveSegments(mediaKey, result.segments);
                setRec((s) => (s.key === mediaKey ? { ...s, segments: result.segments, rec: { ...s.rec, cursor: 0, checked: [] } } : s));
                setStatus(`识别完成：${result.segments.length} 段字幕`);
                setProgress({ stage: "done", percent: 100, message: "字幕解析完成 100%", jobId, mediaKey });
                window.setTimeout(() => setProgress((p) => (p?.jobId === jobId ? null : p)), 4000);
                if (result.mediaDeleted && current) setMedia(null);
            }
        } catch (e) {
            if (alive()) {
                const message = /识别已取消/.test(String(e)) ? "已取消解析" : cleanError(e, "识别失败");
                setStatus(message);
                setProgress({ stage: "error", percent: 0, message, jobId, mediaKey });
            }
        } finally {
            if (alive()) { setBusy(false); activeJob.current = null; }
        }
    };

    const startRecognition = async () => {
        const desktop = api();
        if (!desktop) return setStatus("请在桌面版中使用");
        if (!media && !current) return setStatus("请先打开视频");
        if (!installed[prefs.model]) return setStatus("请先下载模型");
        cancelActive();
        const mediaKey = key, jobId = newId();
        activeMediaKey.current = mediaKey; activeJob.current = jobId;
        setBusy(true);
        setProgress({ stage: media ? "extract" : "download", percent: 0, message: "准备开始解析 0%", jobId, mediaKey });
        if (media) return void transcribe(media, jobId, mediaKey);
        setStatus("正在下载音频…");
        try {
            const file = await desktop.downloadOnlineVideo({ item: current as Video, jobId, mediaKey });
            if (activeJob.current !== jobId || activeMediaKey.current !== mediaKey) return;
            setMedia(file);
            void transcribe(file, jobId, mediaKey);
        } catch (e) {
            if (activeJob.current !== jobId) return;
            const message = /识别已取消/.test(String(e)) ? "已取消解析" : cleanError(e);
            setOnline(message); setStatus(message);
            setProgress({ stage: "error", percent: 0, message, jobId, mediaKey });
            setBusy(false); activeJob.current = null;
        }
    };

    const getModel = async () => {
        const id = prefs.model;
        setDown({ id, percent: 0 });
        try { await api()?.downloadModel(id); await refreshModels(); setStatus("模型已就绪"); }
        catch (e) { setStatus(`下载中断：${cleanError(e, "网络错误")}（再点一次会从断点继续）`); }
        finally { setDown(null); }
    };

    // ---- opening videos
    const choose = (v: Video, nextMode: Mode = "dictation") => {
        player.current?.pause();
        resetForMedia(`online:${v.platform}:${v.id}`);
        setCurrent(v); setMedia(null); setMode(nextMode);
        setOnline("视频已打开（暂停中）。解析字幕后即可开始听写。");
    };
    const read = async () => {
        if (!url.trim()) return setOnline("请先粘贴具体视频链接");
        player.current?.pause();
        setOnline("正在解析视频…");
        try {
            const v = await api()?.resolveVideo(url.trim());
            if (v) {
                setRecent((items) => { const next = [v, ...items.filter((x) => !(x.id === v.id && x.platform === v.platform))]; saveRecent(next); return next; });
                choose(v); setUrl("");
            }
        } catch (e) { setOnline(cleanError(e)); }
    };
    const importFile = async () => {
        player.current?.pause();
        const x = await api()?.pickMedia();
        if (x) { resetForMedia(x.path); setCurrent(null); setMedia(x); setMode("dictation"); }
    };
    const openSource = (entry: Entry) => {
        if (entry.source.video) choose(entry.source.video, "words");
        else if (entry.source.media) { resetForMedia(entry.source.media.path); setCurrent(null); setMedia(entry.source.media); }
        flashToast("已打开来源视频，再点「重播原句」");
    };
    const loginTikTok = async () => {
        setAuthBusy(true); setOnline("请在新窗口登录，完成后关闭窗口。");
        const ok = await api()?.openTikTokLogin().catch(() => false);
        setTikTokLogin(!!ok); setOnline(ok ? "TikTok 已登录，可以重新打开视频。" : "未检测到登录，请重试。");
        setAuthBusy(false);
    };
    const logoutTikTok = async () => { await api()?.logoutTikTok(); setTikTokLogin(false); setOnline("已退出 TikTok 登录"); };

    // ---- word bank
    useEffect(() => { saveWordBank(entries); }, [entries]);
    const saveEntry = (s: Selected, type: EntryType) => {
        setEntries((list) => [...list, {
            id: newId(), type, createdAt: Date.now(), ...s,
            source: { key, title, video: current || undefined, media: current ? undefined : media || undefined },
        }]);
        flashToast(`已加入词库：${s.phrase}`);
    };
    const exportEntries = async (list: Entry[]) => {
        const name = `Escucha词库-${new Date().toISOString().slice(0, 10)}.csv`;
        const saved = await api()?.exportText({ name, content: entriesToCsv(list) }).catch((e) => { flashToast(cleanError(e)); return null; });
        if (saved) flashToast(`已导出 ${list.length} 条到 ${saved}`);
    };

    // ---- keyboard: ← → seek, ↑ play/pause, ↓ replay the current sentence
    const replaySentence = () => {
        if (!groups.length) return player.current?.seek(-3);
        const i = mode === "dictation" && record.style === "sentence"
            ? Math.min(record.cursor, groups.length - 1)
            : Math.max(0, sentenceAt(groups, player.current?.currentTime() || 0));
        const g = groups[i];
        player.current?.playRange(g.start, g.end, mode === "dictation" && prefs.loop);
    };
    const handleKey = (k: string) => {
        if (k === "ArrowLeft") player.current?.seek(-2);
        else if (k === "ArrowRight") player.current?.seek(2);
        else if (k === "ArrowUp") player.current?.toggle();
        else if (k === "ArrowDown") replaySentence();
    };
    const keyRef = useRef(handleKey);
    keyRef.current = handleKey;
    useEffect(() => {
        const desktop = api();
        let kind: FocusKind = "none";
        const sync = () => {
            const next = focusKindOf(document.activeElement);
            if (next !== kind) { kind = next; desktop?.setFocusKind(next); }
        };
        const later = () => window.setTimeout(sync, 0);
        document.addEventListener("focusin", sync);
        document.addEventListener("focusout", later);
        // In a plain browser (no Electron main process) handle keys here.
        const onKey = (e: KeyboardEvent) => {
            if (desktop) return;
            const key = playerKeyFor(e, focusKindOf(e.target as Element));
            if (!key) return;
            e.preventDefault(); keyRef.current(key);
        };
        window.addEventListener("keydown", onKey, { capture: true });
        const off = desktop?.onPlayerKey((k) => keyRef.current(k));
        return () => {
            document.removeEventListener("focusin", sync); document.removeEventListener("focusout", later);
            window.removeEventListener("keydown", onKey, { capture: true }); off?.();
        };
    }, []);

    const nav: [Mode, string][] = [["dictation", "听写"], ["check", "核对"], ["words", `词库 ${entries.length}`], ["settings", "设置"]];
    return (
        <main>
            <header className="topbar">
                <div className="brand"><span>E</span><strong>Escucha</strong><small className="version">2</small></div>
                <nav>{nav.map(([m, label]) => <button key={m} className={mode === m ? "active" : ""} onClick={() => setMode(m)}>{label}</button>)}</nav>
                <div className="saved">{toast ? <b className="toast">{toast}</b> : "● 已自动保存"}</div>
            </header>
            <section className="workspace">
                <Library url={url} setUrl={setUrl} onRead={() => void read()} online={online}
                    tiktokLogin={tiktokLogin} authBusy={authBusy} onLogin={() => void loginTikTok()} onLogout={() => void logoutTikTok()}
                    onImport={() => void importFile()} recent={recent} current={current} onChoose={(v) => choose(v)}
                    onRemove={(v) => setRecent((items) => { const next = items.filter((x) => !(x.id === v.id && x.platform === v.platform)); saveRecent(next); return next; })} />
                <section className="study">
                    <div className="player-column">
                        <Player current={current} media={current ? null : media} rate={prefs.rate} controlRef={player} onStatus={setOnline} />
                        <div className="controls four">
                            <button onClick={() => player.current?.seek(-2)}><kbd>Ctrl ←</kbd> 后退 2 秒</button>
                            <button onClick={() => player.current?.toggle()}><kbd>↑</kbd> 播放／暂停</button>
                            <button onClick={replaySentence}><kbd>↓</kbd> 重播本句</button>
                            <button onClick={() => player.current?.seek(2)}>快进 2 秒 <kbd>Ctrl →</kbd></button>
                        </div>
                        <div className="speed">
                            <span>播放速度</span>
                            {RATES.map((r) => <button key={r} className={prefs.rate === r ? "active" : ""} onClick={() => setPrefs({ rate: r })}>{r === 1 ? "1×" : `${r}×`}</button>)}
                        </div>
                    </div>
                    <div className="editor-column">
                        {mode === "dictation" && (
                            <DictationPanel
                                model={prefs.model} setModel={(m) => setPrefs({ model: m })} installed={installed} down={down}
                                busy={busy} hasSource={!!(media || current)} hasReference={hasReference} status={status} progress={progress}
                                onStart={() => void startRecognition()} onCancel={() => { cancelActive(); setStatus("已取消解析"); setProgress(null); }}
                                onDownload={() => void getModel()}
                                groups={groups} record={record} update={update} player={player}
                                loop={prefs.loop} setLoop={(v) => setPrefs({ loop: v })} ignoreAccents={prefs.ignoreAccents}
                                onFinish={() => { if (!hasReference) void startRecognition(); setMode("check"); }} />
                        )}
                        {mode === "check" && (
                            <CheckPanel groups={groups} all={all} record={record} player={player}
                                ignoreAccents={prefs.ignoreAccents} setIgnoreAccents={(v) => setPrefs({ ignoreAccents: v })}
                                showComparison={prefs.showComparison} setShowComparison={(v) => setPrefs({ showComparison: v })}
                                onSave={saveEntry} copyKey={key} />
                        )}
                        {mode === "words" && (
                            <WordsPanel entries={entries} currentKey={key} player={player}
                                onRemove={(id) => setEntries((l) => l.filter((x) => x.id !== id))} onOpenSource={openSource} onExport={(l) => void exportEntries(l)} />
                        )}
                        {mode === "settings" && (
                            <SettingsPanel stats={stats} refreshStats={refreshStats} installed={installed} refreshModels={refreshModels}
                                media={media} down={down} onMediaDeleted={() => { setMedia(null); setStatus("当前识别文件已删除，在线播放不受影响"); }} />
                        )}
                    </div>
                </section>
            </section>
            <footer>
                <span><kbd>Ctrl</kbd>+<kbd>←</kbd> 后退</span><span><kbd>Ctrl</kbd>+<kbd>→</kbd> 快进</span><span><kbd>↑</kbd> 播放／暂停</span><span><kbd>↓</kbd> 重播本句</span>
                <span>逐句模式：<kbd>Enter</kbd> 核对 / 下一句</span>
            </footer>
        </main>
    );
}
