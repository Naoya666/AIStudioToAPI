<template>
    <span>
        <ElTag size="small">{{ names[account.tier?.effectiveTier] || l("未知", "Unknown") }}</ElTag>
        <small v-if="account.tier?.source">
            {{ account.tier.source === "manual" ? l("手动", "Manual") : l("检测", "Detected") }}</small
        >
        <small v-if="account.tier?.stale"> · {{ l("待复检", "Recheck needed") }}</small>
        <ElTooltip
            v-if="account.tier?.conflict"
            :content="
                l(
                    '手动设置为付费账号，但最近一次有效检测为 Free，请检查订阅或账号会话。',
                    'Manually marked as paid, but the latest valid observation is Free. Check the subscription or session.'
                )
            "
        >
            <span role="status"> ⚠</span>
        </ElTooltip>
    </span>
</template>
<script setup>
import I18n from "../utils/i18n";
defineProps({ account: { required: true, type: Object } });
const names = { free: "Free", pro: "Pro", ultra: "Ultra 5x", ultra20: "Ultra 20x" };
const l = (zh, en) => (I18n.getLang() === "zh" ? zh : en);
</script>
