<template>
    <details>
        <summary>Token 统计（按规范模型合并别名）</summary>
        <p>
            日窗口为美国太平洋时间。Build
            上游重置时区尚未确认；这是本地统计窗口。缓存属于输入、思考属于输出，不能再次加到总数。缺失 usage 不作为 0。
        </p>
        <label>统计日期 <input v-model="day" type="date" /></label>
        <button type="button" @click="refresh">读取统计</button>
        <p v-if="error" role="alert">{{ error }}</p>
        <table v-if="rows.length">
            <thead>
                <tr>
                    <th>日期 / 模型</th>
                    <th>输入</th>
                    <th>输出</th>
                    <th>缓存</th>
                    <th>思考</th>
                    <th>已知总 Token</th>
                    <th>已知 / 未知请求</th>
                </tr>
            </thead>
            <tbody>
                <tr v-for="r in rows" :key="r.day + r.model + r.tier + r.account_key">
                    <td>{{ r.day }} / {{ r.model }} / {{ r.tier }} / {{ r.account_key }}</td>
                    <td>{{ value(r, "input") }}</td>
                    <td>{{ value(r, "output") }}</td>
                    <td>{{ value(r, "cached") }}</td>
                    <td>{{ value(r, "reasoning") }}</td>
                    <td>{{ r.known_requests ? r.total : "未知" }}</td>
                    <td>{{ r.known_requests }} / {{ r.unknown_requests }}</td>
                </tr>
            </tbody>
        </table>
        <p v-else>尚无已加载数据；旧请求缺失的 Token 无法倒推出真实用量。</p>
    </details>
</template>
<script setup>
import { ref } from "vue";
const day = ref(""),
    rows = ref([]),
    error = ref("");
const value = (r, key) => (r[key + "_observations"] ? r[key] : "未知");
async function refresh() {
    try {
        error.value = "";
        const res = await fetch("/api/usage-stats/tokens" + (day.value ? "?day=" + day.value : ""));
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "读取失败");
        rows.value = data.models;
    } catch (e) {
        error.value = e.message;
    }
}
</script>
