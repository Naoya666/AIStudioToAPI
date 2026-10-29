// This function is also evaluated inside Playwright pages.
/* eslint-env browser */
function pageErrors() {
    const bodyText = document.body.innerText || "";
    return {
        appletFailed: bodyText.includes("Failed to initialize applet"),
        concurrentUpdates: bodyText.includes("There are concurrent updates") || bodyText.includes("concurrent updates"),
        snapshotFailed: bodyText.includes("Failed to create snapshot") || bodyText.includes("Please try again"),
    };
}

// Evaluated in the page by both login validation stages. The recent-apps
// navigation hint describes an optional Drive feature, not a model access gate.
function studioAccessState() {
    const text = (document.body.innerText || "").replace(/\s+/g, " ");
    const blockingText = text.replace(/Allow Drive access to see your recent apps\.?/gi, "");
    return { permissionRequired: /Allow Drive access/i.test(blockingText) };
}
module.exports = { pageErrors, studioAccessState };
