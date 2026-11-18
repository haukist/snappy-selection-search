browser.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== browser.runtime.id || message.target !== "offscreen" || message.type !== "copyText") return;
    const textarea = document.createElement("textarea");
    textarea.value = message.text;
    document.body.appendChild(textarea);
    textarea.select();
    try {
        // Chrome's offscreen clipboard sample uses execCommand; the response is synchronous.
        // https://github.com/GoogleChrome/chrome-extensions-samples/tree/main/functional-samples/cookbook.offscreen-clipboard-write
        if (!document.execCommand("copy")) throw new Error("Clipboard copy was denied");
        respond({ ok: true });
    } catch (error) {
        respond({ ok: false, error: String(error) });
    } finally {
        textarea.remove();
    }
});
