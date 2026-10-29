// Protocol field positions adapted from Mag1cFall/AIStudio2API (MIT),
// bd6c40f, internal/aistudio/schema.go. See THIRD_PARTY_NOTICES.md.
const positions = {
    allOf: 18,
    anyOf: 17,
    description: 2,
    enum: 4,
    format: 1,
    items: 5,
    maximum: 11,
    maxItems: 20,
    maxLength: 13,
    maxProperties: 9,
    minimum: 10,
    minItems: 21,
    minLength: 12,
    minProperties: 8,
    not: 19,
    nullable: 3,
    oneOf: 16,
    pattern: 14,
    properties: 6,
    propertyOrdering: 22,
    required: 7,
    type: 0,
};
const types = { array: 5, boolean: 4, integer: 3, number: 2, object: 6, string: 1 };
const invalid = message => {
    throw Object.assign(new Error(message), { kind: "capability", retryable: false, status: 400 });
};
function encodeSchema(root) {
    const encode = (input, refs = [], depth = 0) => {
        if (depth > 64) invalid("Schema nesting exceeds limit");
        if (!input || typeof input !== "object" || Array.isArray(input)) invalid("Schema must be an object");
        let schema = { ...input };
        if (schema.$ref) {
            if (!schema.$ref.startsWith("#/") || refs.includes(schema.$ref))
                invalid("Unsupported recursive or external schema reference");
            let target = root;
            for (const key of schema.$ref
                .slice(2)
                .split("/")
                .map(k => k.replace(/~1/g, "/").replace(/~0/g, "~"))) {
                if (!target || !Object.hasOwn(target, key)) invalid("Unknown schema reference");
                target = target[key];
            }
            const ref = schema.$ref;
            delete schema.$ref;
            schema = { ...target, ...schema };
            refs = [...refs, ref];
            if (schema.$ref) return encode(schema, refs, depth + 1);
        }
        if (Array.isArray(schema.type)) {
            const nonnull = schema.type.filter(t => t !== "null");
            if (nonnull.length !== 1) invalid("Schema type unions require anyOf");
            schema.nullable = schema.type.includes("null") || schema.nullable;
            schema.type = nonnull[0];
        }
        if (Object.hasOwn(schema, "const")) {
            if (typeof schema.const !== "string") invalid("Playground supports string const only");
            schema.enum = [schema.const];
            schema.type ||= "string";
            delete schema.const;
        }
        if (!schema.type && schema.properties) schema.type = "object";
        if (!schema.type && schema.items) schema.type = "array";
        const out = [];
        for (const [key, value] of Object.entries(schema)) {
            if (["$defs", "definitions", "$schema", "$id", "title", "default", "examples"].includes(key)) continue;
            if (key === "additionalProperties" && value === false) continue;
            if (!Object.hasOwn(positions, key)) invalid(`Playground does not support schema.${key}`);
            if (value == null) continue;
            let encoded = value;
            if (key === "type") {
                encoded = types[String(value).toLowerCase()];
                if (!encoded) invalid("Unsupported schema type");
            } else if (["items", "not"].includes(key)) encoded = encode(value, refs, depth + 1);
            else if (key === "properties")
                encoded = Object.entries(value).map(([name, child]) => [name, encode(child, refs, depth + 1)]);
            else if (["oneOf", "anyOf", "allOf"].includes(key)) {
                if (!Array.isArray(value) || !value.length) invalid(`Invalid schema.${key}`);
                encoded = value.map(child => encode(child, refs, depth + 1));
            } else if (key === "enum" && !value.every(v => typeof v === "string"))
                invalid("Playground supports string enum only");
            out[positions[key]] = encoded;
        }
        return Array.from(out, v => (v === undefined ? null : v));
    };
    return encode(root);
}
module.exports = { encodeSchema };
