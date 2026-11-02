const { randomBytes } = require("node:crypto");
const Ajv = require("ajv");
const Tools = require("./ToolContract");
const { MAX_BYTES } = require("../AntiTruncation");
const fail = (code, message) =>
    Object.assign(new Error(message), {
        code,
        kind: "capability",
        retryable: false,
        status: 502,
    });
function prepare(contract) {
    const definitions = contract?.enabled ? contract.definitions : [];
    const names = new Set(definitions.map(f => f.name));
    let name;
    do {
        name = "agw_emit_" + randomBytes(12).toString("hex");
    } while (names.has(name));
    const parameters = {
        additionalProperties: false,
        properties: { content: { type: "string" } },
        required: ["content"],
        type: "object",
    };
    const synthetic = {
        description:
            "Internal answer transport: put the complete final answer in content. Never wrap genuine client tool calls.",
        name,
        parameters,
    };
    const validators = new Map(definitions.map(f => [f.name, contract.validators.get(f.name)]));
    validators.set(name, new Ajv({ strict: false }).compile(parameters));
    const forcedReal = contract?.mode === "strict" && contract.forced;
    const requiredReal = contract?.mode === "strict" && contract.choice === "required";
    const textOnly = !contract?.enabled;
    const transport = {
        choice: textOnly ? { function: { name }, type: "function" } : forcedReal ? contract.choice : "auto",
        definitions: [...definitions, synthetic],
        enabled: true,
        forced: textOnly ? name : forcedReal || undefined,
        historyIds: contract?.historyIds || new Set(),
        legacy: false,
        messages: contract?.messages || [],
        mode: contract?.mode || "strict",
        parallel: contract?.mode === "auto_fallback" ? true : contract?.parallel !== false,
        validators,
    };
    const instructions =
        Tools.toolInstructions(transport) +
        `\nAnswer transport ${name} is internal, not an external action. ` +
        (forcedReal || requiredReal
            ? `This turn MUST request the genuine client function${forcedReal ? " " + forcedReal : "s"}; do not call ${name} instead.`
            : `For a final answer call ${name} exactly once with the ENTIRE answer as content, and set the outer content to null. Do not emit final prose outside this function. Genuine client calls must be returned directly and alone, never together with ${name}.`) +
        " Do not write tool results. Preserve complete Unicode, code blocks, newlines and escapes in content.";
    const finalEnvelope = `{"content":null,"tool_calls":[{"name":${JSON.stringify(name)},"arguments":{"content":"<entire final answer>"}}]}`;
    const directInstructions =
        forcedReal || requiredReal
            ? `MANDATORY RESPONSE FORMAT: Request the genuine client function${forcedReal ? " " + forcedReal : "s"} using the attached externalToolProtocol JSON envelope. Do not substitute the internal answer transport ${name}. Never execute the function or invent its result.`
            : `MANDATORY RESPONSE FORMAT: Return exactly one JSON object without Markdown fences. For the final answer use ${finalEnvelope}. Put ALL requested user-visible text inside arguments.content, even if the conversation asks for bare text or an exact marker. Genuine external client calls must instead use the attached externalToolProtocol envelope and must not be mixed with ${name}.`;
    return { contract, directInstructions, instructions, name, transport };
}
// Repair only missing closing delimiters. Never complete a token, escape or Unicode escape.
function closeJSON(source) {
    const stack = [];
    let quoted = false,
        escaped = false,
        unicode = 0;
    for (const ch of source) {
        if (quoted) {
            if (unicode) {
                if (!/[0-9a-f]/i.test(ch)) return null;
                unicode--;
                continue;
            }
            if (escaped) {
                if (ch === "u") unicode = 4;
                else if (!'"\\/bfnrt'.includes(ch)) return null;
                escaped = false;
                continue;
            }
            if (ch === "\\") escaped = true;
            else if (ch === '"') quoted = false;
            else if (ch.charCodeAt(0) < 32) return null;
        } else if (ch === '"') quoted = true;
        else if (ch === "{" || ch === "[") {
            stack.push(ch === "{" ? "}" : "]");
            if (stack.length > 128) return null;
        } else if (ch === "}" || ch === "]") {
            if (stack.pop() !== ch) return null;
        }
    }
    if (escaped || unicode || (!quoted && !stack.length)) return null;
    const candidate = source + (quoted ? '"' : "") + stack.reverse().join("");
    try {
        JSON.parse(candidate);
        return candidate;
    } catch {
        return null;
    }
}
function restore(raw, state) {
    if (Buffer.byteLength(raw) > MAX_BYTES)
        throw fail("anti_truncation_limit", "Build anti response exceeds size limit");
    let source = raw.trimStart(),
        repaired = false;
    const openingFence = /^```(?:json)?[ \t]*\r?\n/.exec(source);
    if (openingFence) {
        source = source.slice(openingFence[0].length);
        const closingFence = /\r?\n```[ \t\r\n]*$/.exec(source);
        if (closingFence) {
            const payload = source.slice(0, closingFence.index);
            try {
                JSON.parse(payload);
            } catch {
                throw fail("build_anti_incomplete_response", "Build anti closed JSON envelope is invalid");
            }
            source = payload;
        }
    }
    try {
        JSON.parse(source);
    } catch {
        const candidate = closeJSON(source);
        if (!candidate)
            throw fail("build_anti_incomplete_response", "Build anti returned incomplete JSON or an unfinished escape");
        source = candidate;
        repaired = true;
    }
    const message = Tools.parseToolReply(source, state.transport);
    const calls = message.tool_calls || [];
    const synthetic = calls.filter(c => c.function.name === state.name);
    if (synthetic.length) {
        if (synthetic.length !== 1 || calls.length !== 1 || (message.content !== null && message.content !== ""))
            throw fail("build_anti_mixed_response", "Build anti mixed its answer transport with other output");
        if (state.contract?.mode === "strict" && (state.contract.forced || state.contract.choice === "required"))
            throw fail(
                "invalid_tool_response",
                "Build anti cannot satisfy a required client tool with its answer transport"
            );
        const args = JSON.parse(synthetic[0].function.arguments);
        if (!state.transport.validators.get(state.name)(args))
            throw fail("build_anti_invalid_answer", "Build anti answer must contain only a string content field");
        const answer = Tools.validateReply({ content: args.content, role: "assistant" }, state.contract);
        return { message: answer, repaired };
    }
    if (repaired)
        throw fail("build_anti_incomplete_tool_call", "Build anti will not repair executable client tool calls");
    if (!calls.length)
        throw fail("build_anti_missing_transport", "Build anti final answer did not use its answer transport");
    const validated = Tools.validateReply(message, state.contract);
    if (state.contract?.legacy) {
        validated.function_call = validated.tool_calls[0].function;
        delete validated.tool_calls;
    }
    return { message: validated, repaired: false };
}
module.exports = { closeJSON, prepare, restore };
