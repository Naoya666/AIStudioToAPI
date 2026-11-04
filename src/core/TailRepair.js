// Generation-only compatibility repair. Existing protocol validation remains authoritative.
const TAIL_REPAIR_TEXT = "请根据以上对话和指令继续回应；若最后一条是助手未完成的内容，请接续完成，避免重复已有内容。";

function repairGoogleTail(body, enabled) {
    if (enabled !== true || !Array.isArray(body?.contents) || body.contents.length === 0)
        return { body, repaired: false };

    // Leave malformed histories untouched for the existing protocol validator.
    if (
        !body.contents.every(
            content =>
                content &&
                Array.isArray(content.parts) &&
                content.parts.length > 0 &&
                ["user", "model"].includes(content.role ?? "user")
        )
    )
        return { body, repaired: false };
    if ((body.contents.at(-1).role ?? "user") !== "model") return { body, repaired: false };

    return {
        body: {
            ...body,
            contents: [...body.contents, { parts: [{ text: TAIL_REPAIR_TEXT }], role: "user" }],
        },
        repaired: true,
    };
}

module.exports = { repairGoogleTail, TAIL_REPAIR_TEXT };
