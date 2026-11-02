// Adapted from yunx738/ais2api 38f2355, CC BY-NC 4.0.
"use strict";
// Uploaded SillyTavern chat-completion presets -> server-side context splitting for the Build channel.
// Same rule as the build-standalone adapter: preset prompts (main/jailbreak/custom entries) go to the
// composer (inline); everything else (card, world info, examples, history) goes to the attachment (file).
// The adapter tagged prompts inside ST; here each prompt's expanded text is located in the final messages.
// Macros ({{char}}, {{user}}, <USER> ...) are expanded by ST, so they act as wildcards between literal chunks.
const fs = require("fs"),
    crypto = require("crypto");
const tokens = s => Buffer.byteLength(s);
const LIMITS = { inlineBudget: 180000 };
const { WIRE_PREFIX } = require("./SillyTavern");
const BACKGROUND = new Set([
    "worldInfoBefore",
    "worldInfoAfter",
    "charDescription",
    "charPersonality",
    "scenario",
    "personaDescription",
    "dialogueExamples",
    "chatHistory",
    "summary",
    "authorsNote",
    "vectorsMemory",
    "vectorsDataBank",
    "smartContext",
]);
const MIN_LITERAL = 12,
    MAX_GAP = 300000,
    GAP_FILE = 1500,
    MAX_PRESETS = 20,
    MAX_PROMPTS = 1000,
    MAX_DEPTH = 8;
const fail = (m, s = 400) => Object.assign(Error(m), { status: s });
const norm = t =>
    String(t)
        .replace(/^\uFEFF/, "")
        .replace(/\r\n?/g, "\n");
// Literal text pieces of a prompt. Removed as wildcards: {{...}} (nested, e.g. {{random::..{{random::..}}}}),
// <% ... %> templates, <USER>/<BOT>/<CHAR> and $X placeholders ($8 user input, $U persona, $C card ...).
function chunksOf(text) {
    text = norm(text);
    const out = [];
    let buf = "",
        i = 0;
    const flush = () => {
        const t = buf.trim();
        if (t) out.push(t);
        buf = "";
    };
    while (i < text.length) {
        if (text.startsWith("{{", i)) {
            let d = 0,
                j = i;
            while (j < text.length) {
                if (text.startsWith("{{", j)) {
                    d++;
                    j += 2;
                } else if (text.startsWith("}}", j)) {
                    d--;
                    j += 2;
                    if (!d) break;
                } else j++;
            }
            flush();
            i = j;
            continue;
        }
        if (text.startsWith("<%", i)) {
            const j = text.indexOf("%>", i + 2);
            flush();
            i = j < 0 ? text.length : j + 2;
            continue;
        }
        if (text[i] === "<") {
            const m = /^<(?:USER|BOT|CHAR|CHARIFNOTGROUP|GROUP)>/i.exec(text.slice(i, i + 20));
            if (m) {
                flush();
                i += m[0].length;
                continue;
            }
        }
        if (text[i] === "$" && /^\$[0-9A-Z](?![0-9A-Za-z])/.test(text.slice(i, i + 3))) {
            flush();
            i += 2;
            continue;
        }
        buf += text[i++];
    }
    flush();
    return out;
}
// Every object with a string `content` anywhere in the file: ST chat presets (prompts[]), plot presets
// (top-level array, promptGroup[], plotTasks[].promptGroup[]) and wrapped exports alike.
function collect(node, depth, out) {
    if (depth > MAX_DEPTH || !node || typeof node !== "object" || out.length >= MAX_PROMPTS * 4) return;
    if (Array.isArray(node)) {
        for (const x of node) {
            if (x && typeof x === "object" && !Array.isArray(x) && typeof x.content === "string") out.push(x);
            else collect(x, depth + 1, out);
        }
    } else for (const v of Object.values(node)) collect(v, depth + 1, out);
}
function parsePreset(preset) {
    if (!preset || typeof preset !== "object") throw fail("文件内容不是预设（需要 JSON 对象或数组）");
    const items = [];
    collect(preset, 0, items);
    if (!items.length) throw fail("文件里没有找到提示词条目（带 content 的条目）");
    const out = [],
        seen = new Set();
    for (const p of items) {
        if (out.length >= MAX_PROMPTS) break;
        if (p.marker === true) continue;
        const ident = String(p.identifier || p.id || "").slice(0, 100);
        if (BACKGROUND.has(ident)) continue;
        const chunks = chunksOf(p.content);
        if (chunks.join("").length < MIN_LITERAL) continue;
        const key = chunks.join("\u0000");
        if (seen.has(key)) continue;
        seen.add(key);
        const label =
            p.name ||
            p.identifier ||
            chunks
                .reduce((a, b) => (b.length > a.length ? b : a), "")
                .replace(/\s+/g, " ")
                .slice(0, 18) + "…";
        out.push({ chunks, id: (ident || "p") + "#" + out.length, name: String(label).slice(0, 128) });
    }
    if (!out.length) throw fail("预设里没有可识别的条目（条目需有正文，且不能只有宏）");
    return out;
}
// One prompt inside text from `from`: anchor on its longest literal chunk, extend to neighbours on both sides.
// Returns chunk positions [[s,e],...] or null.
function findOne(text, chunks, from) {
    let k = 0;
    for (let i = 1; i < chunks.length; i++) if (chunks[i].length > chunks[k].length) k = i;
    let pos = text.indexOf(chunks[k], from);
    while (pos >= 0) {
        const hit = new Array(chunks.length);
        hit[k] = [pos, pos + chunks[k].length];
        let ok = true;
        for (let i = k - 1; i >= 0 && ok; i--) {
            const lim = hit[i + 1][0] - chunks[i].length;
            const at = lim < from ? -1 : text.lastIndexOf(chunks[i], lim);
            if (at < from || hit[i + 1][0] - (at + chunks[i].length) > MAX_GAP) ok = false;
            else hit[i] = [at, at + chunks[i].length];
        }
        for (let i = k + 1; i < chunks.length && ok; i++) {
            const at = text.indexOf(chunks[i], hit[i - 1][1]);
            if (at < 0 || at - hit[i - 1][1] > MAX_GAP) ok = false;
            else hit[i] = [at, at + chunks[i].length];
        }
        if (ok) return hit;
        pos = text.indexOf(chunks[k], pos + 1);
    }
    return null;
}
function spans(text, prompts) {
    const found = [];
    const free = (a, b) => !found.some(s => a < s.end && b > s.start);
    for (const p of prompts) {
        let from = 0,
            hit;
        while (from < text.length && (hit = findOne(text, p.chunks, from))) {
            const start = hit[0][0],
                end = hit[hit.length - 1][1];
            if (free(start, end)) found.push({ end, pos: hit, source: p.id, start });
            from = end;
        }
    }
    return found.sort((a, b) => a.start - b.start);
}
function textOf(content) {
    if (typeof content === "string") return content;
    if (Array.isArray(content) && content.every(p => p && p.type === "text" && typeof p.text === "string"))
        return content.map(p => p.text).join("");
    return null;
}
// messages -> prepared {segments,generationType,inlineTokens,hits,matched} or null (no preset text found / not applicable).
function segment(messages, prompts) {
    if (!Array.isArray(messages) || !messages.length || !prompts.length) return null;
    const rows = [];
    for (const m of messages) {
        if (!m || !["system", "developer", "user", "assistant", "tool", "function"].includes(m.role)) return null;
        const t = textOf(m.content ?? "");
        if (t === null) return null;
        rows.push({
            name: typeof m.name === "string" && m.name ? m.name.slice(0, 128) : undefined,
            role: m.role,
            text: t,
        });
    }
    if (rows.length === 1 && rows[0].text.startsWith(WIRE_PREFIX)) return null;
    const ordered = prompts.slice().sort((a, b) => b.chunks.join("").length - a.chunks.join("").length);
    const conv = rows.map((r, i) => (r.role === "user" || r.role === "assistant" ? i : -1)).filter(i => i >= 0);
    const last = conv.length ? conv[conv.length - 1] : -1;
    const generationType = last >= 0 && rows[last].role === "assistant" ? "continue" : "normal";
    const segments = [],
        matched = new Set();
    let hits = 0;
    rows.forEach((r, i) => {
        const base = { message: i, role: r.role, ...(r.name ? { name: r.name } : {}) };
        const toolHistory =
            ["tool", "function"].includes(r.role) || messages[i].tool_calls || messages[i].function_call;
        const list = toolHistory ? [] : spans(r.text, ordered);
        const rest = ["file", "context"];
        let part = 0,
            at = 0;
        const originalParts = Array.isArray(messages[i].content) ? messages[i].content : null;
        let offset = 0;
        const boundaries = originalParts?.map(p => {
            offset += p.text.length;
            return offset;
        });
        offset = 0;
        const push = (text, placement, source) => {
            if (!boundaries) {
                if (text.length) segments.push({ ...base, part: part++, placement, source, text });
                return;
            }
            let cursor = 0;
            while (cursor < text.length) {
                const contentPart = boundaries.findIndex(end => end > offset);
                const size = Math.min(text.length - cursor, boundaries[contentPart] - offset);
                segments.push({
                    ...base,
                    contentPart,
                    part: part++,
                    placement,
                    source,
                    text: text.slice(cursor, cursor + size),
                });
                cursor += size;
                offset += size;
            }
        };
        for (const s of list) {
            push(r.text.slice(at, s.start), ...rest);
            hits++;
            matched.add(s.source);
            let piece = s.start;
            for (let k = 1; k < s.pos.length; k++) {
                const gs = s.pos[k - 1][1],
                    ge = s.pos[k][0];
                if (ge - gs > GAP_FILE) {
                    push(r.text.slice(piece, gs), "inline", s.source);
                    push(r.text.slice(gs, ge), ...rest);
                    piece = ge;
                }
            }
            push(r.text.slice(piece, s.end), "inline", s.source);
            at = s.end;
        }
        push(r.text.slice(at), ...rest);
        if (!segments.some(x => x.message === i))
            segments.push({ ...base, part: 0, placement: rest[0], source: rest[1], text: r.text });
    });
    if (!hits) return null;
    const inline = segments.filter(x => x.placement === "inline").reduce((n, x) => n + tokens(x.text), 0);
    if (inline > LIMITS.inlineBudget) throw fail("已命中预设超过直接输入保守预算；未移动或截断", 413);
    const messageMetadata = messages.flatMap((m, message) => {
        const fields = Object.fromEntries(
            ["tool_calls", "tool_call_id", "function_call"].filter(k => m[k] !== undefined).map(k => [k, m[k]])
        );
        return Object.keys(fields).length
            ? [{ message, ...fields, ...(m.content === null ? { contentNull: true } : {}) }]
            : [];
    });
    return { generationType, hits, inlineTokens: inline, matched: [...matched], messageMetadata, segments };
}
const envelope = p =>
    WIRE_PREFIX +
    JSON.stringify({
        generationType: p.generationType,
        inlineTokens: p.inlineTokens,
        segments: p.segments,
        version: 1,
    });
class PresetStore {
    constructor(file) {
        this.file = file;
        this.cache = null;
    }
    read() {
        if (this.cache) return this.cache;
        try {
            const d = JSON.parse(fs.readFileSync(this.file, "utf8"));
            this.cache = Array.isArray(d.presets) ? d : { presets: [] };
        } catch {
            this.cache = { presets: [] };
        }
        return this.cache;
    }
    save() {
        require("../../config/ConfigurationService").atomicWrite(this.file, this.cache);
    }
    list() {
        return this.read().presets.map(p => ({
            enabled: p.enabled !== false,
            id: p.id,
            lastHitAt: p.lastHitAt || null,
            lastHits: p.lastHits || 0,
            name: p.name,
            prompts: p.prompts.map(x => x.name),
            requests: p.requests || 0,
            uploadedAt: p.uploadedAt,
        }));
    }
    add(name, preset) {
        const prompts = parsePreset(preset);
        const d = this.read();
        if (d.presets.length >= MAX_PRESETS) throw fail("最多保存 " + MAX_PRESETS + " 个预设，请先删除不用的");
        const item = {
            enabled: true,
            id: crypto.randomBytes(6).toString("hex"),
            name:
                String(name || "预设")
                    .replace(/\.json$/i, "")
                    .slice(0, 80) || "预设",
            prompts,
            uploadedAt: Date.now(),
        };
        d.presets.push(item);
        this.save();
        return { id: item.id, name: item.name, prompts: prompts.length };
    }
    remove(id) {
        const d = this.read(),
            n = d.presets.length;
        d.presets = d.presets.filter(p => p.id !== id);
        if (d.presets.length === n) throw fail("预设不存在", 404);
        this.save();
        return { ok: true };
    }
    setEnabled(id, on) {
        const p = this.read().presets.find(x => x.id === id);
        if (!p) throw fail("预设不存在", 404);
        p.enabled = !!on;
        this.save();
        return { ok: true };
    }
    // messages -> {content,hits,inlineTokens} (envelope for the worker) or null.
    apply(messages) {
        const active = this.read().presets.filter(p => p.enabled !== false);
        if (!active.length) return null;
        const prepared = segment(
            messages,
            active.flatMap(p => p.prompts)
        );
        if (!prepared) return null;
        const now = Date.now();
        for (const p of active) {
            const n = p.prompts.filter(x => prepared.matched.includes(x.id)).length;
            if (n) {
                p.requests = (p.requests || 0) + 1;
                p.lastHitAt = now;
                p.lastHits = n;
            }
        }
        try {
            this.save();
        } catch {
            /* Hit metrics must not fail generation. */
        }
        return prepared;
    }
}
module.exports = { chunksOf, envelope, parsePreset, PresetStore, segment, spans };
