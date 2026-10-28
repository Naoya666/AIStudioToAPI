const { createHash } = require("node:crypto");
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
function parsePolicy(value = {}) {
    if (typeof value === "string") {
        try {
            value = JSON.parse(value);
        } catch {
            throw new Error("Invalid MODEL_TRANSPORT_POLICY JSON");
        }
    }
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Invalid MODEL_TRANSPORT_POLICY mapping");
    const entries = Object.entries(value);
    for (const [model, transport] of entries) {
        if (
            !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(model) ||
            ["__proto__", "prototype", "constructor"].includes(model) ||
            cleanModel(model) !== model ||
            !["legacy", "makersuite"].includes(transport)
        )
            throw new Error("Invalid MODEL_TRANSPORT_POLICY entry");
    }
    return Object.freeze(Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b))));
}
function resolve(model, mode = "fake", overrides = {}) {
    model = cleanModel(model);
    const rules = parsePolicy(overrides);
    const transport = Object.hasOwn(rules, model) ? rules[model] : "makersuite";
    return Object.freeze({
        effectiveMode: transport === "makersuite" && mode === "real" ? "fake" : mode,
        incremental: transport === "legacy",
        model,
        requestedMode: mode,
        timeoutCategory: transport === "makersuite" || mode !== "real" ? "buffered" : "incremental",
        transport,
        version: createHash("sha256").update(JSON.stringify(rules)).digest("hex").slice(0, 12),
    });
}
module.exports = { cleanModel, parsePolicy, resolve };
