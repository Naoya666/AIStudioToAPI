const FIELDS = ["prompt_tokens", "completion_tokens", "cached_tokens", "reasoning_tokens", "total_tokens"];
const count = value => Number.isSafeInteger(value) && value >= 0;
function normalize(value, gemini = false) {
    if (!value) return null;
    const values = gemini
        ? {
              cached_tokens: value.cachedContentTokenCount,
              completion_tokens: count(value.candidatesTokenCount)
                  ? value.candidatesTokenCount + (count(value.thoughtsTokenCount) ? value.thoughtsTokenCount : 0)
                  : undefined,
              prompt_tokens: count(value.promptTokenCount)
                  ? value.promptTokenCount + (count(value.toolUsePromptTokenCount) ? value.toolUsePromptTokenCount : 0)
                  : undefined,
              reasoning_tokens: value.thoughtsTokenCount,
              total_tokens: value.totalTokenCount,
          }
        : {
              ...value,
              cached_tokens: value.cached_tokens ?? value.prompt_tokens_details?.cached_tokens,
              reasoning_tokens: value.reasoning_tokens ?? value.completion_tokens_details?.reasoning_tokens,
          };
    const result = Object.fromEntries(FIELDS.filter(k => count(values[k])).map(k => [k, values[k]]));
    return Object.keys(result).length ? result : null;
}
function combine(values) {
    const rows = values.filter(Boolean);
    if (!rows.length) return null;
    const result = {};
    for (const key of FIELDS) {
        const parts = rows.map(r => r[key]).filter(count);
        if (parts.length) result[key] = parts.reduce((a, b) => a + b, 0);
    }
    result.partial = rows.some(r => !count(r.total_tokens));
    return result;
}
module.exports = { combine, count, FIELDS, normalize };
