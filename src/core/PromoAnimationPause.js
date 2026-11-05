/* eslint-env browser */

// Registered only on business contexts. CSS also covers cards inserted later by the SPA.
function installPromoAnimationPause() {
    if (window !== window.top || location.hostname !== "aistudio.google.com") return;

    const install = () => {
        try {
            const id = "aistudio-promo-animation-pause";
            if (document.getElementById(id)) return;
            const parent = document.head || document.documentElement;
            if (!parent) return;
            const style = document.createElement("style");
            style.id = id;
            style.textContent = `
                .promo-card-wrapper,
                .promo-card-wrapper::before,
                .promo-card-wrapper::after {
                    animation-play-state: paused !important;
                }
            `;
            parent.appendChild(style);
        } catch {
            // Decoration failures must not affect authentication or context readiness.
            console.warn("[ProxyClient] Promo animation pause style could not be installed");
        }
    };

    if (document.head || document.documentElement || document.readyState !== "loading") {
        install();
    } else {
        document.addEventListener("DOMContentLoaded", install, { once: true });
    }
}

module.exports = { installPromoAnimationPause };
