<template>
    <section class="token-usage-panel">
        <div class="token-heading">
            <h3>Token 统计</h3>
            <span>按规范模型合并别名</span>
        </div>
        <p class="token-note">
            按美国太平洋时间统计。Build 上游重置时区尚未确认，此处为本地统计窗口。
            缓存计入输入，思考计入输出，不重复累加；缺失用量显示为未知。
        </p>
        <form class="token-filters" @submit.prevent="refresh">
            <label>统计日期 <input v-model="day" type="date" required /></label>
            <label>
                模型
                <el-select v-model="model" clearable filterable placeholder="全部模型" aria-label="筛选模型">
                    <el-option v-for="name in models" :key="name" :label="name" :value="name" />
                </el-select>
            </label>
            <label class="token-email-filter">
                邮箱
                <el-input v-model="email" clearable placeholder="输入邮箱的部分字符" aria-label="筛选邮箱" />
            </label>
            <el-button native-type="submit" :loading="loading" type="primary">读取统计</el-button>
        </form>
        <p v-if="error" class="token-error" role="alert">{{ error }}</p>
        <div class="token-table-wrapper" :aria-busy="loading">
            <table class="token-table">
                <thead>
                    <tr>
                        <th>账号邮箱</th>
                        <th>模型 / 层级</th>
                        <th>输入</th>
                        <th>输出</th>
                        <th>缓存</th>
                        <th>思考</th>
                        <th>已知总 Token</th>
                        <th>已知 / 未知请求</th>
                    </tr>
                </thead>
                <tbody>
                    <tr v-for="r in rows" :key="JSON.stringify([r.day, r.model, r.tier, r.account_key])">
                        <td>{{ r.account_key }}</td>
                        <td>
                            <span class="token-model">{{ r.model }}</span
                            ><span class="token-tier">{{ r.tier === "unknown" ? "层级未知" : r.tier }}</span>
                        </td>
                        <td>{{ value(r, "input") }}</td>
                        <td>{{ value(r, "output") }}</td>
                        <td>{{ value(r, "cached") }}</td>
                        <td>{{ value(r, "reasoning") }}</td>
                        <td class="token-total">{{ r.known_requests ? number(r.total) : "未知" }}</td>
                        <td>{{ number(r.known_requests) }} / {{ number(r.unknown_requests) }}</td>
                    </tr>
                    <tr v-if="!rows.length">
                        <td colspan="8" class="token-empty">
                            {{ loading ? "正在读取统计…" : error ? "读取失败，请重试" : "暂无符合条件的 Token 统计" }}
                        </td>
                    </tr>
                </tbody>
            </table>
        </div>
        <div class="token-pagination">
            <span>共 {{ number(total) }} 条记录</span>
            <el-pagination
                v-model:current-page="page"
                v-model:page-size="pageSize"
                :page-sizes="[10, 20, 50, 100]"
                :total="total"
                layout="sizes, prev, pager, next"
                :pager-count="5"
                :disabled="loading"
                small
            />
        </div>
        <p class="token-note token-footnote">
            旧请求缺失的 Token 无法倒推出真实用量；有未知请求时，已知总量不代表完整用量。
        </p>
    </section>
</template>
<script setup>
import { onMounted, onBeforeUnmount, ref, watch } from "vue";
const dateParts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "America/Los_Angeles",
    year: "numeric",
}).formatToParts(new Date());
const part = type => dateParts.find(item => item.type === type).value;
const day = ref(`${part("year")}-${part("month")}-${part("day")}`);
const model = ref(""),
    email = ref(""),
    rows = ref([]),
    models = ref([]),
    error = ref("");
const page = ref(1),
    pageSize = ref(10),
    total = ref(0),
    loading = ref(false);
const number = value => Number(value || 0).toLocaleString();
const value = (row, key) => (row[key + "_observations"] ? number(row[key]) : "未知");
let timer, controller;
async function refresh() {
    clearTimeout(timer);
    controller?.abort();
    const current = new AbortController();
    controller = current;
    loading.value = true;
    error.value = "";
    try {
        const query = new URLSearchParams({
            day: day.value,
            email: email.value.trim(),
            model: model.value || "",
            page: String(page.value),
            pageSize: String(pageSize.value),
        });
        const res = await fetch(`/api/usage-stats/tokens?${query}`, { signal: current.signal });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "读取失败");
        if (controller !== current) return;
        rows.value = data.models || [];
        models.value = data.available_models || [];
        total.value = data.total || 0;
        page.value = data.page || 1;
    } catch (e) {
        if (e.name !== "AbortError" && controller === current) {
            rows.value = [];
            total.value = 0;
            error.value = e.message;
        }
    } finally {
        if (controller === current) loading.value = false;
    }
}
watch([day, model, email, pageSize], () => {
    page.value = 1;
    controller?.abort();
    clearTimeout(timer);
    timer = setTimeout(refresh, 300);
});
watch(page, () => {
    clearTimeout(timer);
    timer = setTimeout(refresh, 0);
});
onMounted(refresh);
onBeforeUnmount(() => {
    clearTimeout(timer);
    controller?.abort();
});
</script>
<style scoped>
.token-usage-panel {
    min-width: 0;
    padding: 20px;
    margin-bottom: 20px;
    background: var(--bg-card);
    border: 1px solid var(--border-color);
    border-radius: 10px;
}
.token-heading,
.token-filters,
.token-pagination {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 12px;
}
.token-heading h3 {
    margin: 0;
    color: var(--text-primary);
    font-size: 1rem;
}
.token-heading > span,
.token-note,
.token-tier {
    color: var(--text-secondary);
    font-size: 12px;
}
.token-note {
    line-height: 1.7;
    margin: 12px 0 18px;
}
.token-filters {
    align-items: flex-end;
    margin-bottom: 18px;
}
.token-filters label {
    display: flex;
    flex-direction: column;
    gap: 8px;
    color: var(--text-secondary);
    font-size: 13px;
}
.token-filters .el-select {
    width: 280px;
}
.token-email-filter {
    width: 240px;
}
.token-filters input {
    min-height: 32px;
    box-sizing: border-box;
    border: 1px solid var(--border-color);
    border-radius: 4px;
    background: var(--bg-card);
    color: var(--text-primary);
    padding: 4px 10px;
    font: inherit;
}
.token-table-wrapper {
    overflow-x: auto;
}
.token-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
    white-space: nowrap;
}
.token-table th,
.token-table td {
    padding: 12px 10px;
    border-bottom: 1px solid var(--border-color);
    text-align: right;
    font-variant-numeric: tabular-nums;
}
.token-table th {
    color: var(--text-secondary);
    background: rgba(0, 0, 0, 0.02);
    font-weight: 600;
}
.token-table th:nth-child(-n + 2),
.token-table td:nth-child(-n + 2) {
    text-align: left;
}
.token-table tbody tr:hover {
    background: rgba(var(--color-primary-rgb), 0.06);
}
.token-model {
    display: block;
    font-family: monospace;
}
.token-tier {
    display: block;
    margin-top: 4px;
}
.token-total {
    font-weight: 600;
    color: var(--color-primary);
}
.token-table .token-empty {
    text-align: center;
    padding: 32px;
    color: var(--text-secondary);
}
.token-pagination {
    justify-content: space-between;
    margin-top: 16px;
    color: var(--text-secondary);
    font-size: 13px;
}
.token-error {
    color: var(--el-color-danger, #ef4444);
    font-size: 13px;
}
.token-footnote {
    margin-bottom: 0;
}
@media (max-width: 600px) {
    .token-usage-panel {
        padding: 14px;
    }
    .token-filters label,
    .token-filters .el-select,
    .token-email-filter {
        width: 100%;
    }
    .token-pagination {
        gap: 8px;
    }
    .token-pagination :deep(.el-pagination) {
        flex-wrap: wrap;
        row-gap: 8px;
    }
}
</style>
