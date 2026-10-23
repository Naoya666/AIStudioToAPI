<template>
    <header class="page-heading">
        <div>
            <h1>{{ title }}</h1>
            <p v-if="description">{{ description }}</p>
        </div>
        <div v-if="$slots.actions" class="page-heading-actions"><slot name="actions" /></div>
    </header>
</template>
<script setup>
defineProps({ description: { default: "", type: String }, title: { required: true, type: String } });
</script>
<style scoped>
.page-heading {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 24px;
}
h1 {
    margin: 0;
    font-size: 24px;
    font-weight: 600;
    line-height: 1.4;
}
p {
    margin: 8px 0 0;
    color: var(--text-secondary);
}
.page-heading-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
}
@media (max-width: 767px) {
    .page-heading {
        flex-direction: column;
    }
    h1 {
        font-size: 20px;
    }
}
</style>
