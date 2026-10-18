// Fault injector: intentionally ignores cancellation and can leave browser-like
// descendants behind. Only referenced by the isolated account queue tests.
const { spawn } = require("node:child_process");
let started = false;
process.on("message", message => {
    if (message.shutdown) return process.exit(0);
    if (!message.credentials) return;
    const { email } = message.credentials;
    const send = value =>
        process.send({ executorId: message.executorId, taskId: message.taskId, token: message.token, ...value });
    if (!started) {
        started = true;
        send({ browserStarted: true });
    }
    send({ phase: "mock_page" });
    if (email.startsWith("hang")) {
        spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
        return;
    }
    if (email.startsWith("exit")) {
        process.exit(1);
        return;
    }
    const result = email.startsWith("network")
        ? { error: "network_timeout", retryable: true }
        : email.startsWith("wrong")
          ? { error: "wrong_password", retryable: false }
          : { email, storageState: { cookies: [], origins: [] } };
    if (result.error) send({ screenshot: { reason: "page_closed" } });
    setTimeout(
        () => {
            send({ result });
            if (email.startsWith("dirty")) return;
            setTimeout(
                () => {
                    send({ cleaned: true });
                    if (email.startsWith("stale")) setTimeout(() => send({ cleaned: true, result }), 80);
                },
                email.startsWith("cleaning") ? 250 : 0
            );
        },
        email.startsWith("late") ? 1000 : 50
    );
});
