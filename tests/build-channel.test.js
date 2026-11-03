const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const Identity = require("../src/core/codeAssistant/ModelIdentity");
const { normalizeModelName } = require("../src/core/ModelName");
const Anti = require("../src/core/AntiTruncation");
const Tools = require("../src/core/codeAssistant/ToolContract");
const { WIRE_PREFIX, parseSillyTavern, sillyTavernMessages } = require("../src/core/codeAssistant/SillyTavern");
const { prepare, process: processBuild } = require("../src/core/codeAssistant/BuildRequestHandler");
const { parsePreset, segment, PresetStore } = require("../src/core/codeAssistant/Presets");
const { encode, decode } = require("../src/core/codeAssistant/BuildCodec");
const { BuildRuntime } = require("../src/core/codeAssistant/BuildRuntime");
const { ModelScheduler } = require("../src/core/ModelScheduler");
const loadConfig = require("../src/core/SchedulerConfig");
const { ConfigurationService } = require("../src/config/ConfigurationService");
const { getModelDailyQuota } = require("../src/core/ModelScheduler");
const config = {
    antiTruncationDefault: "off",
    antiTruncationEnabled: true,
    buildEnabled: true,
    buildToolCallingMode: "auto_fallback",
};
const base = { messages: [{ content: "hello", role: "user" }], model: "build/gemini-3.8-flash" };
const tools = [
    {
        function: {
            name: "lookup",
            parameters: {
                additionalProperties: false,
                properties: { q: { type: "string" } },
                required: ["q"],
                type: "object",
            },
        },
        type: "function",
    },
];
const reply = (calls, content = null) => JSON.stringify({ content, tool_calls: calls });
const call = { arguments: { q: "hello" }, name: "lookup" };
function wire(text, { status = 1, usage = ["10", "3", "2"], task = "task", role = "model" } = {}) {
    const turn = Array(17).fill(null);
    turn[0] = [[[[null, text]], role]];
    turn[11] = 1;
    turn[12] = status;
    turn[13] = "models/gemini-3.8-flash";
    turn[15] = usage;
    turn[16] = task;
    return JSON.stringify([[[null, null, [turn], "app"]]]);
}
function temp(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "build-dual-"));
    t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
    return dir;
}
function runtime(t) {
    const r = new BuildRuntime({
        accountKey: "fixture-account",
        page: {},
        statePath: path.join(temp(t), "projects.json"),
        timeoutMs: 2000,
    });
    const calls = [];
    r.rpc = async (method, body) => {
        calls.push({ body, method });
        if (method === "CreateApplet") return JSON.stringify(["00000000-0000-4000-8000-000000000001"]);
        if (method === "CodeAssistantOffline") return '["task"]';
        if (method === "StreamCodeAssistantOfflineGeneration") return wire("hello");
        return "[]";
    };
    return { calls, r };
}

test("model identity keeps requested aliases and separates channels while ST shares quota", () => {
    for (const prefix of ["build/", "build-st/"])
        for (const level of ["", "-low", "(medium)", "-high"])
            for (const stream of ["", "-real", "-early", "-fake"]) {
                const name = `anti-${prefix}gemini-3.8-flash${level}${stream}`;
                const id = Identity.parse(name);
                assert.equal(id.requested, name);
                assert.equal(id.canonical, "build/gemini-3.8-flash");
                assert.equal(id.upstream, "gemini-3.8-flash");
                assert.equal(id.anti, true);
                assert.equal(normalizeModelName(name), id.canonical);
            }
    assert.notEqual(normalizeModelName("gemini-3.8-flash-high-real"), "build/gemini-3.8-flash");
    for (const name of [
        "build/gemini-2.5-flash",
        "build/gemini-3.8-flash-minimal",
        "build/anti-gemini-3.8-flash",
        "build/gemini-3.8-flash-real-high",
    ])
        assert.throws(() => Identity.parse(name));
    assert.equal(getModelDailyQuota("build/gemini-3.8-flash"), null);
});
test("Build anti follows explicit/default precedence and the existing master switch across modes", () => {
    for (const prefix of ["build/", "build-st/"])
        for (const mode of ["strict", "auto_fallback"]) {
            const body = { ...base, model: prefix + "gemini-3.8-flash-high-real" };
            assert.equal(
                Anti.resolve(body, { ...config, antiTruncationDefault: "prefer", buildToolCallingMode: mode }).enabled,
                true
            );
            for (const choice of ["none", "required", { function: { name: "lookup" }, type: "function" }])
                assert.equal(
                    Anti.resolve({ ...body, anti_truncation: true, tool_choice: choice, tools }, config).enabled,
                    true
                );
            assert.equal(
                Anti.resolve({ ...body, anti_truncation: false, model: "anti-" + body.model }, config).enabled,
                false
            );
            assert.throws(
                () => Anti.resolve({ ...body, anti_truncation: true }, { ...config, antiTruncationEnabled: false }),
                { code: "anti_truncation_disabled" }
            );
        }
    assert.equal(Anti.resolve({ messages: base.messages, model: "anti-gemini-3.8-flash" }, config).enabled, true);
});
test("full attachment preserves every ordered message, trailing instructions, names and continuation", () => {
    const messages = [
        { content: "first", role: "system" },
        {
            content: [
                { text: "one", type: "text" },
                { text: "two", type: "text" },
            ],
            name: "Alice",
            role: "user",
        },
        { content: "middle", role: "developer" },
        { content: "partial", role: "assistant" },
        { content: "tail", role: "system" },
    ];
    const p = prepare({ ...base, messages }, config, {});
    assert.deepEqual(JSON.parse(p.context.files[0].text).messages, messages);
    assert.match(p.context.prompt, /continue that assistant/);
    assert.equal(p.contract, null);
    assert.doesNotMatch(p.context.prompt, /External client tool protocol/);
    assert.throws(() =>
        prepare(
            { ...base, messages: [{ content: [{ image_url: { url: "x" }, type: "image_url" }], role: "user" }] },
            config,
            {}
        )
    );
    assert.throws(() => prepare(base, { ...config, buildEnabled: false }, {}), { status: 403 });
    assert.throws(
        () => prepare({ ...base, messages: [{ content: "a".repeat(9 * 1024 * 1024), role: "user" }] }, config, {}),
        { status: 413 }
    );
});
const history = [
    {
        content: null,
        role: "assistant",
        tool_calls: [{ function: { arguments: '{"q":"x"}', name: "lookup" }, id: "c1", type: "function" }],
    },
    { content: "result", role: "tool", tool_call_id: "c1" },
    { content: "continue", role: "user" },
];
function envelope(version = 2, generationType = "normal") {
    const messages = [{ content: "preset", name: "preset", role: "system" }, ...history];
    return {
        generationType,
        inlineTokens: 10,
        segments: messages.map((m, message) => ({
            message,
            part: 0,
            role: m.role,
            ...(m.name ? { name: m.name } : {}),
            placement: message === 0 ? "inline" : "file",
            source: message === 0 ? "main" : "history",
            text: m.content ?? "",
        })),
        version,
        ...(version === 2
            ? {
                  messageMetadata: [
                      { contentNull: true, message: 1, tool_calls: history[0].tool_calls },
                      { message: 2, tool_call_id: "c1" },
                  ],
              }
            : {}),
    };
}
function wrapped(value) {
    return [{ content: WIRE_PREFIX + JSON.stringify(value), role: "user" }];
}
for (const generationType of ["normal", "regenerate", "swipe", "continue", "quiet", "impersonate"])
    test(`ST v1/v2 ${generationType} preserves placements and protocol semantics`, () => {
        for (const version of [1, 2]) {
            const value = envelope(version, generationType),
                ctx = parseSillyTavern(wrapped(value));
            assert.equal(ctx.generationType, generationType);
            assert.deepEqual(ctx.segments, value.segments);
            if (version === 2) {
                assert.deepEqual(sillyTavernMessages(ctx).slice(1), history);
                const p = prepare(
                    { ...base, messages: wrapped(value), model: "build-st/gemini-3.8-flash", tools },
                    config,
                    {}
                );
                assert.equal(JSON.parse(p.context.files[0].text).messageMetadata[0].tool_calls[0].id, "c1");
                assert.ok(p.context.prompt.includes("preset"));
                assert.ok(!p.context.files[0].text.includes('"text": "preset"'));
            }
        }
    });
test("ST rejects missing/broken/failure/version/budget envelopes without fallback", () => {
    assert.throws(() => prepare({ ...base, model: "build-st/gemini-3.8-flash" }, config, {}), /build\//);
    for (const value of [
        { ...envelope(), version: 3 },
        { ...envelope(), error: "failed" },
        { ...envelope(), inlineTokens: 45001 },
        { ...envelope(), segments: [{ ...envelope().segments[0], message: 2 }] },
    ])
        assert.throws(() => parseSillyTavern(wrapped(value)));
    assert.throws(() => parseSillyTavern([{ content: WIRE_PREFIX + "{", role: "user" }]), /损坏/);
    const value = envelope();
    value.segments[0].text = "p".repeat(180001);
    assert.throws(
        () => prepare({ ...base, messages: wrapped(value), model: "build-st/gemini-3.8-flash", tools }, config, {}),
        { status: 413 }
    );
});
for (const mode of ["auto_fallback", "strict"])
    test(`shared ${mode} tool validator covers prose, contract, schema, malformed protocols, none and parallel`, () => {
        const context = choice =>
            Tools.prepareTools({ ...base, parallel_tool_calls: false, tool_choice: choice, tools }, { mode });
        assert.equal(Tools.parseToolReply("plain", context("auto")).content, "plain");
        assert.equal(Tools.parseToolReply(reply([call]), context("auto")).tool_calls.length, 1);
        if (mode === "strict") {
            assert.throws(() => Tools.parseToolReply(reply([{ arguments: {}, name: "other" }]), context("auto")), {
                code: "invalid_tool_response",
            });
            assert.throws(() => Tools.parseToolReply('{"tool_calls":[', context("auto")), {
                code: "invalid_tool_response",
            });
            assert.throws(() =>
                Tools.parseToolReply(reply([{ arguments: "broken", name: "lookup" }]), context("auto"))
            );
            assert.throws(() => Tools.parseToolReply(reply([call]), context("none")));
        } else {
            for (const raw of [
                reply([{ arguments: {}, name: "other" }]),
                '{"tool_calls":[',
                reply([{ arguments: "broken", name: "lookup" }]),
            ]) {
                const message = Tools.parseToolReply(raw, context("auto"));
                assert.equal(message.content, raw);
                assert.equal(message.tool_calls, undefined);
            }
            assert.equal(Tools.parseToolReply(reply([call]), context("none")).content, reply([call]));
        }
        const badSchema = reply([{ arguments: { q: 123 }, name: "lookup" }]);
        const forced = { function: { name: "lookup" }, type: "function" };
        if (mode === "strict") {
            assert.throws(() => Tools.parseToolReply(badSchema, context("auto")));
            assert.throws(() => Tools.parseToolReply("plain", context("required")));
            assert.throws(() => Tools.parseToolReply("plain", context(forced)));
            assert.throws(() => Tools.parseToolReply(reply([call, call]), context("auto")));
        } else {
            assert.equal(Tools.parseToolReply(badSchema, context("auto")).tool_calls.length, 1);
            for (const choice of ["required", forced])
                assert.equal(Tools.parseToolReply("plain", context(choice)).content, "plain");
            assert.equal(Tools.parseToolReply(reply([call, call]), context("auto")).tool_calls.length, 2);
            assert.match(Tools.toolInstructions(context(forced)), /Prioritize answering the user in text/);
        }
        assert.equal(
            Tools.prepareTools({ ...base, messages: history, tools }, { mode }).messages[1].tool_call_id,
            "c1"
        );
        if (mode === "strict")
            assert.throws(() => Tools.prepareTools({ ...base, messages: history.slice(1), tools }, { mode }));
        else
            assert.equal(
                Tools.prepareTools({ ...base, messages: history.slice(1), tools }, { mode }).messages[0].content,
                "result"
            );
    });
test("legacy function histories normalize and replies retain legacy output shape", () => {
    const legacy = {
        ...base,
        function_call: "auto",
        functions: [tools[0].function],
        messages: [
            { content: null, function_call: { arguments: '{"q":"x"}', name: "lookup" }, role: "assistant" },
            { content: "x", name: "lookup", role: "function" },
            { content: "next", role: "user" },
        ],
    };
    const c = Tools.prepareTools(legacy);
    assert.equal(c.messages[1].tool_call_id, c.messages[0].tool_calls[0].id);
    assert.equal(Tools.parseToolReply(reply([call]), c).function_call.name, "lookup");
    assert.throws(() => Tools.prepareTools({ ...legacy, tools }));
});
test("optional presets match expanded macros, preserve tool metadata and exact text, reject budget overflow", t => {
    const preset = {
        prompts: [{ content: "You play {{char}}. Keep the character identity intact.", identifier: "main" }],
    };
    const parsed = parsePreset(preset),
        messages = [
            { content: "You play Alice. Keep the character identity intact.\r\n  ", role: "system" },
            ...history,
        ];
    const split = segment(messages, parsed);
    assert.ok(split.hits);
    assert.equal(split.messageMetadata[0].tool_calls[0].id, "c1");
    assert.equal(
        split.segments
            .filter(s => s.message === 0)
            .map(s => s.text)
            .join(""),
        messages[0].content
    );
    assert.equal(segment(base.messages, parsed), null);
    const store = new PresetStore(path.join(temp(t), "presets.json"));
    const added = store.add("own", preset);
    assert.ok(store.apply(messages));
    store.setEnabled(added.id, false);
    assert.equal(store.apply(messages), null);
    assert.equal(prepare({ ...base, messages }, config, { buildPresets: store }).context.mode, "chat_attachment");
    store.setEnabled(added.id, true);
    assert.equal(
        prepare({ ...base, messages }, { ...config, buildPresetMatching: true }, { buildPresets: store }).context.mode,
        "sillytavern_split"
    );
    const large = "x".repeat(180001);
    assert.throws(() => segment([{ content: large, role: "system" }], parsePreset({ prompts: [{ content: large }] })), {
        status: 413,
    });
});
test("RPC codec isolates project/task identity, completion and unknown usage", () => {
    const prepared = prepare(base, config, {}),
        request = encode(prepared.identity, prepared.context, "project");
    assert.equal(request.body[11], "project");
    assert.equal(request.body[22], true);
    assert.deepEqual(request.body[13], [2, null, 2]);
    assert.equal(request.body[1], null);
    assert.equal(request.body[18][3], 3);
    const attachment = request.body[0][0][0][0][2];
    assert.deepEqual(JSON.parse(Buffer.from(attachment[1], "base64").toString()).messages, base.messages);
    assert.equal(decode(wire("hello", { status: 2 }), "task").complete, false);
    assert.equal(decode(wire("hello", { usage: null }), "task").usage, null);
    assert.equal(decode(wire("hello", { usage: null }), "task").complete, true);
    assert.equal(decode(wire("hello"), "other").empty, true);
    assert.equal(decode(wire("hello"), "task").usage.total_tokens, 15);
    assert.throws(() => decode(wire("x", { status: 4 }), "task"));
    assert.throws(() => decode("[[", "task"), /中断/);
});
for (const tier of ["free", "pro"])
    test(`${tier} production failure without content ends polling and deletes the terminal task project`, async t => {
        const fixture = require(`./fixtures/build-${tier}-failed-task.json`);
        const raw = JSON.stringify(fixture.response);
        assert.throws(() => decode(raw, fixture.task), {
            code: "BUILD_TASK_FAILED",
            taskTerminal: true,
        });
        assert.equal(decode(raw, "other-task").empty, true);
        const { r, calls } = runtime(t),
            original = r.rpc;
        r.rpc = async (method, body) => {
            if (method === "CodeAssistantOffline") {
                calls.push({ body, method });
                return JSON.stringify([fixture.task]);
            }
            if (method === "StreamCodeAssistantOfflineGeneration") {
                calls.push({ body, method });
                return raw;
            }
            if (method === "CancelCodeAssistantOfflineGeneration") assert.fail("terminal task must not be cancelled");
            return original(method, body);
        };
        const p = prepare(base, config, {});
        await assert.rejects(r.generate(p.identity, p.context, {}), /Invalid argument/);
        assert.equal(calls.filter(c => c.method === "StreamCodeAssistantOfflineGeneration").length, 1);
        assert.equal(calls.filter(c => c.method === "DeleteApplet").length, 1);
        assert.deepEqual(r.read(), {});
        assert.equal(r.active.size, 0);
    });
test("task read recovery resumes the same generation without submitting a second task", async t => {
    const { r, calls } = runtime(t),
        original = r.rpc;
    let reads = 0;
    r.rpc = async (m, b) => {
        if (m === "StreamCodeAssistantOfflineGeneration" && ++reads === 1)
            throw Object.assign(new Error("read interrupted"), { source: "transport", status: 502 });
        return original(m, b);
    };
    const p = prepare(base, config, {});
    const out = await r.generate(p.identity, p.context, {});
    assert.equal(out.text, "hello");
    assert.equal(calls.filter(c => c.method === "CodeAssistantOffline").length, 1);
    assert.deepEqual(r.read(), {});
    assert.equal(r.active.size, 0);
});
test("cancelled tasks await cleanup and failed cleanup journal prevents another generation", async t => {
    const { r, calls } = runtime(t),
        original = r.rpc;
    const controller = new AbortController();
    r.rpc = async (m, b) => {
        if (m === "StreamCodeAssistantOfflineGeneration") {
            controller.abort();
            return wire("partial", { status: 2 });
        }
        if (m === "CancelCodeAssistantOfflineGeneration") throw new Error("cancel unconfirmed");
        return original(m, b);
    };
    const p = prepare(base, config, {});
    await assert.rejects(r.generate(p.identity, p.context, { signal: controller.signal }), { status: 499 });
    assert.equal(r.cleanupPending, true);
    assert.equal(Object.values(r.read())[0].task, "task");
    await assert.rejects(r.generate(p.identity, p.context, {}), /unconfirmed/);
    assert.equal(calls.filter(c => c.method === "CodeAssistantOffline").length, 1);
    r.rpc = original;
    await r.recover();
    assert.deepEqual(r.read(), {});
});
test("atomic channel admission permits PG10 + Build1, shares prefixes/models, and releases on abort", async t => {
    const cfg = {
        ...loadConfig({
            BUILD_MAX_CONCURRENCY: "1",
            CONTEXT_MAX_CONCURRENCY: "11",
            GLOBAL_MAX_CONCURRENCY: "11",
            MAX_BROWSER_WORKERS: "1",
            PG_MAX_CONCURRENCY: "10",
        }),
        statePath: null,
    };
    const auth = {
        accountLoginService: { state: { accounts: [{ authIndex: 0, manualTier: "pro" }] } },
        accountNameMap: new Map(),
        getRotationIndices: () => [0],
    };
    const scheduler = new ModelScheduler(cfg, auth, { error() {}, warn() {} });
    scheduler.browserManager = { isContextReady: () => true };
    t.after(() => scheduler.close());
    const pg = await Promise.all(Array.from({ length: 10 }, () => scheduler.acquire("gemini-3.8-flash")));
    const build = await scheduler.acquire("build-st/gemini-3.8-flash-high");
    assert.equal(build.model, "build/gemini-3.8-flash");
    assert.equal(scheduler.channelInflight(build.account, "pg"), 10);
    assert.equal(scheduler.channelInflight(build.account, "build"), 1);
    const ctrl = new AbortController();
    const blocked = scheduler.acquire("build/gemini-4-argon", new Set(), ctrl.signal);
    assert.equal(scheduler.pending.length, 1);
    ctrl.abort();
    await assert.rejects(blocked, { status: 499 });
    scheduler.release(build, true);
    assert.equal(scheduler.channelInflight(build.account, "build"), 0);
    build.account.buildRecoveryBlocked = true;
    assert.equal(scheduler.canLease(build.account, "build/gemini-3.8-flash"), false);
    scheduler.release(pg.pop());
    assert.equal(scheduler.canLease(build.account, "gemini-3.8-flash"), true);
    pg.forEach(l => scheduler.release(l));
    assert.equal(build.account.inflight, 0);
});
test("new managed configuration persists settings without changing old defaults", t => {
    const logger = { error() {}, info() {}, warn() {} };
    const file = path.join(temp(t), "managed.json");
    const service = new ConfigurationService({ logger }, { env: {}, file });
    assert.equal(service.running.buildEnabled, false);
    assert.equal(service.running.scheduler.pgConcurrency, 0);
    service.save({
        changes: {
            BUILD_ENABLED: true,
            BUILD_MAX_CONCURRENCY: 1,
            BUILD_TOOL_CALLING_MODE: "strict",
            PG_MAX_CONCURRENCY: 10,
            PG_TOOL_CALLING_MODE: "strict",
        },
        version: service.document.version,
    });
    const loaded = new ConfigurationService({ logger }, { env: {}, file });
    assert.equal(loaded.running.buildToolCallingMode, "strict");
    assert.equal(loaded.running.scheduler.pgConcurrency, 10);
    assert.ok(loaded.running.scheduler.registeredModels.includes("build/gemini-3.8-flash"));
    assert.equal(
        loaded.running.scheduler.registeredModels.some(x => x.startsWith("build-st/")),
        false
    );
});
function handlerFixture(t, { output = "answer", mode = "auto_fallback", generationError } = {}) {
    const account = { index: 0, key: "fixture-account" };
    const lease = { account };
    const releases = [],
        failures = [],
        finished = [],
        requests = [];
    const r = {
        active: new Map(),
        generate: async (id, ctx, options) => {
            requests.push({ ctx, id, options });
            if (generationError) throw generationError;
            const text = typeof output === "function" ? output(ctx) : output;
            if (options.onText) {
                options.onText(text.slice(0, 2));
                options.onText(text.slice(2));
            }
            return { text, usage: { completion_tokens: 2, prompt_tokens: 10, total_tokens: 12 } };
        },
        readyProjects: 0,
    };
    const scheduler = {
        acquire: async () => lease,
        assertModelAccessible() {},
        failure: async (l, e) => failures.push(e),
        release: (l, success) => releases.push(success),
        startAttempt() {},
    };
    const h = {
        _finalizeTrackedRequest: (id, res, result) => finished.push(result),
        _getAccountNameForIndex: () => null,
        _getUsageStatsService: () => ({ recordAttempt() {} }),
        _markTrackedResponseError: require("../src/core/RequestHandler").prototype._markTrackedResponseError,
        _setResponseApiFormat() {},
        _startTrackedRequest() {},
        _updateTrackedRequest() {},
        authSwitcher: { currentAuthIndex: -1 },
        browserManager: {
            contexts: new Map([[0, { page: { codeAssistantRuntime: r, playgroundTransport: { ready: true } } }]]),
            notifyUserActivity() {},
        },
        config: { ...config, buildToolCallingMode: mode },
        controller: new AbortController(),
        serverSystem: { scheduler },
    };
    const res = new EventEmitter();
    res.headersSent = false;
    res.statusCode = 200;
    res.destroyed = false;
    res.output = "";
    res.setHeader = () => {};
    res.status = n => {
        res.statusCode = n;
        return res;
    };
    res.set = () => res;
    res.flushHeaders = () => {
        res.headersSent = true;
    };
    res.write = text => {
        res.output += text;
    };
    res.json = data => {
        res.body = data;
        res.writableFinished = true;
    };
    res.end = text => {
        res.output += text || "";
        res.writableFinished = true;
    };
    return { failures, finished, h, releases, requests, res };
}
for (const stream of [false, true])
    for (const mode of ["auto_fallback", "strict"])
        test(`OpenAI Build ${stream ? "stream" : "nonstream"} ${mode} validates before publishing executable calls`, async t => {
            const f = handlerFixture(t, { mode, output: reply([call]) });
            const body = {
                ...base,
                model: "build/gemini-3.8-flash-low-fake",
                stream,
                stream_options: { include_usage: true },
                tool_choice: "required",
                tools,
            };
            await processBuild(f.h, { body, method: "POST", path: "/v1/chat/completions" }, f.res);
            assert.deepEqual(f.releases, [true]);
            assert.equal(f.requests[0].options.onText, null);
            assert.equal(f.finished[0].usage.total_tokens, 12);
            if (stream) {
                assert.ok(f.res.output.includes("tool_calls"));
                assert.ok(f.res.output.includes("[DONE]"));
                assert.ok(f.res.output.includes("build/gemini-3.8-flash-low-fake"));
            } else {
                assert.equal(f.res.body.choices[0].finish_reason, "tool_calls");
                assert.equal(f.res.body.model, body.model);
            }
            const bad = handlerFixture(t, { mode, output: reply([{ arguments: {}, name: "other" }]) });
            await processBuild(bad.h, { body, method: "POST" }, bad.res);
            assert.deepEqual(bad.releases, [mode === "auto_fallback"]);
            assert.equal(bad.requests.length, 1);
            assert.equal(bad.finished[0].usage.total_tokens, 12);
            if (mode === "auto_fallback") {
                assert.equal(bad.finished[0].outcome, "success");
                if (stream) assert.match(bad.res.output, /\[DONE\]/);
                else assert.equal(bad.res.body.choices[0].message.tool_calls, undefined);
            } else if (stream) {
                assert.doesNotMatch(bad.res.output, /"delta":\{"tool_calls"/);
                assert.doesNotMatch(bad.res.output, /\[DONE\]/);
            } else assert.equal(bad.res.statusCode, 502);
        });
test("OpenAI plain streaming uses cumulative snapshots and disconnect releases a failed lease", async t => {
    const f = handlerFixture(t, { output: "answer" });
    await processBuild(f.h, { body: { ...base, stream: true }, method: "POST" }, f.res);
    assert.match(f.res.output, /"content":"an"/);
    assert.deepEqual(f.releases, [true]);
    const e = Object.assign(new Error("cancelled"), { status: 499 });
    const broken = handlerFixture(t, { generationError: e });
    broken.h.controller.abort();
    await processBuild(broken.h, { body: base, method: "POST" }, broken.res);
    assert.deepEqual(broken.releases, [false]);
    assert.equal(broken.finished[0].outcome, "aborted");
});
test("synthetic answer protocol coexists with the Build adapter and both tool modes", () => {
    const FormatConverter = require("../src/core/FormatConverter");
    const converter = new FormatConverter({ debug() {}, info() {}, warn() {} }, { config: {} });
    for (const mode of ["auto_fallback", "strict"])
        for (const originalChoice of ["auto", "none", "required"]) {
            const original = { ...base, tool_choice: originalChoice, tools };
            const injected = Anti.inject(original);
            const contract = Tools.prepareTools(injected.body, { mode });
            const long = '```js\nconst x="\\\\";\n```\n你'.repeat(1000);
            const message = Tools.parseToolReply(
                reply([{ arguments: { content: long }, name: injected.name }]),
                contract
            );
            const native = {
                candidates: [
                    {
                        content: {
                            parts: [
                                {
                                    functionCall: {
                                        args: JSON.parse(message.tool_calls[0].function.arguments),
                                        name: message.tool_calls[0].function.name,
                                    },
                                },
                            ],
                            role: "model",
                        },
                        finishReason: "STOP",
                        index: 0,
                    },
                ],
            };
            const out = new Anti.Attempt(injected.name).nonStream(native, converter, base.model);
            assert.equal(out.choices[0].message.content, long);
            assert.equal(out.choices[0].message.tool_calls, undefined);
            if (mode === "strict")
                assert.throws(() => Tools.parseToolReply('{"content":null,"tool_calls":[', contract));
            else
                assert.equal(
                    Tools.parseToolReply('{"content":null,"tool_calls":[', contract).content,
                    '{"content":null,"tool_calls":['
                );
        }
    assert.ok(
        prepare({ ...base, messages: wrapped(envelope()), model: "anti-build-st/gemini-3.8-flash" }, config, {}).anti
    );
});
test("usage persists for failed validation and old SQLite records retain unknown usage", async t => {
    const UsageStatsStorage = require("../src/core/UsageStatsStorage");
    const storage = new UsageStatsStorage({ dbPath: path.join(temp(t), "usage.sqlite") });
    t.after(() => storage.close());
    const now = new Date().toISOString();
    const record = {
        apiFormat: "openai",
        durationMs: 0,
        finishedAt: now,
        model: base.model,
        outcome: "error",
        requestId: "known",
        startedAt: now,
        statusCode: 502,
        usage: { completion_tokens: 3, prompt_tokens: 12, total_tokens: 15 },
    };
    await storage.call("insert", record);
    await storage.call("insert", { ...record, requestId: "unknown", usage: null });
    const result = await storage.call("export", {});
    assert.equal(result[0].usage.total_tokens, 15);
    assert.equal(result[1].usage, null);
});

test("bundled Tavern 0.6.0 preserves v2 tool metadata and custom/reverse-proxy destinations", async () => {
    const adapter = await import("../integrations/sillytavern-build-adapter/transport.js");
    for (const source of ["custom", "openai"]) {
        const data = {
            chat_completion_source: source,
            messages: [{ content: "preset", name: "preset", role: "system" }, ...history],
            model: "build-st/gemini-3.8-flash",
            parallel_tool_calls: false,
            reverse_proxy: "https://gateway.example/v1",
            tool_choice: "required",
            tools,
        };
        data.anti_truncation = false;
        assert.equal(adapter.isBuildConnection(data), true);
        assert.equal(adapter.isBuildConnection({ ...data, model: "anti-build-st/gemini-3.8-flash" }), true);
        assert.equal(adapter.isBuildConnection({ ...data, model: "build/gemini-3.8-flash" }), false);
        const outgoing = adapter.prepareOutgoing(
            data,
            { generationType: "continue", segments: envelope().segments },
            { inlineTokens: 10 }
        );
        const parsed = parseSillyTavern([outgoing]);
        assert.deepEqual(sillyTavernMessages(parsed).slice(1), history);
        adapter.applyOutgoing(data, outgoing);
        assert.equal(data.reverse_proxy, "https://gateway.example/v1");
        assert.equal(data.tools, tools);
        if (source === "custom") {
            const included = JSON.parse(data.custom_include_body);
            assert.deepEqual(included.tools, tools);
            assert.equal(included.tool_choice, "required");
            assert.equal(included.parallel_tool_calls, false);
            assert.equal(included.anti_truncation, false);
        }
    }
});

test("Build quota cooldown and persisted recovery isolation never poison PG slots", async t => {
    const cfg = {
        ...loadConfig({ GLOBAL_MAX_CONCURRENCY: "3", MAX_BROWSER_WORKERS: "1" }),
        statePath: path.join(temp(t), "scheduler.json"),
    };
    const auth = { accountNameMap: new Map(), getRotationIndices: () => [0] };
    const logger = { error() {}, warn() {} };
    const scheduler = new ModelScheduler(cfg, auth, logger);
    const lease = await scheduler.acquire("build-st/gemini-3.8-flash-low");
    scheduler.startAttempt(lease);
    await scheduler.failure(lease, { message: "rate limited", status: 429 });
    scheduler.release(lease);
    const account = lease.account;
    assert.ok(account.models["build/gemini-3.8-flash"].cooldown_until);
    assert.equal(scheduler.slot(account, "gemini-3.8-flash").cooldown_until, 0);
    account.buildRecoveryBlocked = true;
    scheduler.flush();
    scheduler.close();
    const restored = new ModelScheduler(cfg, auth, logger);
    t.after(() => restored.close());
    const same = restored.account(0);
    assert.equal(same.buildRecoveryBlocked, true);
    assert.equal(restored.canLease(same, "gemini-3.8-flash"), true);
    assert.equal(restored.canLease(same, "build/gemini-4-argon"), false);
    assert.equal(same.models["build/gemini-3.8-flash"].inflight, 0);
});
test("preset upload, diagnostics and recovery endpoints require the existing administrator gate", async t => {
    const express = require("express"),
        ConfigurationRoutes = require("../src/config/ConfigurationRoutes");
    const app = express();
    app.use(express.json());
    new ConfigurationRoutes({ configurationService: {} }).setupRoutes(app, (req, res) =>
        res.status(401).json({ error: "unauthorized" })
    );
    const server = app.listen(0, "127.0.0.1");
    t.after(() => new Promise(resolve => server.close(resolve)));
    await new Promise(resolve => server.once("listening", resolve));
    for (const [method, url] of [
        ["GET", "presets"],
        ["POST", "presets"],
        ["GET", "status"],
        ["POST", "recover/0"],
    ]) {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/build/${url}`, {
            headers: { "Content-Type": "application/json" },
            method,
            ...(method === "POST" ? { body: "{}" } : {}),
        });
        assert.equal(response.status, 401);
    }
});

test("preset segmentation retains original text-part boundaries and none retains disabled definitions", () => {
    const prompts = parsePreset({ prompts: [{ content: "Preserve all the original character details." }] });
    const content = [
        { text: "Preserve all the original ", type: "text" },
        { text: "character details.", type: "text" },
    ];
    const split = segment([{ content, role: "system" }], prompts);
    assert.deepEqual(
        split.segments.map(s => s.contentPart),
        [0, 1]
    );
    assert.equal(split.segments.map(s => s.text).join(""), content.map(s => s.text).join(""));
    const none = Tools.prepareTools({ ...base, tool_choice: "none", tools }, { mode: "strict" });
    assert.match(Tools.toolInstructions(none), /lookup/);
    assert.match(Tools.toolInstructions(none), /tool_choice=none/);
});

test("PG validation errors retain known usage without fabricating missing counts", () => {
    const RequestHandler = require("../src/core/RequestHandler");
    const h = Object.create(RequestHandler.prototype);
    h.formatConverter = {
        _parseUsage: ({ usageMetadata: u }) => ({
            completion_tokens: u.candidatesTokenCount,
            prompt_tokens: u.promptTokenCount,
            total_tokens: u.totalTokenCount,
        }),
    };
    const res = {};
    h._captureKnownUsage(res, { promptTokenCount: 12 });
    assert.equal(res.__actualUsage, undefined);
    const usageMetadata = { candidatesTokenCount: 3, promptTokenCount: 12, totalTokenCount: 15 };
    h._captureKnownUsage(res, usageMetadata);
    assert.equal(res.__actualUsage.total_tokens, 15);
    const payload = h._addBlockedDetails(
        { error: { message: "invalid tool" } },
        { status: 502, usageMetadata },
        "openai"
    );
    assert.deepEqual(payload.error.usageMetadata, usageMetadata);
});

for (const stream of [false, true])
    for (const repaired of [false, true])
        test(`Build anti ${stream ? "stream" : "nonstream"} buffers and restores ${repaired ? "truncated" : "complete"} answer with usage`, async t => {
            const expected = "中文😀\n```js\nconst x=42;\n```  ";
            const f = handlerFixture(t, {
                output: ctx => {
                    const name = ctx.files[0].text.match(/agw_emit_[a-f0-9]{24}/)[0];
                    const content = JSON.stringify(expected);
                    const full = `{"content":null,"tool_calls":[{"name":${JSON.stringify(name)},"arguments":{"content":${content}}}]}`;
                    return repaired ? full.slice(0, full.indexOf(content) + content.length - 1) : full;
                },
            });
            await processBuild(
                f.h,
                {
                    body: { ...base, anti_truncation: true, stream, stream_options: { include_usage: true } },
                    method: "POST",
                },
                f.res
            );
            assert.equal(f.requests[0].options.onText, null);
            assert.deepEqual(f.releases, [true]);
            let answer, finish, usage;
            if (stream) {
                const events = f.res.output
                    .split("\n")
                    .filter(l => l.startsWith("data: {"))
                    .map(l => JSON.parse(l.slice(6)));
                answer = events
                    .flatMap(e => e.choices || [])
                    .map(c => c.delta?.content || "")
                    .join("");
                finish = events
                    .flatMap(e => e.choices || [])
                    .map(c => c.finish_reason)
                    .filter(Boolean)
                    .at(-1);
                usage = events.find(e => e.usage)?.usage;
                assert.match(f.res.output, /\[DONE\]/);
                assert.doesNotMatch(f.res.output, /agw_emit_/);
            } else {
                answer = f.res.body.choices[0].message.content;
                finish = f.res.body.choices[0].finish_reason;
                usage = f.res.body.usage;
                assert.equal(f.res.body.choices[0].message.tool_calls, undefined);
            }
            assert.equal(answer, expected);
            assert.equal(finish, repaired ? "length" : "stop");
            assert.equal(usage.total_tokens, 12);
        });

for (const stream of [false, true])
    for (const prefix of ["build/", "build-st/", "anti-build/", "anti-build-st/"])
        test(`${prefix} auto_fallback ${stream ? "SSE" : "JSON"} delivers prose despite invalid schema and broken history`, async t => {
            const st = envelope();
            st.messageMetadata[0].tool_calls = [
                { function: { arguments: "invalid", name: "lookup" }, id: "duplicate" },
                { id: "duplicate" },
            ];
            st.messageMetadata[1].tool_call_id = "missing";
            const malformed = { ...tools[0], function: { ...tools[0].function, parameters: { type: "bad-schema" } } };
            const f = handlerFixture(t, { output: 'already generated text, including "tool_calls": examples' });
            const body = {
                ...base,
                messages: prefix.includes("-st/") ? wrapped(st) : [{ content: "unpaired result", role: "tool" }],
                model: prefix + "gemini-3.8-flash",
                stream,
                stream_options: { include_usage: true },
                tools: [malformed],
            };
            await processBuild(f.h, { body, method: "POST" }, f.res);
            assert.deepEqual(f.releases, [true]);
            assert.equal(f.requests.length, 1);
            assert.equal(f.failures.length, 0);
            assert.equal(f.finished[0].usage.total_tokens, 12);
            if (stream) {
                assert.match(f.res.output, /already generated text/);
                assert.match(f.res.output, /\[DONE\]/);
                assert.doesNotMatch(f.res.output, /invalid_tool_response|agw_emit_/);
            } else {
                assert.equal(
                    f.res.body.choices[0].message.content,
                    'already generated text, including "tool_calls": examples'
                );
                assert.equal(f.res.body.choices[0].message.tool_calls, undefined);
            }
        });

// Synthetic wire fixtures based on the supported task and RPC envelope shapes.
const BuildErrors = require("../src/core/codeAssistant/BuildError");
function failedWire(message, usage = null) {
    const data = JSON.parse(wire("partial", { status: 4, usage }));
    data[0][0][2][0][5] = [message];
    return JSON.stringify(data);
}
test("Build errors separate HTTP, RPC and semantic status and preserve bounded diagnostics", () => {
    for (const [rpcCode, status] of [
        [1, 499],
        [3, 400],
        [4, 504],
        [5, 404],
        [7, 403],
        [8, 429],
        [16, 401],
    ]) {
        for (const body of [
            [rpcCode, "specific reason"],
            [[rpcCode, "specific reason"]],
            [[[rpcCode, "specific reason"]]],
            [null, [rpcCode, "specific reason"]],
        ]) {
            const e = BuildErrors.fromResponse({ status: 200, text: JSON.stringify(body) }, "poll");
            assert.equal(e.status, status);
            assert.equal(e.upstreamError.httpStatus, 200);
            assert.equal(e.upstreamError.rpcCode, rpcCode);
            assert.equal(e.upstreamError.status, null);
            assert.match(e.message, /specific reason/);
        }
    }
    const e = BuildErrors.fromResponse(
        { retryAfter: "12", status: 429, text: "Quota exceeded. Please try again later." },
        "submit"
    );
    assert.equal(e.upstreamError.httpStatus, 429);
    assert.equal(e.rateLimit.retryAfterMs, 12000);
    assert.equal(e.rateLimit.type, "temporary");
    for (const value of ["-1", "99999999999", "invalid", "0"]) assert.equal(BuildErrors.retryAfter(value), null);
    assert.equal(BuildErrors.retryAfter(new Date(12000).toUTCString(), 1000), 11000);
    const big = BuildErrors.fromResponse(
        {
            status: 200,
            text: JSON.stringify([
                8,
                "你".repeat(5000) + " Authorization: Bearer secret",
                [{ authorization: "secret", metadata: { cookie: "secret" }, reason: "x".repeat(20000) }],
            ]),
        },
        "poll"
    );
    assert.equal(big.truncated, true);
    assert.ok(Buffer.byteLength(big.message) <= 4096);
    assert.ok(Buffer.byteLength(JSON.stringify(big.upstreamError.details)) <= 16384);
    assert.doesNotMatch(JSON.stringify(BuildErrors.errorInfo(big)), /secret|authorization|cookie/);
    const sanitized = BuildErrors.buildError({
        message:
            "api_key=AIzaPrivate signature=private password=private\nCookie: a=private; b=private\nAuthorization: Bearer private",
        source: "google_task",
    });
    assert.doesNotMatch(JSON.stringify(BuildErrors.errorInfo(sanitized)), /private|AIzaPrivate/);
    assert.equal(
        BuildErrors.fromResponse({ status: 502, text: "<html>private body</html>" }, "poll").message.includes(
            "private body"
        ),
        false
    );
    for (const body of [
        wire("normal"),
        JSON.stringify([null, null, [8, "ordinary data"]]),
        JSON.stringify(["10", "3", "2"]),
    ])
        assert.equal(BuildErrors.fromResponse({ status: 200, text: body }, "poll"), null);
});
test("Build task quota is temporary; internal failure retains cumulative usage once and cleanup failure stays secondary", async t => {
    const p = prepare(base, config, {});
    for (const [message, status, code, usage] of [
        ["Quota exceeded. Please try again later.", 429, "BUILD_QUOTA_EXCEEDED", null],
        ["An internal error occurred.", 502, "BUILD_TASK_FAILED", ["10", "3", "2"]],
    ]) {
        const { r, calls } = runtime(t),
            original = r.rpc,
            observations = [];
        r.rpc = async (method, body) => {
            if (method === "StreamCodeAssistantOfflineGeneration") {
                calls.push({ method });
                return failedWire(message, usage);
            }
            if (method === "CancelCodeAssistantOfflineGeneration") assert.fail("terminal task cannot be cancelled");
            if (method === "DeleteApplet")
                throw BuildErrors.buildError({
                    message: "cleanup failed",
                    phase: "cleanup",
                    source: "local",
                    status: 503,
                });
            return original(method, body);
        };
        await assert.rejects(r.generate(p.identity, p.context, { onUsage: u => observations.push(u) }), e => {
            assert.equal(e.code, code);
            assert.equal(e.status, status);
            assert.equal(e.source, "google_task");
            assert.equal(e.taskTerminal, true);
            assert.equal(e.upstreamError.message, message);
            assert.equal(e.upstreamError.httpStatus, 200);
            assert.equal(e.upstreamError.rpcCode, null);
            assert.equal(e.secondaryErrors[0].phase, "cleanup");
            if (usage) {
                assert.equal(e.usage.total_tokens, 15);
                assert.equal(observations.length, 1);
            } else {
                assert.equal(e.usage, null);
                assert.equal(e.rateLimit.type, "temporary");
            }
            return true;
        });
        assert.equal(calls.filter(c => c.method === "CodeAssistantOffline").length, 1);
        assert.equal(calls.filter(c => c.method === "StreamCodeAssistantOfflineGeneration").length, 1);
        assert.equal(r.cleanupPending, true);
        assert.ok(Object.values(r.read())[0].complete);
    }
});
for (const stream of [false, true])
    test(`Build ${stream ? "SSE" : "JSON"} error correlates request ID, semantic history and real HTTP even if scheduler fails`, async t => {
        const error = BuildErrors.buildError({
            httpStatus: 200,
            message: "Quota exceeded. Please try again later.",
            phase: "poll",
            source: "google_task",
            taskTerminal: true,
        });
        const f = handlerFixture(t, { generationError: error });
        let headerId;
        f.res.setHeader = (name, value) => {
            if (name === "X-Request-ID") headerId = value;
        };
        const finalize = require("../src/core/RequestHandler").prototype._finalizeTrackedRequest;
        const records = [];
        f.h._getUsageStatsService = () => ({
            finishRequest: (id, r) => records.push({ id, ...r }),
            recordAttempt() {},
        });
        f.h._finalizeTrackedRequest = finalize;
        f.h.serverSystem.scheduler.failure = () => {
            throw new Error("scheduler unavailable");
        };
        await processBuild(f.h, { body: { ...base, stream }, method: "POST" }, f.res);
        const payload = stream
            ? JSON.parse(
                  f.res.output
                      .split("\n")
                      .find(l => l.startsWith('data: {"error"'))
                      .slice(6)
              )
            : f.res.body;
        assert.equal(payload.error.request_id, headerId);
        assert.equal(records[0].id, headerId);
        assert.equal(records[0].outcome, "error");
        assert.equal(records[0].statusCode, 429);
        assert.equal(records[0].responseHttpStatus, stream ? 200 : 429);
        assert.equal(records[0].error.code, "BUILD_QUOTA_EXCEEDED");
        assert.equal(payload.error.message, records[0].errorMessage);
        assert.deepEqual(f.releases, [false]);
        if (stream) assert.doesNotMatch(f.res.output, /\[DONE\]|"finish_reason":"stop"/);
    });
test("Build real RPC auth affects only current sessions; local synthetic RPC status stays transport", async t => {
    const { classifyError } = require("../src/core/ModelScheduler");
    const { r } = runtime(t);
    delete r.rpc;
    let response;
    r.page = { evaluate: async (_, source) => (source.includes(".cancel(") ? undefined : response) };
    for (const local of [false, true]) {
        response = { source: local ? "local" : "google_http", status: local ? 503 : 200, text: '[16,"auth rejected"]' };
        await assert.rejects(r.rpc("CreateApplet", [], { phase: "create" }), e => {
            assert.equal(classifyError(e), local ? "transport" : "account");
            assert.equal(e.upstreamError.rpcCode, local ? null : 16);
            assert.equal(e.upstreamError.httpStatus, local ? null : 200);
            return true;
        });
    }
});
test("Build error schema survives old database migration, restart and export/import without inventing old fields", async t => {
    const { DatabaseSync } = require("node:sqlite");
    const UsageStatsStorage = require("../src/core/UsageStatsStorage");
    const dbPath = path.join(temp(t), "errors.sqlite");
    let storage = new UsageStatsStorage({ dbPath });
    const now = new Date().toISOString();
    const old = {
        durationMs: 1,
        finishedAt: now,
        outcome: "success",
        requestId: "old",
        startedAt: now,
        statusCode: 200,
        usage: { total_tokens: 15 },
    };
    await storage.call("insert", old);
    await storage.close();
    const db = new DatabaseSync(dbPath);
    db.exec("ALTER TABLE requests DROP COLUMN response_http_status");
    db.exec("ALTER TABLE requests DROP COLUMN error_json");
    db.close();
    storage = new UsageStatsStorage({ dbPath });
    const error = BuildErrors.errorInfo(
        BuildErrors.buildError({
            httpStatus: 200,
            message: "Quota exceeded. Please try again later.",
            phase: "poll",
            source: "google_task",
            taskTerminal: true,
        })
    );
    await storage.call("insert", {
        ...old,
        error,
        errorMessage: error.message,
        outcome: "error",
        requestId: "new",
        responseHttpStatus: 200,
        statusCode: 429,
        usage: null,
    });
    let records = await storage.call("export", {});
    assert.equal(records[0].error, null);
    assert.equal(records[0].responseHttpStatus, null);
    assert.equal(records[0].usage.total_tokens, 15);
    assert.equal(records[1].error.rateLimit.type, "temporary");
    assert.equal(records[1].responseHttpStatus, 200);
    await storage.close();
    storage = new UsageStatsStorage({ dbPath });
    t.after(() => storage.close());
    records = await storage.call("export", {});
    assert.equal(records[1].error.upstreamError.httpStatus, 200);
    const imported = new UsageStatsStorage({ dbPath: path.join(temp(t), "import.sqlite") });
    t.after(() => imported.close());
    const report = await imported.call("import", { content: JSON.stringify(records[1]) });
    assert.equal(report.importedCount, 1);
    assert.deepEqual((await imported.call("export", {}))[0].error, records[1].error);
});

test("Build quota classification shares aliases, isolates PG and preserves confirmed longer cooldowns through concurrent results", async t => {
    const scheduler = new ModelScheduler(
        {
            ...loadConfig({ BUILD_MAX_CONCURRENCY: "3", GLOBAL_MAX_CONCURRENCY: "3" }),
            statePath: path.join(temp(t), "quota.json"),
        },
        { accountNameMap: new Map(), getRotationIndices: () => [0] },
        { error() {}, warn() {} }
    );
    t.after(() => scheduler.close());
    const leases = [];
    for (const model of ["build/gemini-3.8-flash", "build-st/gemini-3.8-flash", "anti-build/gemini-3.8-flash"])
        leases.push(await scheduler.acquire(model));
    for (const lease of leases) scheduler.startAttempt(lease);
    const error = BuildErrors.buildError({
        httpStatus: 200,
        message: "Quota exceeded. Please try again later.",
        phase: "poll",
        source: "google_task",
        taskTerminal: true,
    });
    await scheduler.failure(leases[0], error);
    const slot = leases[0].slot;
    assert.equal(slot.last_error_kind, "rate_limited");
    assert.equal(slot.rate_limit_type, "temporary");
    assert.equal(leases[1].slot, slot);
    assert.equal(leases[2].slot, slot);
    assert.equal(scheduler.slot(leases[0].account, "gemini-3.8-flash").cooldown_until, 0);
    const confirmedDeadline = Date.now() + 3600000;
    slot.rate_limit_type = "daily_quota";
    slot.cooldown_until = confirmedDeadline;
    await scheduler.failure(leases[1], error);
    scheduler.release(leases[0], false);
    scheduler.release(leases[1], false);
    scheduler.release(leases[2], true);
    assert.equal(slot.cooldown_until, confirmedDeadline);
    assert.equal(slot.rate_limit_type, "daily_quota");
    assert.equal(slot.failure_count, 2);
});
test("real Build RPC auth expiry retains sessionVersion protection", async t => {
    for (const replace of [false, true]) {
        const session = { authIndex: 0, sessionVersion: 7 },
            expired = [];
        const auth = {
            accountLoginService: { state: { accounts: [session] } },
            accountNameMap: new Map(),
            getRotationIndices: () => [0],
            markAsExpired: async (...args) => expired.push(args),
        };
        const scheduler = new ModelScheduler({ ...loadConfig({}), statePath: path.join(temp(t), "auth.json") }, auth, {
            error() {},
            warn() {},
        });
        t.after(() => scheduler.close());
        const lease = await scheduler.acquire("build/gemini-3.8-flash");
        scheduler.startAttempt(lease);
        if (replace) session.sessionVersion++;
        const error = BuildErrors.fromResponse(
            { source: "google_http", status: 200, text: '[16,"Credentials expired"]' },
            "poll"
        );
        await scheduler.failure(lease, error);
        assert.deepEqual(expired, replace ? [] : [[0, 7]]);
        assert.equal(lease.account.healthy, replace);
        scheduler.release(lease, false);
    }
});
test("SSE partial content failure remains error and disconnect writes nothing or penalizes no account", async t => {
    for (const abort of [false, true]) {
        const f = handlerFixture(t);
        f.h.browserManager.contexts.get(0).page.codeAssistantRuntime.generate = async (_, __, options) => {
            options.onText("partial text");
            if (abort) {
                f.res.destroyed = true;
                f.res.emit("close");
            }
            throw BuildErrors.buildError({
                httpStatus: 200,
                message: "An internal error occurred.",
                phase: "poll",
                source: "google_task",
                taskTerminal: true,
            });
        };
        await processBuild(f.h, { body: { ...base, stream: true }, method: "POST" }, f.res);
        assert.match(f.res.output, /partial text/);
        assert.equal(f.finished.length, 1);
        assert.equal(f.finished[0].outcome, abort ? "aborted" : "error");
        assert.equal(f.finished[0].statusCode, abort ? 499 : 502);
        assert.equal(f.failures.length, abort ? 0 : 1);
        assert.equal(f.res.output.includes('"error"'), !abort);
        assert.doesNotMatch(f.res.output, /\[DONE\]|"finish_reason":"stop"/);
    }
});
test("overall deadline bounds known task read recovery without resubmission or quota inference", async t => {
    const { r, calls } = runtime(t),
        original = r.rpc;
    r.rpc = async (method, body) => {
        if (method === "StreamCodeAssistantOfflineGeneration") {
            calls.push({ method });
            throw BuildErrors.buildError({
                message: "read interrupted",
                phase: "poll",
                source: "transport",
                status: 504,
            });
        }
        return original(method, body);
    };
    const p = prepare(base, config, {}),
        started = Date.now();
    await assert.rejects(r.generate(p.identity, p.context, { timeoutMs: 100 }), e => {
        assert.equal(e.status, 504);
        assert.equal(e.source, "local");
        assert.equal(e.code, "BUILD_DEADLINE_EXCEEDED");
        assert.equal(e.rateLimit, undefined);
        assert.equal(e.usage, undefined);
        return true;
    });
    assert.ok(Date.now() - started < 1500);
    assert.equal(calls.filter(c => c.method === "CodeAssistantOffline").length, 1);
    assert.equal(calls.filter(c => c.method === "StreamCodeAssistantOfflineGeneration").length, 1);
    assert.deepEqual(r.read(), {});
});
test("successful generation with pending cleanup records success and separate cleanup diagnostics", async t => {
    const f = handlerFixture(t);
    const runtime = f.h.browserManager.contexts.get(0).page.codeAssistantRuntime;
    runtime.cleanupPending = true;
    runtime.cleanupError = BuildErrors.errorInfo(
        BuildErrors.buildError({ message: "Delete pending", phase: "cleanup", source: "local", status: 503 })
    );
    runtime.generate = async () => ({ cleanupError: runtime.cleanupError, text: "answer" });
    runtime.recover = async () => {};
    f.h.serverSystem.scheduler.saveSoon = () => {};
    f.h.serverSystem.scheduler.drain = () => {};
    await processBuild(f.h, { body: base, method: "POST" }, f.res);
    assert.equal(f.finished[0].outcome, "success");
    assert.equal(f.finished[0].error.phase, "cleanup");
    assert.equal(f.res.statusCode, 200);
    assert.equal(f.finished[0].errorMessage, undefined);
    assert.deepEqual(f.releases, [true]);
});

test("synthetic end-to-end quota response, SQLite history and scheduler share one request ID and temporary classification", async t => {
    const UsageStatsService = require("../src/core/UsageStatsService");
    const RequestHandler = require("../src/core/RequestHandler");
    const logger = { debug() {}, error() {}, info() {}, warn() {} };
    const auth = { accountNameMap: new Map(), getRotationIndices: () => [0] };
    const dir = temp(t),
        stats = new UsageStatsService(auth, logger, dir);
    await stats.ready;
    t.after(() => stats.close());
    const scheduler = new ModelScheduler(
        { ...loadConfig({}), statePath: path.join(dir, "scheduler.json") },
        auth,
        logger
    );
    t.after(() => scheduler.close());
    const { r, calls } = runtime(t),
        original = r.rpc;
    r.rpc = async (method, body) =>
        method === "StreamCodeAssistantOfflineGeneration"
            ? failedWire("Quota exceeded. Please try again later.")
            : original(method, body);
    const f = handlerFixture(t);
    f.h.browserManager.contexts.get(0).page.codeAssistantRuntime = r;
    f.h.serverSystem.scheduler = scheduler;
    f.h._getUsageStatsService = () => stats;
    f.h._getClientIp = () => "127.0.0.1";
    for (const name of ["_startTrackedRequest", "_updateTrackedRequest", "_finalizeTrackedRequest"])
        f.h[name] = RequestHandler.prototype[name];
    let requestId;
    f.res.setHeader = (name, value) => {
        if (name === "X-Request-ID") requestId = value;
    };
    await processBuild(f.h, { body: { ...base, stream: true }, method: "POST", path: "/v1/chat/completions" }, f.res);
    await stats.appendPromise;
    const records = await stats.storage.call("export", {}),
        record = records[0];
    assert.equal(records.length, 1);
    assert.equal(record.requestId, requestId);
    assert.equal(record.outcome, "error");
    assert.equal(record.statusCode, 429);
    assert.equal(record.responseHttpStatus, 200);
    assert.equal(record.error.upstreamError.httpStatus, 200);
    assert.equal(record.error.upstreamError.rpcCode, null);
    assert.equal(record.error.code, "BUILD_QUOTA_EXCEEDED");
    assert.equal(record.usage.partial, true);
    assert.equal(record.usage.total_tokens, undefined);
    assert.match(f.res.output, new RegExp(requestId));
    assert.ok(f.res.output.includes(record.errorMessage));
    const slot = scheduler.slot(scheduler.account(0), "build/gemini-3.8-flash");
    assert.equal(slot.last_error_kind, "rate_limited");
    assert.equal(slot.rate_limit_type, "temporary");
    t.diagnostic(
        JSON.stringify({
            error: record.error,
            request_id: requestId,
            response_http_status: record.responseHttpStatus,
            scheduler: { kind: slot.last_error_kind, type: slot.rate_limit_type },
            status_code: record.statusCode,
            usage: record.usage,
        })
    );
    assert.equal(calls.filter(c => c.method === "CodeAssistantOffline").length, 1);
    assert.equal(calls.filter(c => c.method === "CancelCodeAssistantOfflineGeneration").length, 0);
});

test("runtime returns cleanup diagnosis on its own successful result and keeps it across a later recovery", async t => {
    const { r } = runtime(t),
        original = r.rpc;
    let failDelete = true;
    r.rpc = async (method, body) => {
        if (method === "DeleteApplet" && failDelete) {
            failDelete = false;
            throw BuildErrors.buildError({ message: "Delete pending", phase: "cleanup", source: "local", status: 503 });
        }
        return original(method, body);
    };
    const p = prepare(base, config, {});
    const first = await r.generate(p.identity, p.context, {});
    assert.equal(first.text, "hello");
    assert.equal(first.cleanupError.phase, "cleanup");
    assert.equal(r.cleanupPending, true);
    const second = await r.generate(p.identity, p.context, {});
    assert.equal(second.cleanupError, undefined);
    assert.equal(first.cleanupError.message, "Delete pending");
    assert.deepEqual(r.read(), {});
});

test("client disconnect retains cleanup secondary diagnostics and primary 499", async t => {
    const f = handlerFixture(t);
    const runtime = f.h.browserManager.contexts.get(0).page.codeAssistantRuntime;
    const cleanup = BuildErrors.buildError({
        httpStatus: 503,
        message: "Unavailable",
        phase: "cleanup",
        rpcCode: 14,
        source: "google_rpc",
    });
    runtime.generate = async () => {
        f.h.controller.abort();
        const error = BuildErrors.buildError({ message: "Aborted", phase: "poll", status: 499 });
        error.secondaryErrors = [cleanup];
        throw error;
    };
    await processBuild(f.h, { body: base, method: "POST" }, f.res);
    assert.equal(f.finished[0].outcome, "aborted");
    assert.equal(f.finished[0].error.status, 499);
    assert.equal(f.finished[0].error.secondaryErrors[0].upstreamError.httpStatus, 503);
    assert.equal(f.finished[0].error.secondaryErrors[0].upstreamError.rpcCode, 14);
    assert.equal(f.failures.length, 0);
});
