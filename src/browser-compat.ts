// Browser-specific operations shared by the background and options page.
namespace BrowserCompat {
	export const isChrome = browser.runtime.getManifest().manifest_version === 3;
	export const supportsBrowserSearch = !isChrome && !!browser.search && typeof browser.search.get === "function";

	export function supportsEngine(engine: SSS.SearchEngine): boolean {
		return !!engine && (supportsBrowserSearch || engine.type !== SSS.SearchEngineType.BrowserSearchApi);
	}

	export async function version(): Promise<number> {
		if (isChrome) return 0; // Firefox version gates must never be applied to Chrome.
		const info = await browser.runtime.getBrowserInfo();
		return parseInt(info.version.split(".")[0]);
	}

	export async function inject(tabId: number, frameId?: number, allFrames = false): Promise<number[] | undefined> {
		const files = ["content-scripts/selectionchange.js", "content-scripts/page-script.js"];
		if (isChrome) {
			const api = (globalThis as any).chrome;
			const target = frameId !== undefined ? { tabId, frameIds: [frameId] } : { tabId, allFrames };
			const results = await api.scripting.executeScript({ target, files: ["content-scripts/entry.js"] });
			return results.filter(result => result.result === true).map(result => result.frameId);
		} else {
			for (const file of files) await browser.tabs.executeScript(tabId, { file, frameId, allFrames, runAt: "document_start" });
		}
	}

	export function createMenu(properties: Parameters<typeof browser.contextMenus.create>[0]): Promise<void> {
		const options = { ...properties };
		if (isChrome) delete options.icons;
		return new Promise((resolve, reject) => {
			browser.contextMenus.create(options, () => {
				const error = browser.runtime.lastError;
				if (error) reject(new Error(error.message));
				else resolve();
			});
		});
	}

	let clipboardQueue: Promise<void> = Promise.resolve();
	export function copyText(text: string): Promise<void> {
		if (!isChrome) return navigator.clipboard.writeText(text);
		const operation = clipboardQueue.then(async () => {
			const api = (globalThis as any).chrome;
			const url = browser.runtime.getURL("offscreen.html");
			const contexts = await api.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [url] });
			const createdDocument = contexts.length === 0;
			if (createdDocument) await api.offscreen.createDocument({
				url: "offscreen.html", reasons: ["CLIPBOARD"], justification: "Copy a search selection or link text."
			});
			try {
				const response = await browser.runtime.sendMessage({ target: "offscreen", type: "copyText", text });
				if (!response || !response.ok) throw new Error(response && response.error || "Clipboard copy failed");
			} finally {
				if (createdDocument) await api.offscreen.closeDocument();
			}
		});
		clipboardQueue = operation.catch(() => {});
		return operation;
	}
}
