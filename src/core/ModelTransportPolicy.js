const FormatConverter = require("./FormatConverter");

function cleanModel(model) {
    const tools = FormatConverter.parseModelBuiltInToolSuffixes(
        String(model)
            .replace(/^models\//, "")
            .replace(/^anti-/i, "")
    ).cleanModelName;
    const stream = FormatConverter.parseModelStreamingModeSuffix(tools).cleanModelName;
    return FormatConverter.parseModelThinkingLevel(stream).cleanModelName;
}
// All modes use the same direct Playground transport. Only real exposes
// incremental output; fake/early retain their existing presentation behavior.
function resolve(model, mode = "real") {
    return Object.freeze({
        effectiveMode: ["real", "fake", "early"].includes(mode) ? mode : "real",
        incremental: mode === "real",
        model: cleanModel(model),
        requestedMode: mode,
        timeoutCategory: mode === "real" ? "incremental" : "buffered",
        transport: "makersuite",
        version: "playground-stream-modes-v2",
    });
}
module.exports = { cleanModel, resolve };
