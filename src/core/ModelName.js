const FormatConverter = require("./FormatConverter");
const MAX_MODEL_NAME_LENGTH = 200;
const schedulerError = (message, status = 400) => Object.assign(new Error(message), { status });

const normalizedModels = new Map();
function normalizeModelName(model) {
    if (typeof model !== "string") throw schedulerError("Model must be a non-empty string", 400);
    if (normalizedModels.has(model)) return normalizedModels.get(model);
    let normalized = FormatConverter.parseModelAntiPrefix(model).cleanModelName;
    normalized = FormatConverter.parseModelBuiltInToolSuffixes(normalized).cleanModelName;
    normalized = FormatConverter.parseModelStreamingModeSuffix(normalized).cleanModelName;
    normalized = FormatConverter.parseModelThinkingLevel(normalized).cleanModelName;
    if (!normalized || normalized.length > MAX_MODEL_NAME_LENGTH)
        throw schedulerError(`Model must contain 1-${MAX_MODEL_NAME_LENGTH} characters`, 400);
    if (normalized.startsWith("__") || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(normalized))
        throw schedulerError("Invalid model name", 400);
    if (normalizedModels.size >= 1024) normalizedModels.delete(normalizedModels.keys().next().value);
    normalizedModels.set(model, normalized);
    return normalized;
}

module.exports = { normalizeModelName };
