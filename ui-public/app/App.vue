<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

const isDev = Boolean(import.meta.env.DEV);
const activeMockPreset = ref("standard");
const useMock = ref(isDev);
const availablePresets = ref([]);
let mockPresets = null;

const selectedRange = ref("24h");
const ranges = [
    { key: "all", label: "历史" },
    { key: "24h", label: "近 24 小时" },
    { key: "1h", label: "近 1 小时" },
];
const data = ref(null);
const supportsRecent = computed(() =>
    Boolean(data.value?.model_stat_windows?.["24h"] && data.value?.model_stat_windows?.["1h"])
);
const effectiveRange = computed(() => (supportsRecent.value ? selectedRange.value : "all"));
const statsFor = model =>
    effectiveRange.value === "all" ? model.history : model.recent_stats?.[effectiveRange.value] || {};
const quotaWaiting = computed(() => ["exhausted", "cooldown"].includes(data.value?.quota_status));
const partialUnavailable = computed(
    () =>
        data.value &&
        (!data.value.history.enabled ||
            data.value.realtime.limit === 0 ||
            !supportsRecent.value ||
            (data.value.cluster && data.value.cluster.status !== "complete") ||
            Object.values(data.value.model_stat_windows || {}).some(window => window.status !== "available"))
);
const rangeNotice = computed(() => {
    if (!supportsRecent.value) return "当前服务暂不支持近期统计";
    if (effectiveRange.value === "all") {
        if (
            data.value?.cluster &&
            data.value.history.status !== "disabled" &&
            data.value.coverage?.history.status !== "complete"
        )
            return "仅包含当前可用统计来源，累计历史可能随节点离线或统计重置而变化。";
        return data.value?.history.enabled ? "" : "请求统计未启用";
    }
    const status = data.value.model_stat_windows[effectiveRange.value].status;
    if (status === "disabled") return "请求统计未启用";
    if (status === "unavailable") return "近期统计暂时不可用";
    if (
        data.value?.cluster &&
        (data.value.cluster.status !== "complete" ||
            data.value.models.some(
                model => model.coverage?.recent_stats?.[effectiveRange.value]?.status !== "complete"
            ))
    )
        return "仅包含当前可用统计来源，部分节点或模型统计不可用。";
    return "";
});
const incomplete = value => value && value.status !== "complete";
const modelIncomplete = model => ["quota", "today", "realtime"].some(key => incomplete(model.coverage?.[key]));
const statsCoverage = model =>
    effectiveRange.value === "all" ? model.coverage?.history : model.coverage?.recent_stats?.[effectiveRange.value];
const sourceTime = value => (value ? new Date(value).toLocaleString("zh-CN") : "—");
const error = ref(false);
const loading = ref(true);
const currentTime = ref(Date.now());
let timer;
let controller;

const number = value => (value == null ? "—" : new Intl.NumberFormat("zh-CN").format(value));
const percent = value => (value == null ? "—" : `${value.toFixed(1)}%`);
const duration = value => {
    if (value == null) return "—";
    return value < 1000 ? `${number(value)} 毫秒` : `${(value / 1000).toFixed(value < 10000 ? 1 : 0)} 秒`;
};
const updatedAt = computed(() =>
    data.value?.generated_at
        ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "medium" }).format(
              new Date(data.value.generated_at)
          )
        : "—"
);

const resetCountdown = computed(() => {
    const now = new Date(currentTime.value);
    try {
        const timeZone = data.value?.usage_window?.timezone || "America/Los_Angeles";
        const parts = new Intl.DateTimeFormat("en-US", {
            hour: "numeric",
            hour12: false,
            minute: "numeric",
            second: "numeric",
            timeZone,
        }).formatToParts(now);
        const getPart = type => parseInt(parts.find(p => p.type === type)?.value, 10);
        const hour = (getPart("hour") || 0) % 24;
        const minute = getPart("minute") || 0;
        const second = getPart("second") || 0;
        const elapsed = hour * 3600 + minute * 60 + second;
        let remainingSeconds = 86400 - elapsed;
        if (remainingSeconds < 0) remainingSeconds += 86400;

        const h = Math.floor(remainingSeconds / 3600);
        const m = Math.floor((remainingSeconds % 3600) / 60);
        if (h === 0 && m === 0) return "即将重置";
        if (h === 0) return `${m} 分钟`;
        return `${h} 小时 ${m} 分钟`;
    } catch {
        return "—";
    }
});

const activePercent = computed(() => {
    if (!data.value?.realtime?.limit) return 0;
    const active = data.value.realtime.active ?? 0;
    const limit = data.value.realtime.limit;
    return Math.min(100, Math.round((active / limit) * 100));
});

const getModelTag = modelName => {
    const lower = (modelName || "").toLowerCase();
    if (lower.includes("thinking")) return { label: "Thinking", type: "thinking" };
    if (lower.includes("pro")) return { label: "Pro", type: "pro" };
    if (lower.includes("flash-lite")) return { label: "Lite", type: "lite" };
    if (lower.includes("flash")) return { label: "Flash", type: "flash" };
    return { label: "Standard", type: "default" };
};

const getAccountRingData = realtime => {
    const available = realtime?.available_accounts ?? 0;
    const rateLimited = realtime?.rate_limited_accounts ?? 0;
    const total = available + rateLimited;
    if (total === 0) {
        return {
            available: 0,
            availableRatio: 0,
            hasRateLimit: false,
            rateLimited: 0,
            total: 0,
        };
    }
    const availableRatio = Math.round((available / total) * 100);
    return {
        available,
        availableRatio,
        hasRateLimit: rateLimited > 0,
        rateLimited,
        total,
    };
};

const getEstimatedRemaining = model => {
    if (!model?.quota?.estimable) return null;
    const available = model?.realtime?.available_accounts ?? 0;
    // 如果可用账号数为 0，实际可用次数也一定是 0，避免后端估算值产生误导
    if (available === 0) return 0;
    return model.quota.estimated_remaining;
};

async function refresh() {
    currentTime.value = Date.now();
    if (import.meta.env.DEV && useMock.value) {
        if (!mockPresets) {
            const module = await import("./mockData.js");
            mockPresets = module.mockPresets;
            availablePresets.value = Object.entries(mockPresets).map(([key, val]) => ({
                key,
                label: val.label,
            }));
        }
        const preset = mockPresets[activeMockPreset.value] || mockPresets.standard;
        data.value = {
            ...preset.data,
            generated_at: new Date(currentTime.value).toISOString(),
            ...(preset.data.model_stat_windows
                ? {
                      model_stat_windows: Object.fromEntries(
                          Object.entries(preset.data.model_stat_windows).map(([range, window]) => [
                              range,
                              {
                                  ...window,
                                  from: new Date(
                                      currentTime.value - (range === "24h" ? 86400000 : 3600000)
                                  ).toISOString(),
                                  to: new Date(currentTime.value).toISOString(),
                              },
                          ])
                      ),
                  }
                : {}),
        };
        error.value = false;
        loading.value = false;
        return;
    }

    if (controller) return;
    controller = new AbortController();
    try {
        const response = await fetch("/api/public/dashboard", {
            headers: { Accept: "application/json" },
            signal: controller.signal,
        });
        if (!response.ok) throw new Error("unavailable");
        data.value = await response.json();
        error.value = Boolean(data.value.stale);
    } catch (fetchError) {
        if (fetchError.name !== "AbortError") error.value = true;
    } finally {
        controller = null;
        loading.value = false;
    }
}

function schedule() {
    clearTimeout(timer);
    timer = setTimeout(
        async () => {
            await refresh();
            schedule();
        },
        document.hidden ? 30000 : 5000
    );
}
function onVisibilityChange() {
    if (!document.hidden) refresh();
    schedule();
}
onMounted(async () => {
    await refresh();
    schedule();
    document.addEventListener("visibilitychange", onVisibilityChange);
});
onBeforeUnmount(() => {
    clearTimeout(timer);
    controller?.abort();
    document.removeEventListener("visibilitychange", onVisibilityChange);
});

function onMockChange() {
    refresh();
}
</script>

<template>
    <main>
        <aside v-if="isDev" class="dev-toolbar" aria-label="开发调试工具栏">
            <div class="dev-toolbar-badge">开发调试模式</div>
            <label class="dev-toolbar-toggle">
                <input v-model="useMock" type="checkbox" @change="onMockChange" />
                <span>Mock 数据</span>
            </label>
            <select
                v-if="useMock && availablePresets.length"
                v-model="activeMockPreset"
                class="dev-toolbar-select"
                @change="onMockChange"
            >
                <option v-for="item in availablePresets" :key="item.key" :value="item.key">
                    {{ item.label }}
                </option>
            </select>
        </aside>

        <header>
            <div>
                <p class="eyebrow">PUBLIC STATUS</p>
                <h1>服务用量公示</h1>
                <p class="updated">数据更新时间：{{ updatedAt }} (本地) · 配额重置倒计时：{{ resetCountdown }}</p>
                <p v-if="data?.cluster" class="updated cluster-status" aria-live="polite">
                    数据有效节点 {{ data.cluster.fresh_nodes }} / {{ data.cluster.expected_nodes }} · 可服务节点
                    {{ data.cluster.serving_nodes }} / {{ data.cluster.expected_nodes }} ·
                    {{ data.cluster.status === "complete" ? "数据完整" : "部分节点或统计不可用" }}
                </p>
                <p v-if="data?.cluster" class="updated source-times">
                    源数据时间：{{ sourceTime(data.cluster.oldest_source_at) }} ～
                    {{ sourceTime(data.cluster.newest_source_at) }}（本地）
                </p>
            </div>
            <div class="header-actions">
                <span
                    class="status"
                    :class="{
                        warning: error || partialUnavailable || quotaWaiting || data?.service_status === 'unavailable',
                    }"
                >
                    <span class="status-dot"></span>
                    {{
                        loading
                            ? "正在获取数据"
                            : error
                              ? data
                                  ? "数据暂时中断，显示上次结果"
                                  : "暂时无法获取数据"
                              : data?.service_status === "unavailable" && !quotaWaiting
                                ? "服务暂时不可用"
                                : partialUnavailable
                                  ? "部分统计不可用"
                                  : quotaWaiting
                                    ? data.quota_status === "exhausted"
                                        ? "额度已耗尽，等待恢复"
                                        : "暂时限流，等待恢复"
                                    : "服务正常运行"
                    }}
                </span>
                <button
                    class="refresh-btn"
                    :class="{ spinning: loading }"
                    title="立即刷新数据"
                    aria-label="立即刷新数据"
                    @click="refresh"
                >
                    <svg
                        viewBox="0 0 16 16"
                        width="14"
                        height="14"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.75"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                    >
                        <path d="M14 2v4h-4" />
                        <path d="M2 14v-4h4" />
                        <path d="M3.51 9a6 6 0 0 1 9.4-4.5L14 6" />
                        <path d="M12.49 7a6 6 0 0 1-9.4 4.5L2 10" />
                    </svg>
                </button>
            </div>
        </header>

        <aside class="notice">
            <svg class="notice-icon" viewBox="0 0 16 16" width="15" height="15" fill="currentColor">
                <path
                    d="M8 1a7 7 0 1 0 7 7A7.008 7.008 0 0 0 8 1zm0 12.6A5.6 5.6 0 1 1 13.6 8 5.606 5.606 0 0 1 8 12.6zm0-8.8a.9.9 0 1 0 .9.9A.9.9 0 0 0 8 4.8zm-1 2.8h2v4.4H7z"
                />
            </svg>
            <div class="notice-body">
                <strong>额度均为预估值</strong>：外部用量、Google
                配额调整、失败重试及统计延迟都可能造成偏差，以实际上游结果为准。“今日”按太平洋时间（PT）计算。
            </div>
        </aside>

        <section v-if="!data && !loading" class="empty">暂时无法获取数据，请稍后再试。</section>
        <template v-if="data">
            <section aria-labelledby="overview-title">
                <h2 id="overview-title">全局概览</h2>
                <div class="overview">
                    <article>
                        <span>正在执行</span>
                        <b class="tabular-num"
                            >{{ number(data.realtime.active) }} / {{ number(data.realtime.limit) }}</b
                        >
                        <div class="capacity-bar" title="并发占用率">
                            <div
                                class="capacity-fill"
                                :class="{ 'capacity-fill-warn': activePercent >= 80 }"
                                :style="{ width: `${activePercent}%` }"
                            ></div>
                        </div>
                    </article>
                    <article>
                        <span>历史请求</span>
                        <b class="tabular-num">{{ number(data.history.total_requests) }}</b>
                    </article>
                    <article>
                        <span>成功率</span>
                        <b class="tabular-num" :class="{ 'text-success': data.history.success_rate >= 98 }">
                            {{ percent(data.history.success_rate) }}
                        </b>
                    </article>
                    <article>
                        <span>失败请求</span>
                        <b class="tabular-num" :class="{ 'text-danger': data.history.failed_requests > 0 }">
                            {{ number(data.history.failed_requests) }}
                        </b>
                    </article>
                    <article>
                        <span>平均耗时</span>
                        <b class="tabular-num">{{ duration(data.history.average_duration_ms) }}</b>
                    </article>
                </div>
                <p v-if="data.history.status === 'disabled' || (!data.cluster && !data.history.enabled)" class="muted">
                    历史请求统计未启用。
                </p>
                <p v-else-if="data.cluster && data.history.status === 'unavailable'" class="muted">
                    历史统计暂不可用。
                </p>
                <p v-if="incomplete(data.coverage?.history)" class="muted">
                    历史请求仅包含当前可用统计来源；合计可能随节点离线、删除或统计重置而下降。
                </p>
                <p v-if="incomplete(data.coverage?.realtime)" class="muted">当前负载仅包含可服务且数据有效的节点。</p>
            </section>

            <section aria-labelledby="models-title">
                <h2 id="models-title">模型额度与实时状态</h2>
                <p v-if="data.realtime.limit === 0" class="muted">模型实时统计未启用。</p>
                <p v-else-if="!data.models.length" class="muted">当前没有公开展示的模型。</p>
                <div class="models">
                    <article v-for="model in data.models" :key="model.model" class="model-card">
                        <div class="model-card-header">
                            <h3>{{ model.model }}</h3>
                            <span class="model-badge" :class="'badge-' + getModelTag(model.model).type">
                                {{ getModelTag(model.model).label }}
                            </span>
                        </div>

                        <div
                            class="quota"
                            :class="{
                                'quota-empty': model.quota.estimable && getEstimatedRemaining(model) === 0,
                                'quota-low':
                                    model.quota.estimable &&
                                    getEstimatedRemaining(model) > 0 &&
                                    getEstimatedRemaining(model) <= 100,
                                'quota-inestimable': !model.quota.estimable,
                            }"
                        >
                            <div class="quota-meta">
                                <span class="quota-label">预估剩余额度</span>
                                <em class="quota-badge">{{
                                    model.quota.estimable
                                        ? "预估"
                                        : model.quota.known_estimated_remaining != null
                                          ? "部分可估算"
                                          : "未知"
                                }}</em>
                            </div>
                            <b class="quota-value">
                                {{
                                    model.quota.estimable
                                        ? `${number(getEstimatedRemaining(model))} 次`
                                        : model.quota.known_estimated_remaining != null
                                          ? `已知部分约 ${number(model.quota.known_estimated_remaining)} 次`
                                          : "暂无法估算"
                                }}
                            </b>
                        </div>

                        <!-- 账号池健康环形条 -->
                        <div class="account-ring-box">
                            <div class="account-ring-wrapper">
                                <svg class="account-ring-svg" viewBox="0 0 36 36">
                                    <path
                                        class="ring-bg"
                                        :class="{ 'ring-bg-warn': getAccountRingData(model.realtime).hasRateLimit }"
                                        d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                                    />
                                    <path
                                        class="ring-fill"
                                        :stroke-dasharray="`${getAccountRingData(model.realtime).availableRatio}, 100`"
                                        d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                                    />
                                </svg>
                                <span class="ring-center-value">
                                    {{ number(model.realtime.available_accounts) }}
                                </span>
                            </div>
                            <div class="account-ring-meta">
                                <div class="account-ring-title">账号池健康度</div>
                                <div class="account-ring-detail">
                                    <span class="account-ok"
                                        >{{ number(model.realtime.available_accounts) }} 可用 /
                                        {{ number(model.realtime.tier_allowed_accounts) }} 层级允许</span
                                    >
                                    <span v-if="model.realtime.rate_limited_accounts > 0" class="account-warn">
                                        · {{ number(model.realtime.rate_limited_accounts) }} 耗尽
                                    </span>
                                    <span v-else-if="model.realtime.available_accounts == null" class="account-warn"
                                        >· 状态未知</span
                                    >
                                    <span v-else-if="incomplete(model.coverage?.realtime)" class="account-warn"
                                        >· 仅已知部分</span
                                    >
                                    <span v-else class="account-all-ok">· 全部就绪</span>
                                </div>
                            </div>
                        </div>

                        <dl>
                            <div>
                                <dt>今日请求</dt>
                                <dd class="tabular-num">{{ number(model.today.requests) }}</dd>
                            </div>
                            <div>
                                <dt>排队请求</dt>
                                <dd class="tabular-num" :class="{ 'text-warn-bold': model.realtime.queued > 0 }">
                                    {{ number(model.realtime.queued) }}
                                </dd>
                            </div>
                            <div>
                                <dt>正在执行</dt>
                                <dd class="tabular-num">{{ number(model.realtime.active) }}</dd>
                            </div>
                        </dl>
                        <p v-if="modelIncomplete(model)" class="muted">
                            额度与今日、实时数据可能不完整，未知值显示为 —。
                        </p>
                    </article>
                </div>
                <p v-if="data.models.length" class="helper">
                    今日请求是今天实际发往模型的请求次数，重试会重复计数。额度耗尽账号是当前因上游返回 429
                    而暂不可用的账号数，不代表永久失效。
                </p>
            </section>

            <section aria-labelledby="history-title">
                <div class="stats-heading">
                    <h2 id="history-title">分模型统计</h2>
                    <div class="range-buttons" role="group" aria-label="分模型统计时间范围">
                        <button
                            v-for="range in ranges"
                            :key="range.key"
                            type="button"
                            :aria-pressed="effectiveRange === range.key"
                            :disabled="range.key !== 'all' && !supportsRecent"
                            @click="selectedRange = range.key"
                        >
                            {{ range.label }}
                        </button>
                    </div>
                </div>
                <p v-if="rangeNotice" class="muted" role="status">{{ rangeNotice }}</p>
                <div class="table-wrap">
                    <table>
                        <thead>
                            <tr>
                                <th>模型</th>
                                <th>{{ effectiveRange === "all" ? "历史请求" : "请求数" }}</th>
                                <th>成功率</th>
                                <th>失败请求</th>
                                <th>平均耗时</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr v-for="model in data.models" :key="model.model">
                                <th class="table-model-th">
                                    <span>{{ model.model }}</span>
                                    <span v-if="incomplete(statsCoverage(model))" class="muted"
                                        >（仅可用统计来源）</span
                                    >
                                    <span class="table-model-tag" :class="'badge-' + getModelTag(model.model).type">
                                        {{ getModelTag(model.model).label }}
                                    </span>
                                </th>
                                <td class="tabular-num">{{ number(statsFor(model).total_requests) }}</td>
                                <td
                                    class="tabular-num"
                                    :class="{
                                        'text-success': statsFor(model).success_rate >= 98,
                                        'text-warn':
                                            statsFor(model).success_rate != null && statsFor(model).success_rate < 95,
                                    }"
                                >
                                    {{ percent(statsFor(model).success_rate) }}
                                </td>
                                <td class="tabular-num" :class="{ 'text-danger': statsFor(model).failed_requests > 0 }">
                                    {{ number(statsFor(model).failed_requests) }}
                                </td>
                                <td class="tabular-num">{{ duration(statsFor(model).average_duration_ms) }}</td>
                            </tr>
                        </tbody>
                    </table>
                </div>
                <p class="helper">近期统计按请求完成时间滚动计算；失败数包含用户中止，重试后成功按成功请求计。</p>
                <p v-if="data.cluster" class="helper">
                    近期范围来自各节点最近快照，窗口存在秒级偏差。累计历史仅汇总当前有效来源，不保证持续递增。
                </p>
            </section>
        </template>
    </main>
</template>
