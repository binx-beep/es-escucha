import { useDeferredValue, useEffect, useMemo, useState, type RefObject } from "react";
import type { EntryType } from "../lib/api";
import type { MediaRecord } from "../lib/storage";
import { alignDraft, compareWords, countWords, time, words, type SentenceGroup, type Word } from "../lib/text";
import type { PlayerHandle } from "./Player";

export type Selected = { phrase: string; sentence: string; start: number; end: number; draft: string };

type Scored = {
    hits: Set<number>;
    accentOnly: Set<number>;
    accuracy: number;
    looseAccuracy: number;
    /** per-sentence text shown under "我的听写" */
    mine: (sentenceIndex: number) => string;
    note: string;
};

function scoreWhole(groups: SentenceGroup[], all: Word[], draft: string): Scored {
    const cmp = compareWords(all, words(draft));
    const aligned = alignDraft(all.map((w) => w.loose), draft);
    return {
        ...cmp,
        mine: (i) => groups[i].items.map(({ index }) => aligned[index] || "").join("").trim(),
        note: "",
    };
}

function scoreSentences(groups: SentenceGroup[], drafts: Record<number, string>): Scored {
    const hits = new Set<number>(), accentOnly = new Set<number>();
    let h = 0, a = 0, denom = 0, done = 0;
    groups.forEach((g, i) => {
        const d = drafts[i];
        if (!d?.trim()) return;
        done++;
        const c = compareWords(g.items.map((x) => x.word), words(d));
        c.hits.forEach((k) => hits.add(g.items[k].index));
        c.accentOnly.forEach((k) => accentOnly.add(g.items[k].index));
        h += c.hits.size; a += c.accentOnly.size;
        denom += Math.max(g.items.length, countWords(d));
    });
    return {
        hits, accentOnly,
        accuracy: denom ? Math.round((h / denom) * 100) : 0,
        looseAccuracy: denom ? Math.round(((h + a) / denom) * 100) : 0,
        mine: (i) => drafts[i] || "",
        note: `已听写 ${done} / ${groups.length} 句（只统计写过的句子）`,
    };
}

export function CheckPanel({ groups, all, record, player, ignoreAccents, setIgnoreAccents, showComparison, setShowComparison, onSave, copyKey }: {
    groups: SentenceGroup[];
    all: Word[];
    record: MediaRecord;
    player: RefObject<PlayerHandle | null>;
    ignoreAccents: boolean;
    setIgnoreAccents: (v: boolean) => void;
    showComparison: boolean;
    setShowComparison: (v: boolean) => void;
    onSave: (s: Selected, type: EntryType) => void;
    copyKey: string;
}) {
    // Scoring runs in the background while typing elsewhere; deferring keeps the UI responsive.
    const draft = useDeferredValue(record.draft);
    const drafts = useDeferredValue(record.sentenceDrafts);
    const scored = useMemo(
        () => (record.style === "sentence" ? scoreSentences(groups, drafts) : scoreWhole(groups, all, draft)),
        [record.style, groups, all, draft, drafts],
    );
    const [selection, setSelection] = useState<{ start: number; end: number } | null>(null);
    const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
    const [copied, setCopied] = useState<{ id: string; message: string } | null>(null);

    useEffect(() => {
        const close = (e: PointerEvent) => {
            if (e.button === 0 && !(e.target instanceof Element && e.target.closest(".selection-panel"))) { setSelection(null); setMenu(null); }
        };
        document.addEventListener("pointerdown", close);
        return () => document.removeEventListener("pointerdown", close);
    }, []);

    const selected = useMemo<Selected | null>(() => {
        if (!selection) return null;
        const s = Math.min(selection.start, selection.end), e = Math.max(selection.start, selection.end);
        const phrase = all.slice(s, e + 1).map((x) => x.raw).join(" ");
        const gi = groups.findIndex((g) => g.items.some((x) => x.index === s));
        const g = groups[gi];
        return g
            ? { phrase, sentence: g.text, start: g.start, end: g.end, draft: scored.mine(gi) }
            : { phrase, sentence: phrase, start: 0, end: 0, draft: "" };
    }, [selection, all, groups, scored]);

    const copy = async (g: SentenceGroup, id: string) => {
        try { await navigator.clipboard.writeText(g.text); setCopied({ id, message: "已复制" }); }
        catch { setCopied({ id, message: "复制失败" }); }
    };

    if (!groups.length) return (
        <>
            <div className="panel-title"><div><span>02</span><div><strong>自动字幕核对</strong><small>忽略大小写和标点</small></div></div></div>
            <div className="check-empty">请返回第一步解析当前视频。</div>
        </>
    );

    const shown = ignoreAccents ? scored.looseAccuracy : scored.accuracy;
    return (
        <>
            <div className="panel-title">
                <div><span>02</span><div><strong>自动字幕核对</strong><small>{scored.note || "忽略大小写和标点"}</small></div></div>
                <strong className="accuracy">{shown}%</strong>
            </div>
            <div className="review-toolbar">
                <div role="group" aria-label="核对视图">
                    <button aria-pressed={!showComparison} onClick={() => setShowComparison(false)}>字幕视图</button>
                    <button aria-pressed={showComparison} onClick={() => setShowComparison(true)}>对照视图</button>
                </div>
                <label className="toggle">
                    <input type="checkbox" checked={ignoreAccents} onChange={(e) => setIgnoreAccents(e.target.checked)} />
                    重音写错不扣分
                </label>
                <small>
                    <i className="legend matched" />对 <i className="legend accent" />只差重音 <i className="legend missed" />没听出
                    · 右键选词收藏，Shift+右键扩选
                </small>
            </div>
            <div className="sentence-list">
                {groups.map((g, gi) => {
                    const id = `${copyKey}:${gi}`;
                    return (
                        <article className="sentence-card" key={`${g.start}-${gi}`}>
                            <button className="sentence-time" title="播放这一句" onClick={() => player.current?.playRange(g.start, g.end)}>{time(g.start)}</button>
                            <div>
                                <div className="sentence-heading">
                                    {showComparison && <small className="comparison-label">正确字幕</small>}
                                    <button className="copy-sentence" aria-label="复制本句正确字幕" onClick={() => void copy(g, id)}>
                                        {copied?.id === id ? copied.message : "复制"}
                                    </button>
                                </div>
                                {g.items.map(({ word, index, timing }) => {
                                    const cls = scored.hits.has(index) || (ignoreAccents && scored.accentOnly.has(index)) ? "matched" : scored.accentOnly.has(index) ? "accent" : "missed";
                                    const chosen = selection && index >= Math.min(selection.start, selection.end) && index <= Math.max(selection.start, selection.end);
                                    return (
                                        <button key={index} className={`${cls} ${chosen ? "chosen" : ""}`}
                                            onClick={() => { setSelection(null); setMenu(null); player.current?.playRange(timing.start); }}
                                            onContextMenu={(e) => {
                                                e.preventDefault();
                                                setMenu({ x: Math.max(12, Math.min(e.clientX + 10, window.innerWidth - 402)), y: Math.max(12, Math.min(e.clientY + 10, window.innerHeight - 190)) });
                                                setSelection((x) => (e.shiftKey && x ? { start: x.start, end: index } : { start: index, end: index }));
                                            }}>{word.raw}</button>
                                    );
                                })}
                                {showComparison && (
                                    <div className="draft-comparison">
                                        <small className="comparison-label">我的听写</small>
                                        <p>{scored.mine(gi).trim() || "此处未填写"}</p>
                                    </div>
                                )}
                            </div>
                        </article>
                    );
                })}
            </div>
            {selected && menu && (
                <div className="selection-panel floating" style={{ left: menu.x, top: menu.y }}>
                    <strong>{selected.phrase}</strong>
                    <small>{selected.sentence}</small>
                    <div>
                        <button onClick={() => { onSave(selected, "vocab"); setSelection(null); }}>加入生词</button>
                        <button onClick={() => { onSave(selected, "missed"); setSelection(null); }}>认识，但没听出来</button>
                        <button onClick={() => { onSave(selected, "phonetic"); setSelection(null); }}>连读／弱读问题</button>
                        <button onClick={() => { setSelection(null); setMenu(null); }}>忽略</button>
                    </div>
                </div>
            )}
        </>
    );
}
