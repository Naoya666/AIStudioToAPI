const { promptBlocked, usageMetadataOf } = require("./UpstreamBlock");

// Validate whole generation events before any part reaches a protocol converter.
// Network messages need not coincide with JSON or SSE event boundaries.
class GenerationResponseGuard {
    constructor(context = {}, maxBytes = Infinity, onIncomplete = null) {
        this.context = context;
        this.maxBytes = maxBytes;
        this.onIncomplete = onIncomplete;
        this.bytes = 0;
        this.input = "";
        this.scanned = 0;
        this.depth = 0;
        this.quoted = false;
        this.escaped = false;
        this.terminal = false;
    }

    push(message) {
        if (this.terminal) return [];
        if (message.event_type === "response_headers") {
            this.context.upstreamHttpStatus = message.status;
            return [message];
        }
        const eof = message.type === "STREAM_END";
        if (!message.data && !eof) return [message];
        this.input += message.data || "";
        this.bytes += Buffer.byteLength(message.data || "");
        if (this.bytes > this.maxBytes) {
            this.terminal = true;
            this.input = "";
            return [
                {
                    code: "anti_truncation_limit",
                    event_type: "error",
                    message: "Anti-truncation response exceeds size limit",
                    responseGuardError: true,
                    status: 502,
                },
            ];
        }
        const output = [];
        while (this.input.trim()) {
            const json = /^\s*[[{]/.test(this.input);
            let end = -1;
            if (json) {
                for (; this.scanned < this.input.length; this.scanned++) {
                    const ch = this.input[this.scanned];
                    if (this.quoted) {
                        if (this.escaped) this.escaped = false;
                        else if (ch === "\\") this.escaped = true;
                        else if (ch === '"') this.quoted = false;
                    } else if (ch === '"') this.quoted = true;
                    else if (ch === "{" || ch === "[") this.depth++;
                    else if ((ch === "}" || ch === "]") && --this.depth === 0) {
                        end = this.scanned + 1;
                        break;
                    }
                }
            } else {
                const separator = /\r?\n\r?\n/.exec(this.input.slice(Math.max(0, this.scanned - 3)));
                if (separator) end = Math.max(0, this.scanned - 3) + separator.index + separator[0].length;
                this.scanned = this.input.length;
            }
            if (end < 0 && !eof) {
                this.onIncomplete?.();
                break;
            }
            if (end < 0) end = this.input.length;
            const data = this.input.slice(0, end);
            this.input = this.input.slice(end);
            this.scanned = 0;
            this.depth = 0;
            this.quoted = false;
            this.escaped = false;
            const raw = json
                ? data
                : data
                      .split(/\r?\n/)
                      .filter(line => line.startsWith("data:"))
                      .map(line => line.slice(5).trimStart())
                      .join("\n");
            let response;
            try {
                response = JSON.parse(raw);
            } catch {
                // Existing protocol decoders remain responsible for malformed responses and DONE.
            }
            const responses = Array.isArray(response) ? response : [response];
            for (const item of responses) {
                if (item?.usageMetadata) this.usageMetadata = usageMetadataOf(item.usageMetadata) || this.usageMetadata;
                const error = promptBlocked(item);
                if (error) {
                    Object.assign(error, this.context);
                    error.usageMetadata ||= this.usageMetadata;
                    output.push({ ...error, event_type: "error", message: error.message });
                    this.terminal = true;
                    this.input = "";
                    return output;
                }
            }
            const hasModelContent = responses.some(
                item =>
                    Array.isArray(item?.candidates) &&
                    item.candidates.some(
                        candidate =>
                            Array.isArray(candidate?.content?.parts) &&
                            candidate.content.parts.some(
                                part =>
                                    part?.text ||
                                    part?.functionCall ||
                                    part?.inlineData ||
                                    part?.executableCode ||
                                    part?.codeExecutionResult ||
                                    part?.fileData ||
                                    part?.toolCall ||
                                    part?.toolResponse
                            )
                    )
            );
            output.push({
                ...message,
                data: !json && response ? `data: ${JSON.stringify(response)}\n\n` : data,
                event_type: "chunk",
                hasModelContent,
                type: undefined,
            });
        }
        if (!this.input.trim()) this.input = "";
        if (eof) output.push(message);
        return output;
    }
}

module.exports = GenerationResponseGuard;
