import { test } from "node:test";
import assert from "node:assert/strict";
import { alignDraft, compareWords, csvCell, groupSentences, loose, sentenceAt, words } from "../src/lib/text.ts";

const keys = (s: string) => words(s).map((w) => w.loose);

// --- alignment (ported from ES Escucha 1 tests) ---
test("case and punctuation are ignored without rewriting the draft", () => {
    assert.deepEqual(alignDraft(keys("la policía"), "LA policía."), ["LA ", "policía."]);
});
test("missing accents still align to the right word", () => {
    assert.deepEqual(alignDraft(keys("la policía"), "la policia"), ["la ", "policia"]);
});
test("replacement, missing words and empty draft", () => {
    assert.deepEqual(alignDraft(["uno", "dos", "tres"], "uno mal tres"), ["uno ", "mal ", "tres"]);
    assert.deepEqual(alignDraft(["uno", "dos", "tres"], "uno tres"), ["uno ", "", "tres"]);
    assert.deepEqual(alignDraft(["uno"], ""), [""]);
});
test("insertions attach forward, trailing words attach to the final word", () => {
    assert.deepEqual(alignDraft(["uno", "dos"], "uno extra dos fin"), ["uno ", "extra dos fin"]);
});
test("all draft tokens including extra punctuation survive", () => {
    const input = "uno  ???\nmal, extra fin!";
    assert.equal(alignDraft(["uno", "dos", "fin"], input).join(""), input);
});
test("standalone punctuation has no alignment cost", () => {
    assert.deepEqual(alignDraft(["uno", "dos"], "¿ uno ? dos !"), ["¿ uno ? ", "dos !"]);
});

// --- scoring ---
test("accent-only differences are detected separately", () => {
    const c = compareWords(words("Él está aquí"), words("el esta aqui"));
    assert.deepEqual([...c.hits], []);
    assert.deepEqual([...c.accentOnly].sort(), [0, 1, 2]);
    assert.equal(c.accuracy, 0);
    assert.equal(c.looseAccuracy, 100);
});
test("ñ is a different letter, not an accent", () => {
    assert.equal(loose("año"), "año");
    const c = compareWords(words("año"), words("ano"));
    assert.equal(c.hits.size + c.accentOnly.size, 0);
});
test("score uses the longer side so extra words are penalised", () => {
    const c = compareWords(words("hola amigo"), words("hola mi amigo querido"));
    assert.equal(c.hits.size, 2);
    assert.equal(c.accuracy, 50);
});
test("long transcripts stay fast", () => {
    const ref = words(Array.from({ length: 3000 }, (_, i) => `palabra${i % 50}`).join(" "));
    const draft = words(Array.from({ length: 2800 }, (_, i) => `palabra${i % 47}`).join(" "));
    const t = performance.now();
    compareWords(ref, draft);
    assert.ok(performance.now() - t < 1500, "3000×2800 comparison should take well under 1.5 s");
});

// --- sentences ---
const segments = [
    { start: 0, end: 4, text: "Hola, ¿qué tal? Muy bien.", words: [
        { text: "Hola,", start: 0, end: 0.5 }, { text: "¿qué", start: 0.6, end: 1 }, { text: "tal?", start: 1, end: 1.4 },
        { text: "Muy", start: 2, end: 2.5 }, { text: "bien.", start: 2.5, end: 3 }] },
    { start: 5, end: 7, text: "Y tú" },
];
test("segments split into sentences with timings and global indices", () => {
    const { groups, all } = groupSentences(segments);
    assert.equal(all.length, 7);
    assert.deepEqual(groups.map((g) => g.text), ["Hola, ¿qué tal?", "Muy bien.", "Y tú"]);
    assert.deepEqual(groups.map((g) => [g.start, g.end]), [[0, 1.4], [2, 3], [5, 7]]);
    assert.deepEqual(groups[2].items.map((x) => x.index), [5, 6]);
});
test("sentenceAt finds the sentence playing at a time", () => {
    const { groups } = groupSentences(segments);
    assert.equal(sentenceAt(groups, 0.2), 0);
    assert.equal(sentenceAt(groups, 2.7), 1);
    assert.equal(sentenceAt(groups, 4.5), 1);
    assert.equal(sentenceAt(groups, 99), 2);
});

test("csv cells are escaped", () => {
    assert.equal(csvCell('dijo "hola", vale'), '"dijo ""hola"", vale"');
    assert.equal(csvCell("simple"), "simple");
});
