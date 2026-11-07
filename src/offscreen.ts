browser.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== browser.runtime.id || message.target !== "offscreen" || message.type !== "copyText") return;
    const textarea = document.createElement("textarea");
    textarea.value = message.text;
    document.body.appendChild(textarea);
    textarea.select();
    try {
        if (!document.execCommand("copy")) throw new Error("Clipboard copy was denied");
        respond({ ok: true });
    } catch (error) {
        respond({ ok: false, error: String(error) });
    } finally {
        textarea.remove();
    }
});
