const FormatConverter = require("../FormatConverter");
const BASES = ["gemini-4-argon", "gemini-3.8-flash"];
const LEVELS = { HIGH: 3, LOW: 1, MEDIUM: 2 };
const failure = message => Object.assign(new Error(message), { kind: "capability", status: 400 });
function isBuild(name) {
    return /^(?:models\/)?(?:anti-)?build(?:-st)?\//i.test(name || "");
}
function parse(name) {
    const anti = FormatConverter.parseModelAntiPrefix(name);
    const tools = FormatConverter.parseModelBuiltInToolSuffixes(anti.cleanModelName);
    const stream = FormatConverter.parseModelStreamingModeSuffix(tools.cleanModelName);
    const thinking = FormatConverter.parseModelThinkingLevel(stream.cleanModelName);
    const match = /^(build|build-st)\/(.+)$/.exec(thinking.cleanModelName);
    if (!match || !BASES.includes(match[2]) || (thinking.thinkingLevel && !LEVELS[thinking.thinkingLevel]))
        throw failure("Build 模型或思考档位不支持");
    if (tools.forceCodeExecution || tools.forceWebSearch) throw failure("Build 不支持 Playground 内置工具后缀");
    return {
        anti: anti.antiTruncation,
        canonical: "build/" + match[2],
        channel: "build",
        contextMode: match[1] === "build-st" ? "sillytavern" : "attachment",
        requested: name,
        streamingMode: stream.streamingMode,
        thinking: LEVELS[thinking.thinkingLevel || "HIGH"],
        upstream: match[2],
    };
}
function models() {
    return ["build/", "build-st/"].flatMap(p =>
        BASES.flatMap(b => [p + b, ...Object.keys(LEVELS).map(l => p + b + "-" + l.toLowerCase())])
    );
}
module.exports = { BASES, isBuild, models, parse };
