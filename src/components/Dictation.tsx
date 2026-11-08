import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { MODELS, type ModelId, type RecognitionProgress } from "../lib/api";
import type { DictationStyle, MediaRecord } from "../lib/storage";
import { compareWords, countWords, time, words, type SentenceGroup } from "../lib/text";
import type { PlayerHandle } from "./Player";

type RecognitionProps = {
    model: ModelId;
    setModel: (m: ModelId) => void;
    installed: Record<ModelId, boolean>;
    down: { id: string; percent: number } | null;
    busy: boolean;
    hasSource: boolean;
    hasReference: boolean;
    status: string;
    progress: RecognitionProgress | null;
    onStart: () => void;
    onCancel: () => void;
    onDownload: () => void;
};

function RecognitionPanel(p: RecognitionProps) {
    // Once subtitles exist, fold the model list away to leave room for writing.
    const [open, setOpen] = useState(!p.hasReference);
    useEffect(() => { setOpen(!p.hasReference); }, [p.hasReference]);
    const running = p.busy;
    return (
        <div className={`model-panel first-step ${open ? "" : "folded"}`}>
            <div className="model-head">
                <strong>{p.hasReference ? "字幕已生成（隐藏中）" : "第一步：解析视频，生成西班牙语字幕"}</strong>
                {p.hasReference && <button className="text-button" onClick={() => setOpen(!open)}>{open ? "收起" : "换模型 / 重新解析"}</button>}
            </div>
            {open && (
                <div className="model-options">
                    {MODELS.map((x) => (
                        <button key={x.id} className={p.model === x.id ? "selected" : ""} onClick={() => p.setModel(x.id)}>
                            <span>{p.installed[x.id] ? "✓" : "↓"}</span>
                            <div><strong>{x.name}</strong><small>{x.size} · {x.note}</small></div>
                        </button>
                    ))}
                </div>
            )}
            {(open || running) && (
                <div className="recognition-action">
                    {running ? (
                        <button className="primary" onClick={p.onCancel}>取消解析</button>
                    ) : p.installed[p.model] ? (
                        <button className="primary" disabled={!p.hasSource} onClick={p.onStart}>{p.hasReference ? "重新解析" : "开始解析视频"}</button>
                    ) : (
                        <button className="primary" disabled={!!p.down} onClick={p.onDownload}>
                            {p.down?.id === p.model ? `下载中 ${p.down.percent}%` : "下载并使用此模型"}
                        </button>
                    )}
                    <span>{p.status || (!p.hasSource ? "请先选择视频" : "字幕生成后先隐藏，听写完再核对")}</span>
                </div>
            )}
            {p.progress && (
                <div className={`recognition-progress ${p.progress.stage}`}>
                    <div><span>{p.progress.message}</span><strong>{Math.round(p.progress.percent)}%</strong></div>
                    <progress max={100} value={p.progress.percent} />
                </div>
            )}
        </div>
    );
}

function SentenceDictation({ groups, record, update, player, loop, setLoop, ignoreAccents }: {
    groups: SentenceGroup[];
    record: MediaRecord;
    update: (fn: (r: MediaRecord) => MediaRecord) => void;
    player: RefObject<PlayerHandle | null>;
    loop: boolean;
    setLoop: (v: boolean) => void;
    ignoreAccents: boolean;
}) {
    const idx = Math.min(Math.max(0, record.cursor), groups.length - 1);
    const group = groups[idx];
    const draft = record.sentenceDrafts[idx] || "";
    const checked = useMemo(() => new Set(record.checked), [record.checked]);
    const revealed = checked.has(idx);
    const input = useRef<HTMLTextAreaElement>(null);
    const [copied, setCopied] = useState<{ idx: number; ok: boolean } | null>(null);
    const copyTimer = useRef<number | undefined>(undefined);
    const copyAnswer = async () => {
        if (!group) return;
        let ok = true;
        try { await navigator.clipboard.writeText(group.text); } catch { ok = false; }
        setCopied({ idx, ok });
        window.clearTimeout(copyTimer.current);
        copyTimer.current = window.setTimeout(() => setCopied(null), 1500);
        input.current?.focus(); // keep typing / Enter working right after copying
    };

    const play = (i = idx) => { const g = groups[i]; if (g) player.current?.playRange(g.start, g.end, loop); };
    const go = (i: number, autoplay: boolean) => {
        const next = Math.min(Math.max(0, i), groups.length - 1);
        update((r) => ({ ...r, cursor: next }));
        if (autoplay) play(next);
        input.current?.focus();
    };
    const reveal = () => update((r) => (r.checked.includes(idx) ? r : { ...r, checked: [...r.checked, idx] }));

    const cmp = useMemo(() => (revealed && group ? compareWords(group.items.map((x) => x.word), words(draft)) : null), [revealed, group, draft]);

    const summary = useMemo(() => {
        let hit = 0, denom = 0;
        for (const i of record.checked) {
            const g = groups[i];
            if (!g) continue;
            const c = compareWords(g.items.map((x) => x.word), words(record.sentenceDrafts[i] || ""));
            hit += ignoreAccents ? c.hits.size + c.accentOnly.size : c.hits.size;
            denom += Math.max(g.items.length, countWords(record.sentenceDrafts[i] || ""));
        }
        return { done: record.checked.length, accuracy: denom ? Math.round((hit / denom) * 100) : null };
    }, [record.checked, record.sentenceDrafts, groups, ignoreAccents]);

    if (!group) return null;
    return (
        <div className="sentence-dictation">
            <div className="sd-head">
                <div>
                    <strong>第 {idx + 1} / {groups.length} 句</strong>
                    <small>{time(group.start)} – {time(group.end)} · 本句 {group.items.length} 个词</small>
                </div>
                <div className="sd-stat">
                    已核对 {summary.done} 句{summary.accuracy != null && <> · 正确率 <b>{summary.accuracy}%</b></>}
                </div>
            </div>
            <div className="sd-progress" aria-hidden>
                <i style={{ width: `${((idx + 1) / groups.length) * 100}%` }} />
            </div>
            <div className="sd-controls">
                <button className="sd-play" onClick={() => play()}>▶ 播放本句 <kbd>↓</kbd></button>
                <button aria-pressed={loop} onClick={() => setLoop(!loop)}>{loop ? "● 循环中" : "○ 循环本句"}</button>
                <span />
                <button disabled={idx === 0} onClick={() => go(idx - 1, true)}>← 上一句</button>
                <button disabled={idx >= groups.length - 1} onClick={() => go(idx + 1, true)}>下一句 →</button>
            </div>
            <textarea
                ref={input}
                className="sd-input"
                data-player-keys="on"
                value={draft}
                autoFocus
                placeholder="Escribe la frase que escuchas…   回车核对，再按回车进入下一句"
                onChange={(e) => {
                    const value = e.target.value;
                    update((r) => ({ ...r, sentenceDrafts: { ...r.sentenceDrafts, [idx]: value } }));
                }}
                onKeyDown={(e) => {
                    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
                    e.preventDefault();
                    if (!revealed) reveal();
                    else if (idx < groups.length - 1) go(idx + 1, true);
                }}
            />
            {revealed && cmp ? (
                <div className="sd-answer">
                    <div className="sd-answer-head">
                        <small>正确字幕 · {ignoreAccents ? cmp.looseAccuracy : cmp.accuracy}%</small>
                        <button className="copy-sentence" title="复制本句正确字幕" onClick={() => void copyAnswer()}>
                            {copied?.idx === idx ? (copied.ok ? "已复制 ✓" : "复制失败") : "复制"}
                        </button>
                    </div>
                    <p>
                        {group.items.map(({ word, timing }, k) => (
                            <button key={k} className={cmp.hits.has(k) ? "matched" : cmp.accentOnly.has(k) ? "accent" : "missed"}
                                title={cmp.accentOnly.has(k) ? "只差重音符号" : undefined}
                                onClick={() => player.current?.playRange(timing.start, group.end, false)}>{word.raw}</button>
                        ))}
                    </p>
                    <div className="sd-next">
                        {idx < groups.length - 1
                            ? <button className="primary" onClick={() => go(idx + 1, true)}>下一句 <kbd>Enter</kbd></button>
                            : <span>最后一句已完成，可到「核对」查看全文 →</span>}
                    </div>
                </div>
            ) : (
                <div className="sd-hint">
                    <button className="text-button" onClick={reveal}>不确定？直接看答案</button>
                    <span>{"＿ ".repeat(Math.min(group.items.length, 25)).trim()}</span>
                </div>
            )}
        </div>
    );
}

export function DictationPanel(props: RecognitionProps & {
    groups: SentenceGroup[];
    record: MediaRecord;
    update: (fn: (r: MediaRecord) => MediaRecord) => void;
    player: RefObject<PlayerHandle | null>;
    loop: boolean;
    setLoop: (v: boolean) => void;
    ignoreAccents: boolean;
    onFinish: () => void;
}) {
    const { record, update, groups } = props;
    const style: DictationStyle = record.style;
    const setStyle = (s: DictationStyle) => update((r) => ({ ...r, style: s }));
    const wordCount = useMemo(() => countWords(record.draft), [record.draft]);
    return (
        <>
            <div className="panel-title">
                <div><span>01</span><div><strong>盲听与听写</strong><small>字幕生成后保持隐藏</small></div></div>
                <div className="style-switch" role="group" aria-label="听写方式">
                    <button aria-pressed={style === "sentence"} onClick={() => setStyle("sentence")}>逐句</button>
                    <button aria-pressed={style === "whole"} onClick={() => setStyle("whole")}>整段</button>
                </div>
            </div>
            <RecognitionPanel {...props} />
            {style === "sentence" ? (
                groups.length ? (
                    <SentenceDictation groups={groups} record={record} update={update} player={props.player}
                        loop={props.loop} setLoop={props.setLoop} ignoreAccents={props.ignoreAccents} />
                ) : (
                    <div className="check-empty">逐句听写需要先解析视频，按句子切分后才能一句一句练。<br />也可以切换到「整段」直接边听边写。</div>
                )
            ) : (
                <>
                    <textarea className="whole-input" data-player-keys="on" value={record.draft}
                        onChange={(e) => { const v = e.target.value; update((r) => ({ ...r, draft: v })); }}
                        placeholder="Escribe aquí lo que escuchas…（打字时：Ctrl+← / Ctrl+→ 后退快进，↑ 播放暂停，↓ 重播本句）" />
                    <div className="editor-footer">
                        <span>{wordCount} 个词 · {props.hasReference ? "字幕已准备好" : "尚未生成字幕"}</span>
                        <button className="primary" onClick={props.onFinish}>完成听写并核对 →</button>
                    </div>
                </>
            )}
        </>
    );
}
