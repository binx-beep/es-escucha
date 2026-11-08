import type { Video } from "../lib/api";
import { time } from "../lib/text";

export function Library(props: {
    url: string;
    setUrl: (v: string) => void;
    onRead: () => void;
    online: string;
    tiktokLogin: boolean;
    authBusy: boolean;
    onLogin: () => void;
    onLogout: () => void;
    onImport: () => void;
    recent: Video[];
    current: Video | null;
    onChoose: (v: Video) => void;
    onRemove: (v: Video) => void;
}) {
    const { recent, current } = props;
    return (
        <aside className="library">
            <div className="url-loader">
                <label htmlFor="video-url">单个 TikTok 或 YouTube 视频</label>
                <form onSubmit={(e) => { e.preventDefault(); props.onRead(); }}>
                    <input id="video-url" value={props.url} onChange={(e) => props.setUrl(e.target.value)} placeholder="粘贴具体视频链接" />
                    <button type="submit">打开</button>
                </form>
                <small>{props.online}</small>
                <div className="tiktok-auth">
                    <span className={props.tiktokLogin ? "logged" : ""}>{props.tiktokLogin ? "● TikTok 已登录" : "○ TikTok 未登录"}</span>
                    {props.tiktokLogin
                        ? <button onClick={props.onLogout}>退出</button>
                        : <button disabled={props.authBusy} onClick={props.onLogin}>{props.authBusy ? "等待登录…" : "登录 TikTok"}</button>}
                </div>
            </div>
            <button className="import-button" onClick={props.onImport}>＋ 导入本地视频或音频</button>
            <p className="section-label">最近视频</p>
            {recent.length ? (
                <div className="video-list real-list">
                    {recent.map((v) => (
                        <div className={`recent-item ${current?.id === v.id && current.platform === v.platform ? "selected" : ""}`} key={`${v.platform}-${v.id}`}>
                            <button onClick={() => props.onChoose(v)}>
                                {v.thumbnail ? <img src={v.thumbnail} alt="" loading="lazy" /> : <span>{v.platform === "YouTube" ? "YT" : "TT"}</span>}
                                <div><strong>{v.title}</strong><small>{v.platform}{v.duration ? ` · ${time(v.duration)}` : ""}</small></div>
                            </button>
                            <button className="remove-recent" aria-label="从列表移除" onClick={() => props.onRemove(v)}>×</button>
                        </div>
                    ))}
                </div>
            ) : (
                <div className="library-empty"><b>还没有最近视频</b><p>粘贴一个 TikTok 或 YouTube 视频链接。</p></div>
            )}
        </aside>
    );
}
