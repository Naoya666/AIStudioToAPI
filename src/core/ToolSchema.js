// Playground tool projection follows AIStudio2API/internal/aistudio/tools.go
// and schema.go (MIT; see THIRD_PARTY_NOTICES.md).
const { encodeSchema } = require("./PlaygroundSchema");
const fail = message => {
    throw Object.assign(new Error(message), { kind: "capability", retryable: false, status: 400 });
};
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const constraints = [
    "type",
    "format",
    "nullable",
    "description",
    "required",
    "minimum",
    "maximum",
    "minLength",
    "maxLength",
    "pattern",
    "minItems",
    "maxItems",
    "minProperties",
    "maxProperties",
    "propertyOrdering",
];
function encodeToolSchema(input, description = "", strict = false) {
    const root = input ?? { properties: {}, type: "object" };
    if (!object(root) && typeof root !== "boolean") fail("Tool parameters must be a JSON Schema object or boolean");
    let lossy = strict;
    let budget = 1024;
    function shape(node, refs = [], depth = 0) {
        if (depth > 64 || --budget < 0) {
            lossy = true;
            return {};
        }
        if (typeof node === "boolean") {
            lossy = true;
            return shape({}, refs, depth + 1);
        }
        if (!object(node)) fail("Tool schema must be an object or boolean");
        if (Object.hasOwn(node, "$ref")) {
            lossy = true;
            const ref = node.$ref;
            let target = root;
            if (typeof ref === "string" && ref.startsWith("#/") && !refs.includes(ref)) {
                for (const key of ref
                    .slice(2)
                    .split("/")
                    .map(k => k.replace(/~1/g, "/").replace(/~0/g, "~"))) {
                    target = object(target) && Object.hasOwn(target, key) ? target[key] : undefined;
                }
            } else target = undefined;
            const { $ref: ignored, ...siblings } = node;
            void ignored;
            return shape({ ...(object(target) ? target : {}), ...siblings }, [...refs, ref], depth + 1);
        }
        const result = {};
        for (const [key, value] of Object.entries(node)) {
            if (constraints.includes(key)) result[key] = value;
            else if (!["properties", "items", "anyOf", "oneOf", "allOf", "enum", "const"].includes(key)) lossy = true;
        }
        if (Array.isArray(result.type)) {
            lossy = true;
            const types = result.type.map(t => String(t).toLowerCase());
            const nonnull = [...new Set(types.filter(t => t !== "null"))];
            if (types.includes("null")) result.nullable = true;
            if (nonnull.length > 1) {
                delete result.type;
                result.anyOf = nonnull.map(type => ({ type }));
            } else result.type = nonnull[0] || "string";
            if (!nonnull.length) lossy = true;
        } else if (typeof result.type === "string" && result.type.toLowerCase() === "null") {
            result.type = "string";
            result.nullable = true;
            lossy = true;
        }
        if (Object.hasOwn(node, "const")) {
            lossy = true;
            const value = node.const;
            if (typeof value === "string") {
                result.type ||= "string";
                if (value) result.enum = [value];
            } else if (typeof value === "number") {
                result.type ||= Number.isInteger(value) ? "integer" : "number";
                result.minimum = result.maximum = value;
            } else if (typeof value === "boolean") result.type ||= "boolean";
            else if (value === null) {
                result.type ||= "string";
                result.nullable = true;
            } else result.type ||= Array.isArray(value) ? "array" : "object";
        }
        if (Object.hasOwn(node, "enum")) {
            if (!Array.isArray(node.enum)) fail("Invalid schema.enum");
            if (node.enum.length && node.enum.every(v => typeof v === "string" && v.length)) result.enum = node.enum;
            else lossy = true;
        }
        if (Object.hasOwn(node, "properties")) {
            if (!object(node.properties)) fail("Invalid schema.properties");
            result.properties = Object.fromEntries(
                Object.entries(node.properties).map(([name, child]) => [name, shape(child, refs, depth + 1)])
            );
        }
        if (Object.hasOwn(node, "required")) {
            if (!Array.isArray(node.required) || !node.required.every(name => typeof name === "string"))
                fail("Invalid schema.required");
            result.properties ||= {};
            for (const name of node.required)
                if (!Object.hasOwn(result.properties, name)) {
                    Object.defineProperty(result.properties, name, {
                        configurable: true,
                        enumerable: true,
                        value: shape({}, refs, depth + 1),
                        writable: true,
                    });
                    lossy = true;
                }
        }
        if (Object.hasOwn(node, "items")) {
            result.items = shape(node.items, refs, depth + 1);
        }
        for (const key of ["anyOf", "oneOf", "allOf"]) {
            if (!Object.hasOwn(node, key)) continue;
            lossy = true;
            if (!Array.isArray(node[key]) || !node[key].length) fail(`Invalid schema.${key}`);
            const nonnull = node[key].filter(child => !object(child) || String(child.type).toLowerCase() !== "null");
            if (nonnull.length !== node[key].length) {
                result.nullable = true;
                lossy = true;
            }
            if (nonnull.length) result[key] = nonnull.map(child => shape(child, refs, depth + 1));
        }
        if (String(result.type).toLowerCase() === "array" && !result.items) {
            lossy = true;
            result.items = shape({}, refs, depth + 1);
        }
        if (!result.type && !result.properties && !result.items && !result.anyOf && !result.oneOf && !result.allOf) {
            lossy = true;
            const scalars = () => ["string", "number", "boolean"].map(type => ({ type }));
            result.nullable = true;
            result.anyOf = [...scalars(), { items: { anyOf: scalars(), nullable: true }, type: "array" }];
        }
        return result;
    }
    const projected = shape(
        root === true || (object(root) && !Object.keys(root).length) ? { properties: {}, type: "object" } : root
    );
    const wire = encodeSchema(projected);
    function carrier(node) {
        for (const index of [5, 19]) if (node[index]) carrier(node[index]);
        for (const [, child] of node[6] || []) carrier(child);
        for (const index of [16, 17, 18]) {
            for (const child of node[index] || []) carrier(child);
            if (!node[0] && node[index]?.length) {
                node[0] = node[index][0][0];
                if (node[0] === 5) node[5] = node[index][0][5];
            }
        }
        node[0] ||= 1;
    }
    carrier(wire);
    return {
        description: lossy
            ? `${description}\nArguments must follow this JSON Schema: ${JSON.stringify(root)}`
            : description,
        parameters: wire,
    };
}
module.exports = { encodeToolSchema };
