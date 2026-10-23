<template>
    <nav :aria-label="t('adminNavigation')" class="app-navigation">
        <div class="app-brand">AI Studio <span>To API</span></div>
        <div class="sidebar-menu">
            <button
                v-for="item in items"
                :key="item.tab"
                type="button"
                class="navigation-item"
                :class="{ active: activeTab === item.tab }"
                :aria-current="activeTab === item.tab ? 'page' : undefined"
                @click="$emit('navigate', item.tab)"
            >
                <AppIcon :name="item.tab" /><span>{{ t(item.label) }}</span>
            </button>
        </div>
        <div class="sidebar-footer">
            <button type="button" class="navigation-item" @click="$emit('language')">
                <AppIcon name="language" /><span>{{ t("switchLanguage") }}</span>
            </button>
            <button type="button" class="navigation-item" @click="$emit('logout')">
                <AppIcon name="logout" /><span>{{ t("logout") }}</span>
            </button>
        </div>
    </nav>
</template>
<script setup>
import AppIcon from "../components/icons/AppIcon.vue";
defineProps({ activeTab: { required: true, type: String }, t: { required: true, type: Function } });
defineEmits(["navigate", "language", "logout"]);
const items = [
    { label: "adminOverview", tab: "home" },
    { label: "accountManagement", tab: "accounts" },
    { label: "adminProxyPool", tab: "proxy-pool" },
    { label: "usageStats", tab: "stats" },
    { label: "realtimeLogs", tab: "logs" },
    { label: "settings", tab: "settings" },
];
</script>
<style scoped>
.app-navigation {
    display: flex;
    flex-direction: column;
    height: 100%;
    padding: 24px 12px 16px;
    gap: 24px;
}
.app-brand {
    padding: 0 12px;
    font-size: 18px;
    font-weight: 700;
}
.app-brand span {
    color: var(--text-secondary);
    font-weight: 400;
}
.sidebar-menu,
.sidebar-footer {
    display: grid;
    gap: 4px;
}
.sidebar-footer {
    margin-top: auto;
}
.navigation-item {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    min-height: 44px;
    padding: 8px 12px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--text-secondary);
    text-align: left;
    font: inherit;
    cursor: pointer;
}
.navigation-item svg {
    flex-shrink: 0;
}
.navigation-item:hover {
    background: var(--bg-list-item-hover);
}
.navigation-item.active {
    background: var(--color-primary-soft);
    color: var(--color-primary);
    font-weight: 600;
}
</style>
