import { useEffect, useState } from "react";
import { api, cleanError, MODELS, type DownloadedFile, type Media, type ModelId, type Settings, type Stats } from "../lib/api";
import { size } from "../lib/text";

export function SettingsPanel({ stats, refreshStats, installed, refreshModels, media, onMediaDeleted, down }: {
    stats: Stats | null;
    refreshStats: () => Promise<void>;
    installed: Record<ModelId, boolean>;
    refreshModels: () => Promise<void>;
    media: Media | null;
    onMediaDeleted: () => void;
    down: { id: string; percent: number } | null;
}) {
    const [downloads, setDownloads] = useState<DownloadedFile[]>([]);
    const [selected, setSelected] = useState<string[]>([]);
    const [message, setMessage] = useState("");
    const settings = stats?.settings;

    const refreshDownloads = async () => setDownloads((await api()?.listDownloadedVideos()) || []);
    useEffect(() => { void refreshDownloads(); }, []);

    const save = async (patch: Partial<Settings>) => {
        try { await api()?.saveSettings(patch); await refreshStats(); }
        catch (e) { setMessage(cleanError(e, "保存失败")); }
    };
    const run = async (label: string, fn: () => Promise<unknown>) => {
        setMessage(`${label}…`);
        try { const out = await fn(); setMessage(typeof out === "string" && out ? `${label}：${out}` : `${label}：完成`); }
        catch (e) { setMessage(`${label}失败：${cleanError(e, "未知错误")}`); }
        await refreshStats();
    };
    const deleteSelected = async () => {
        if (!selected.length || !window.confirm(`确定删除选中的 ${selected.length} 个文件吗？`)) return;
        const deleted = (await api()?.deleteDownloadedVideos(selected)) || [];
        if (media && deleted.some((p) => p.toLocaleLowerCase() === media.path.toLocaleLowerCase())) onMediaDeleted();
        setSelected([]); await refreshDownloads(); await refreshStats();
    };
    const threadOptions = stats ? Array.from({ length: stats.cpuCount }, (_, i) => i + 1).filter((n) => n >= 2) : [];

    return (
        <>
            <div className="panel-title"><div><span>04</span><div><strong>设置</strong><small>数据目录：{stats?.root || "…"}</small></div></div></div>
            <div className="settings-page">
                {message && <div className="inline-message">{message}</div>}
                <section>
                    <h3>识别速度</h3>
                    <div className="setting-grid">
                        <label>解码方式
                            <select value={settings?.speed || "fast"} onChange={(e) => void save({ speed: e.target.value as Settings["speed"] })}>
                                <option value="fast">快速（贪心解码，约快 2–3 倍，推荐）</option>
                                <option value="accurate">精确（束搜索 5，较慢）</option>
                            </select>
                        </label>
                        <label>CPU 线程
                            <select value={String(settings?.threads ?? "auto")} onChange={(e) => void save({ threads: e.target.value === "auto" ? "auto" : Number(e.target.value) })}>
                                <option value="auto">自动（{stats?.autoThreads ?? "?"} 线程）</option>
                                {threadOptions.map((n) => <option key={n} value={n}>{n} 线程</option>)}
                            </select>
                        </label>
                    </div>
                    <label className="toggle">
                        <input type="checkbox" checked={!!settings?.vad} onChange={async (e) => {
                            const on = e.target.checked;
                            if (on && !stats?.vadModel) await run("下载静音检测模型（约 1 MB）", () => api()!.downloadVadModel());
                            await save({ vad: on });
                        }} />
                        跳过静音和纯音乐段（VAD，实验功能：更快、更少“幻听”字幕；如果字幕时间对不上请关闭）
                    </label>
                    <p>电脑没有独立显卡加速时，识别速度主要取决于 CPU 线程数和模型大小。Turbo + 快速模式通常是速度和准确率最好的平衡。</p>
                </section>
                <section>
                    <h3>识别模型</h3>
                    {stats?.legacyModels && <p>已检测到旧版软件下载的模型，直接复用，无需重新下载。</p>}
                    {MODELS.map((m) => (
                        <div className="model-row" key={m.id}>
                            <div><strong>{m.name}</strong><small>{m.size} · {down?.id === m.id ? `下载中 ${down.percent}%` : installed[m.id] ? "已安装" : "未安装"}</small></div>
                            {installed[m.id] && (
                                <button onClick={() => {
                                    if (window.confirm(`删除 ${m.name} 模型？以后使用需要重新下载。`))
                                        void run(`删除 ${m.name}`, async () => { await api()?.deleteModel(m.id); await refreshModels(); });
                                }}>删除</button>
                            )}
                        </div>
                    ))}
                </section>
                <section>
                    <h3>存储空间</h3>
                    <div className="stat-grid">
                        {([["临时音频", stats?.temp], ["下载的视频", stats?.media], ["本地模型", stats?.models], ["学习记录", stats?.records]] as const).map(([k, v]) => (
                            <div key={k}><span>{k}</span><strong>{size(Number(v || 0))}</strong></div>
                        ))}
                    </div>
                    <div className="settings-actions">
                        <button onClick={() => void run("清除临时音频", () => api()!.clearCache("temp"))}>清除临时音频</button>
                        <button onClick={() => void run("清除下载的视频", async () => { await api()!.clearCache("media"); await refreshDownloads(); if (media && stats?.root && media.path.toLowerCase().startsWith(stats.root.toLowerCase())) onMediaDeleted(); })}>清除下载的视频</button>
                        <button onClick={() => void run("更改数据目录", async () => { const p = await api()?.chooseStorageRoot(); if (!p) throw new Error("已取消"); })}>更改数据目录…</button>
                    </div>
                    <label>自动清理
                        <select value={settings?.cleanupPolicy || "immediate"} onChange={(e) => void save({ cleanupPolicy: e.target.value as Settings["cleanupPolicy"] })}>
                            <option value="immediate">识别完成后删除临时音频和下载的视频（推荐）</option>
                            <option value="7days">保留最近 7 天</option>
                            <option value="2gb">超过 2 GB 时删除最旧的</option>
                            <option value="never">永久保留</option>
                        </select>
                    </label>
                    <div className="download-manager">
                        <div className="download-head">
                            <strong>已下载的视频 / 音频</strong>
                            <div>
                                <button onClick={() => void api()?.openDownloadedVideosFolder()}>打开文件夹</button>
                                <button disabled={!selected.length} onClick={() => void deleteSelected()}>删除所选</button>
                            </div>
                        </div>
                        {downloads.length ? (
                            <>
                                <label className="select-all">
                                    <input type="checkbox" checked={selected.length === downloads.length} onChange={(e) => setSelected(e.target.checked ? downloads.map((f) => f.name) : [])} /> 全选
                                </label>
                                <div className="download-list">
                                    {downloads.map((f) => (
                                        <label key={f.name}>
                                            <input type="checkbox" checked={selected.includes(f.name)}
                                                onChange={(e) => setSelected((s) => (e.target.checked ? [...s, f.name] : s.filter((n) => n !== f.name)))} />
                                            <span><strong>{f.name}</strong><small>{size(f.size)} · {new Date(f.modified).toLocaleString()}</small></span>
                                        </label>
                                    ))}
                                </div>
                            </>
                        ) : <p>没有已下载的文件。</p>}
                    </div>
                </section>
                <section>
                    <h3>在线视频解析器</h3>
                    <p>YouTube 经常改版，解析失败时软件会自动更新一次 yt-dlp；也可以手动更新。</p>
                    <div className="settings-actions">
                        <button onClick={() => void run("更新 yt-dlp", () => api()!.updateParser())}>立即更新解析器</button>
                    </div>
                </section>
            </div>
        </>
    );
}
