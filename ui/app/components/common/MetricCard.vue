<template>
    <div class="metric-card" :class="{ 'metric-error': error }">
        <span class="metric-label">{{ label }}</span>
        <strong class="metric-value"
            >{{ value ?? "—" }}<span v-if="value != null && unit" class="metric-unit">{{ unit }}</span></strong
        >
        <small v-if="description">{{ description }}</small>
    </div>
</template>
<script setup>
defineProps({
    description: { default: "", type: String },
    error: Boolean,
    label: { required: true, type: String },
    unit: { default: "", type: String },
    value: { default: null, type: [Number, String] },
});
</script>
<style scoped>
.metric-card {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
    padding: 20px;
    background: var(--bg-card);
    border: 1px solid var(--border-color);
    border-radius: 10px;
}
.metric-label,
small {
    color: var(--text-secondary);
}
.metric-value {
    font-size: 24px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    overflow-wrap: anywhere;
}
.metric-unit {
    font-size: 14px;
    margin-left: 4px;
}
.metric-error .metric-value {
    color: var(--color-error);
}
@media (max-width: 767px) {
    .metric-card {
        padding: 16px;
    }
}
</style>
