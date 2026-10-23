<template>
    <div class="app-shell">
        <aside class="desktop-navigation">
            <AppNavigation
                v-bind="navigationProps"
                @navigate="navigate"
                @language="$emit('language')"
                @logout="$emit('logout')"
            />
        </aside>
        <div class="mobile-navigation">
            <el-button :aria-label="t('adminNavigation')" @click="drawer = true"
                ><AppIcon name="menu" />{{ t("adminNavigation") }}</el-button
            ><span>AI Studio To API</span>
        </div>
        <el-drawer
            v-model="drawer"
            direction="ltr"
            size="min(280px, 90vw)"
            :title="t('adminNavigation')"
            :append-to-body="true"
        >
            <AppNavigation
                v-bind="navigationProps"
                @navigate="navigate"
                @language="$emit('language')"
                @logout="$emit('logout')"
            />
        </el-drawer>
        <main id="workspace" class="workspace"><slot /></main>
    </div>
</template>
<script setup>
import { computed, ref } from "vue";
import AppNavigation from "./AppNavigation.vue";
import AppIcon from "../components/icons/AppIcon.vue";
const props = defineProps({ activeTab: { required: true, type: String }, t: { required: true, type: Function } });
const emit = defineEmits(["navigate", "language", "logout"]);
const drawer = ref(false);
const navigationProps = computed(() => ({ activeTab: props.activeTab, t: props.t }));
const navigate = tab => {
    drawer.value = false;
    emit("navigate", tab);
};
</script>
<style scoped>
.app-shell {
    min-height: 100vh;
}
.desktop-navigation {
    position: fixed;
    inset: 0 auto 0 0;
    width: 216px;
    border-right: 1px solid var(--border-color);
    background: var(--bg-card);
    z-index: 10;
}
.workspace {
    margin-left: 216px;
    padding: 24px;
    min-width: 0;
}
.mobile-navigation {
    display: none;
}
@media (min-width: 768px) and (max-width: 1199px) {
    .desktop-navigation {
        width: 184px;
    }
    .workspace {
        margin-left: 184px;
        padding: 20px;
    }
}
@media (max-width: 767px) {
    .desktop-navigation {
        display: none;
    }
    .mobile-navigation {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 8px 16px;
        border-bottom: 1px solid var(--border-color);
        background: var(--bg-card);
    }
    .mobile-navigation .el-button {
        min-height: 44px;
        gap: 8px;
    }
    .workspace {
        margin: 0;
        padding: 16px;
    }
}
</style>
