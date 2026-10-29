const { parseWire, isChunk, convChunk, rpcStatusOf, RPC_STATUS } = require("./MakerSuiteCodec");
const { promptBlocked } = require("../utils/UpstreamBlock");
const invalid = message => Object.assign(new Error(message), { status: 502 });

// Like AIStudio2API's decodeGenerateItems, consume complete repeated messages,
// independently of HTTP/UTF-8 boundaries. Discard consumed messages so a streamed
// response uses memory proportional to one message, rather than the generation.
class PlaygroundStreamDecoder {
    constructor(consume, maxMessageChars = 16 * 1024 * 1024) {
        this.consume = consume;
        this.maxMessageChars = maxMessageChars;
        this.stack = [];
        this.quoted = false;
        this.escaped = false;
        this.started = false;
        this.ended = false;
        this.seen = false;
        this.blocked = false;
        this.candidates = new Map();
    }

    push(text) {
        for (const char of text) {
            if (this.ended) {
                if (!/\s/.test(char)) throw invalid("Unexpected data after Playground response");
                continue;
            }
            if (!this.started) {
                if (/\s/.test(char)) continue;
                if (char !== "[") throw invalid("Playground response root must be an array");
                this.started = true;
            }
            if (!this.quoted && (char === "[" || char === "{")) {
                if (this.stack.length >= 128) throw invalid("Playground response nesting exceeds limit");
                this.stack.push({ emitted: false, text: char });
                continue;
            }
            const frame = this.stack.at(-1);
            if (!frame) throw invalid("Invalid Playground response nesting");
            frame.text += char;
            if (frame.text.length > this.maxMessageChars)
                throw invalid("Playground response message exceeds size limit");
            if (this.quoted) {
                if (this.escaped) this.escaped = false;
                else if (char === "\\") this.escaped = true;
                else if (char === '"') this.quoted = false;
                continue;
            }
            if (char === '"') {
                this.quoted = true;
                continue;
            }
            if (char !== "]" && char !== "}") continue;
            const depth = this.stack.length;
            this.stack.pop();
            let emitted = frame.emitted;
            if (depth <= 3) {
                let value;
                try {
                    value = parseWire(frame.text);
                } catch {
                    throw invalid("Invalid Playground response JSON");
                }
                const status = rpcStatusOf(value);
                if (status && !this.blocked)
                    throw Object.assign(new Error(status[1]), {
                        rpcStatus: status,
                        status: RPC_STATUS[status[0]] || 502,
                    });
                if (!emitted && isChunk(value)) {
                    const chunk = convChunk(value);
                    this.seen = true;
                    this.blocked ||= !!promptBlocked(chunk);
                    for (const candidate of chunk.candidates || [])
                        this.candidates.set(
                            candidate.index,
                            candidate.finishReason || this.candidates.get(candidate.index)
                        );
                    this.consume(chunk);
                    emitted = true;
                }
            }
            const parent = this.stack.at(-1);
            if (parent) {
                parent.text += emitted ? "null" : frame.text;
                parent.emitted ||= emitted;
                // Remove completed message placeholders while retaining a valid
                // skeleton for final JSON syntax validation.
                if (emitted && parent.text.endsWith("null,null")) parent.text = parent.text.slice(0, -5);
            } else this.ended = true;
        }
    }

    finish() {
        if (!this.ended || this.stack.length || this.quoted) throw invalid("Playground response was truncated");
        if (!this.seen || (!this.blocked && (!this.candidates.size || [...this.candidates.values()].some(x => !x))))
            throw invalid("Playground response ended without a confirmed finish reason");
    }
}
module.exports = PlaygroundStreamDecoder;
