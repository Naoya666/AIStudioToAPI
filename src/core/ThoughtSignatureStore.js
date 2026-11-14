// Process-local recovery for clients that omit Gemini's tool-call signature.
// Based on AIStudio2API/internal/api/thoughtsig.go (MIT; THIRD_PARTY_NOTICES.md).
const placeholders = new Set(["context_engineering_is_the_way_to_go", "skip_thought_signature_validator"]);
const genuine = value => typeof value === "string" && value.length > 0 && !placeholders.has(value);
const signatureFrom = value =>
    [value?.extra_content?.google?.thought_signature, value?.thoughtSignature, value?.thought_signature].find(genuine);
function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object")
        return Object.fromEntries(
            Object.keys(value)
                .sort()
                .map(key => [key, canonical(value[key])])
        );
    return value;
}
class ThoughtSignatureStore {
    constructor(capacity = 4096) {
        this.capacity = capacity;
        this.signatures = new Map();
    }
    key(id, name, args) {
        if (!id || !name) return null;
        try {
            const value = typeof args === "string" ? JSON.parse(args) : args;
            return JSON.stringify([id, name, canonical(value ?? {})]);
        } catch {
            return null;
        }
    }
    remember(id, name, args, signature) {
        const key = this.key(id, name, args);
        if (!key || !genuine(signature)) return;
        this.signatures.set(key, signature);
        while (this.signatures.size > this.capacity) this.signatures.delete(this.signatures.keys().next().value);
    }
    restore(id, name, args, signature) {
        if (genuine(signature)) return signature;
        return this.signatures.get(this.key(id, name, args)) || "skip_thought_signature_validator";
    }
}
module.exports = { genuine, signatureFrom, ThoughtSignatureStore };
