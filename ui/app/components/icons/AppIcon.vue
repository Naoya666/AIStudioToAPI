<template>
    <svg
        width="20"
        height="20"
        viewBox="0 0 20 20"
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
    >
        <path :d="paths[name] || paths.home" />
    </svg>
</template>
<script setup>
defineProps({ name: { default: "home", type: String } });
const paths = {
    accounts: "M13 6a3 3 0 1 1-6 0 3 3 0 0 1 6 0ZM3 18v-2a5 5 0 0 1 10 0v2M15 4a3 3 0 0 1 0 6m1 3a4 4 0 0 1 2 4v1",
    home: "M2 9 10 2l8 7M4 8v10h5v-6h3v6h4V8",
    language: "M2 4h10M7 2v2M4 4c0 4 3 7 7 9M10 4c0 4-3 7-7 9m9 5 3-8 3 8m-5-3h4",
    logout: "M8 3H3v14h5m4-11 4 4-4 4m-5-4h10",
    logs: "M12 2H4v16h12V6l-4-4v4h4M7 10h6m-6 4h6",
    menu: "M3 5h14M3 10h14M3 15h14",
    "proxy-pool":
        "M6 4a2 2 0 1 1-4 0 2 2 0 0 1 4 0Zm12 0a2 2 0 1 1-4 0 2 2 0 0 1 4 0Zm-6 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM6 4h8M5 6l4 8m6-8-4 8",
    settings: "M3 5h14M3 10h14M3 15h14M7 3v4m6 1v4m-6 1v4",
    stats: "M3 2v15h15M7 13V9m4 4V5m4 8V7",
};
</script>
