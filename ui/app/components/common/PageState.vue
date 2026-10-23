<template>
    <div class="page-state" :role="error ? 'alert' : 'status'" :aria-busy="loading">
        <p>{{ message }}</p>
        <el-button v-if="error" @click="$emit('retry')">{{ retryLabel }}</el-button>
        <slot />
    </div>
</template>
<script setup>
defineProps({
    error: Boolean,
    loading: Boolean,
    message: { required: true, type: String },
    retryLabel: { default: "", type: String },
});
defineEmits(["retry"]);
</script>
<style scoped>
.page-state {
    padding: 24px;
    border: 1px solid var(--border-color);
    border-radius: 10px;
    background: var(--bg-card);
    text-align: center;
    color: var(--text-secondary);
}
.page-state[role="alert"] {
    border-color: var(--color-error);
}
</style>
