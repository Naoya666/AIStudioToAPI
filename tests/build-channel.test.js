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
        assert.throws(() => Tools.parseToolReply(reply([{ arguments: {}, name: "other" }]), context("auto")), {
            code: "invalid_tool_response",
        });
        assert.throws(() => Tools.parseToolReply('{"tool_calls":[', context("auto")), {
            code: "invalid_tool_response",
        });
        assert.throws(() => Tools.parseToolReply(reply([{ arguments: "broken", name: "lookup" }]), context("auto")));
        assert.throws(() => Tools.parseToolReply(reply([call]), context("none")));
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
            assert.match(Tools.toolInstructions(context(forced)), /tool_choice="auto"/);
        }
        assert.equal(
            Tools.prepareTools({ ...base, messages: history, tools }, { mode }).messages[1].tool_call_id,
            "c1"
        );
        assert.throws(() => Tools.prepareTools({ ...base, messages: history.slice(1), tools }, { mode }));
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
            throw Object.assign(new Error("read interrupted"), { status: 502 });
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
            assert.deepEqual(bad.releases, [false]);
            assert.equal(bad.requests.length, 1);
            assert.equal(bad.finished[0].usage.total_tokens, 12);
            if (stream) {
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
            assert.throws(() => Tools.parseToolReply('{"content":null,"tool_calls":[', contract));
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
