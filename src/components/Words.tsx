import { useMemo, useState, type RefObject } from "react";
import type { Entry, EntryType } from "../lib/api";
import { csvCell, time } from "../lib/text";
import type { PlayerHandle } from "./Player";

const LABEL: Record<EntryType, string> = { vocab: "生词", missed: "认识但漏听", phonetic: "连读／弱读" };

export function entriesToCsv(entries: Entry[]) {
    const head = ["词语", "类型", "原句", "我的听写", "来源", "时间点", "添加日期"];
    const rows = entries.map((e) => [
        e.phrase, LABEL[e.type], e.sentence, e.draft, e.source.title, time(e.start), new Date(e.createdAt).toLocaleDateString(),
    ]);
    // BOM so Excel opens UTF-8 (accents, Chinese) correctly; Anki ignores it.
    return "﻿" + [head, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n");
}

export function WordsPanel({ entries, currentKey, player, onRemove, onOpenSource, onExport }: {
    entries: Entry[];
    currentKey: string;
    player: RefObject<PlayerHandle | null>;
    onRemove: (id: string) => void;
    onOpenSource: (e: Entry) => void;
    onExport: (list: Entry[]) => void;
}) {
    const [scope, setScope] = useState<"all" | "current">("all");
    const [type, setType] = useState<EntryType | "all">("all");
    const currentCount = useMemo(() => entries.filter((e) => e.source.key === currentKey).length, [entries, currentKey]);
    const list = useMemo(
        () => entries
            .filter((e) => (scope === "all" || e.source.key === currentKey) && (type === "all" || e.type === type))
            .sort((a, b) => b.createdAt - a.createdAt),
        [entries, scope, type, currentKey],
    );
    return (
        <>
            <div className="panel-title">
                <div><span>03</span><div><strong>词语与听力问题</strong><small>所有视频共用一个词库</small></div></div>
                <button className="primary" disabled={!list.length} onClick={() => onExport(list)}>导出 CSV（Excel / Anki）</button>
            </div>
            <div className="review-toolbar">
                <div role="group" aria-label="范围">
                    <button aria-pressed={scope === "all"} onClick={() => setScope("all")}>全部 {entries.length}</button>
                    <button aria-pressed={scope === "current"} onClick={() => setScope("current")}>当前视频 {currentCount}</button>
                </div>
                <div role="group" aria-label="类型">
                    {(["all", "vocab", "missed", "phonetic"] as const).map((t) => (
                        <button key={t} aria-pressed={type === t} onClick={() => setType(t)}>{t === "all" ? "全部类型" : LABEL[t]}</button>
                    ))}
                </div>
            </div>
            <div className="entry-list">
                {list.length ? list.map((x) => {
                    const here = x.source.key === currentKey;
                    return (
                        <article key={x.id}>
                            <header>
                                <span className={`entry-type ${x.type}`}>{LABEL[x.type]}</span>
                                <strong>{x.phrase}</strong>
                                <button aria-label="删除" onClick={() => onRemove(x.id)}>×</button>
                            </header>
                            <p>{x.sentence}</p>
                            {x.draft && x.draft.trim() !== x.sentence.trim() && <p className="entry-draft">我当时写的：{x.draft}</p>}
                            <div className="entry-actions">
                                {here
                                    ? <button onClick={() => player.current?.playRange(x.start, x.end)}>▶ 重播原句 {time(x.start)}</button>
                                    : <button onClick={() => onOpenSource(x)}>打开来源视频</button>}
                                <small>{x.source.title}</small>
                            </div>
                        </article>
                    );
                }) : <p>{entries.length ? "这个筛选下没有记录。" : "还没有记录。在「核对」里右键单词即可收藏。"}</p>}
            </div>
        </>
    );
}
