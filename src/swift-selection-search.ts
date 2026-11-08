/*

This is the background script for SSS. It's always running. Things it does:

- Injects content scripts (a.k.a. page scripts) into each tab that is opened, so that the engines popup can appear there.
- Registers the search engines to appear in Firefox's context menu.
- Trades messages with the content scripts.
	To initialize them, to be informed of search engine clicks to begin searches, etc.
- Detects changes to settings from the options page and resets all running page scripts to use the new settings.
	Also updates settings objects created on previous SSS versions to contain new settings.

Here you'll find the declarations for most classes and enums related to search engines and settings,
as well as the default settings and engines that come with SSS.

*/

var iconv;	// avoid TS compilation errors but still get working JS code

namespace SSS
{
	/* ==================================== */
	/* ====== Swift Selection Search ====== */
	/* ==================================== */

	// Set to true if you want to see SSS's logs in Firefox's "Browser Console".
	// In general, use for development and don't commit this enabled.
	const DEBUG = false;

	if (DEBUG) {
		var log = console.log;
	}

	// Base class for all engines.
	export abstract class SearchEngine
	{
		uniqueId: string;
		type: SearchEngineType;
		isEnabled: boolean;
		isEnabledInContextMenu: boolean;
		shortcut: string;
	}

	// SSS-specific engine base class, for copy to clipboard, open as link, etc.
	// (SearchEngineType: SSS)
	export class SearchEngine_SSS extends SearchEngine
	{
		id: string;
	}

	// SSS-specific engine "copy to clipboard".
	export class SearchEngine_SSS_Copy extends SearchEngine_SSS
	{
		isPlainText: boolean;
	}

	// User-created engine base class, for custom engines, browser engines and groups.
	export class SearchEngine_NonSSS extends SearchEngine
	{
		name: string;
		iconUrl: string;
	}

	// All custom engines created by the user (or imported from a search.json.mozlz4 file, the old way to import browser engines).
	// (SearchEngineType: Custom)
	export class SearchEngine_Custom extends SearchEngine_NonSSS
	{
		searchUrl: string;
		encoding: string;
		discardOnOpen: boolean;
	}

	// Search engines imported from the browser via the WebExtensions search API. More limited.
	// (SearchEngineType: BrowserSearchApi)
	export class SearchEngine_BrowserSearchApi extends SearchEngine_NonSSS
	{
	}

	// Group of search engines (or other groups).
	// (SearchEngineType: Group)
	export class SearchEngine_Group extends SearchEngine_NonSSS
	{
		enginesUniqueIds: string[];
		color: string;
	}

	export class Settings
	{
		// NOTE: When adding new variables, keep the same order used in the settings page, roughly divided by section.

		// Any unspecified settings go here. This is needed to support legacy variables that are now unused, like contextMenuEnginesFilter.
		[key: string]: any;

		useDarkModeInOptionsPage: boolean;

		searchEngineIconsSource: SearchEngineIconsSource;

		popupOpenBehaviour: PopupOpenBehaviour;
		middleMouseSelectionClickMargin: number;
		popupLocation: PopupLocation;
		popupDelay: number;
		minSelectedCharacters: number;
		maxSelectedCharacters: number;
		allowPopupOnEditableFields: boolean;
		hidePopupOnPageScroll: boolean;
		hidePopupOnRightClick: boolean;
		hidePopupOnSearch: boolean;
		useEngineShortcutWithoutPopup: boolean;
		mouseLeftButtonBehaviour: OpenResultBehaviour;
		mouseRightButtonBehaviour: OpenResultBehaviour;
		mouseMiddleButtonBehaviour: OpenResultBehaviour;
		shortcutBehaviour: OpenResultBehaviour;
		popupAnimationDuration: number;
		autoCopyToClipboard: AutoCopyToClipboard;
		websiteBlocklist: string;

		showSelectionTextField: boolean;
		selectionTextFieldLocation: SelectionTextFieldLocation;
		useSingleRow: boolean;
		nPopupIconsPerRow: number;
		iconAlignmentInGrid: IconAlignment;
		popupItemSize: number;
		popupSeparatorWidth: number;
		popupItemPadding: number;
		popupItemVerticalPadding: number;
		popupItemHoverBehaviour: ItemHoverBehaviour;
		popupItemBorderRadius: number;
		popupBackgroundColor: string;
		popupHighlightColor: string;
		popupPaddingX: number;
		popupPaddingY: number;
		popupOffsetX: number;
		popupOffsetY: number;
		popupBorderRadius: number;
		useCustomPopupCSS: boolean;
		customPopupCSS: string;

		enableEnginesInContextMenu: boolean;
		contextMenuItemBehaviour: OpenResultBehaviour;
		contextMenuItemRightButtonBehaviour: OpenResultBehaviour;
		contextMenuItemMiddleButtonBehaviour: OpenResultBehaviour;
		contextMenuString: string;

		searchEngines: SearchEngine[];
		searchEnginesCache: { [id: string] : string; };

		// sectionsExpansionState: { [id: string] : boolean; };
	}

	export class ActivationSettings
	{
		useEngineShortcutWithoutPopup: boolean;
		popupLocation: PopupLocation;
		popupOpenBehaviour: PopupOpenBehaviour;
		middleMouseSelectionClickMargin: number;
		popupDelay: number;
		// not a "setting", but needed info for content script
		browserVersion: number;
	}

	export class ContentScriptSettings
	{
		settings: Settings;
		sssIcons: { [id: string] : SSSIconDefinition; };
	}

	export class SSSIconDefinition
	{
		name: string;
		description: string;
		iconPath: string;
		isInteractive: boolean = true;
	}

	class SSS
	{
		settings: Settings;
		activationSettingsForContentScript: ActivationSettings;
		settingsForContentScript: ContentScriptSettings;
		blockedWebsitesCache: RegExp[];
	}

	export const enum SearchEngineType {
		SSS = "sss",
		Custom = "custom",
		BrowserLegacy = "browser",	// only kept for retrocompatibility; permanently turns into a "custom" engine after load
		BrowserSearchApi = "browser-search-api",
		Group = "group",
	}

	export const enum SearchEngineIconsSource {
		None = "none",
		FaviconKit = "favicon-kit",
	}

	export const enum PopupOpenBehaviour {
		Off = "off",
		Auto = "auto",
		Keyboard = "keyboard",
		HoldAlt = "hold-alt",
		MiddleMouse = "middle-mouse",
	}

	export const enum PopupLocation {
		Selection = "selection",
		Cursor = "cursor",
	}

	export const enum OpenResultBehaviour {
		ThisTab = "this-tab",
		NewTab = "new-tab",
		NewBgTab = "new-bg-tab",
		NewTabNextToThis = "new-tab-next",
		NewBgTabNextToThis = "new-bg-tab-next",
		NewWindow = "new-window",
		NewBgWindow = "new-bg-window",
	}

	export const enum AutoCopyToClipboard {
		Off = "off",
		Always = "always",
		NonEditableOnly = "non-editable-only",
	}

	export const enum SelectionTextFieldLocation {
		Top = "top",
		Bottom = "bottom",
	}

	export const enum IconAlignment {
		Left = "left",
		Middle = "middle",
		Right = "right",
	}

	export const enum ItemHoverBehaviour {
		Nothing = "nothing",
		Highlight = "highlight",
		HighlightAndMove = "highlight-and-move",
		Scale = "scale",
	}

	// not used anymore but needed for retrocompatibility
	const enum ContextMenuEnginesFilter {
		All = "all",
		SameAsPopup = "same-as-popup",
	}

	const sssIcons: { [id: string] : SSSIconDefinition; } = {
		copyToClipboard: {
			name: "Copy to clipboard",
			description: "[SSS] Adds a \"Copy selection to clipboard\" icon to the popup.",
			iconPath: "res/sss-engine-icons/copy.png",
			isInteractive: true,
		},
		openAsLink: {
			name: "Open as link",
			description: "[SSS] Adds an \"Open selection as link\" icon to the popup.",
			iconPath: "res/sss-engine-icons/open-link.png",
			isInteractive: true,
		},
		separator: {
			name: "Separator",
			description: "[SSS] Adds a separator.",
			iconPath: "res/sss-engine-icons/separator.png",
			isInteractive: false,
		}
	};

	let uniqueIdToEngineDictionary: { [uniqueId: number] : SearchEngine; } = {};

	// Default state of all configurable options.
	// Verified source URLs; bundled originals keep default icons sharp without network requests.
	const defaultEngineIcons: { [id: string]: { legacyUrl: string; url: string; file: string } } = {
		google: { legacyUrl: "https://www.google.com/favicon.ico", url: "https://www.gstatic.com/images/branding/product/2x/googleg_96dp.png", file: "google.png" },
		bing: { legacyUrl: "https://www.bing.com/sa/simg/favicon-2x.ico", url: "https://img.icons8.com/fluency/192/bing.png", file: "bing.png" },
		duckduckgo: { legacyUrl: "https://duckduckgo.com/favicon.ico", url: "https://duckduckgo.com/static-assets/favicons/DDG-icon_256x256.png", file: "duckduckgo.png" },
		yandex: { legacyUrl: "https://yastatic.net/iconostasis/_/8lFaTHLDzmsEZz-5XaQg9iTWZGE.png", url: "https://yastatic.net/s3/home-static/_/f0/f0597b6727cc67dceebc4e3a87caf571.png", file: "yandex.png" },
		baidu: { legacyUrl: "https://www.baidu.com/favicon.ico", url: "https://img.icons8.com/color/192/baidu.png", file: "baidu.png" },
		youtube: { legacyUrl: "https://www.youtube.com/yts/img/favicon_144-vfliLAfaB.png", url: "https://www.gstatic.com/youtube/img/branding/favicon/favicon_192x192_v2.png", file: "youtube.png" },
		imdb: { legacyUrl: "https://www.imdb.com/favicon.ico", url: "https://m.media-amazon.com/images/G/01/imdb/images/social/imdb_logo.png", file: "imdb.png" },
		wikipedia: { legacyUrl: "https://www.wikipedia.org/favicon.ico", url: "https://upload.wikimedia.org/wikipedia/commons/thumb/3/34/Wikipedia_W_-_SuperTinyIcons.svg/120px-Wikipedia_W_-_SuperTinyIcons.svg.png", file: "wikipedia.png" },
		amazon: { legacyUrl: "https://www.amazon.com/favicon.ico", url: "https://img.icons8.com/color/192/amazon.png", file: "amazon.png" },
		ebay: { legacyUrl: "https://www.ebay.com/favicon.ico", url: "https://is1-ssl.mzstatic.com/image/thumb/Purple221/v4/eb/0f/bc/eb0fbce7-3dbb-8931-2614-cd2975765fe3/AppIcon-0-0-1x_U007epad-0-1-0-85-220.png/128x128bb.png", file: "ebay.png" },
		translate: { legacyUrl: "https://translate.google.com/favicon.ico", url: "https://www.gstatic.com/images/branding/product/2x/translate_96dp.png", file: "translate.png" },
		maps: { legacyUrl: "https://www.google.com/images/branding/product/ico/maps15_bnuw3a_32dp.ico", url: "https://www.gstatic.com/images/branding/product/2x/maps_96dp.png", file: "maps.png" },
		steam: { legacyUrl: "https://store.steampowered.com/favicon.ico", url: "https://upload.wikimedia.org/wikipedia/commons/thumb/8/83/Steam_icon_logo.svg/120px-Steam_icon_logo.svg.png", file: "steam.png" },
	};

	function createDefaultIconCache(): { [url: string]: string } {
		const cache: { [url: string]: string } = {};
		for (const id of Object.keys(defaultEngineIcons)) {
			const icon = defaultEngineIcons[id];
			cache[icon.url] = browser.runtime.getURL("res/default-engine-icons/" + icon.file);
		}
		return cache;
	}

	const defaultSettings: Settings =
	{
		// NOTE: When adding new variables, keep the same order used in the settings page, roughly divided by section.

		useDarkModeInOptionsPage: false,

		searchEngineIconsSource: SearchEngineIconsSource.FaviconKit,

		popupOpenBehaviour: PopupOpenBehaviour.Auto,
		middleMouseSelectionClickMargin: 14,
		popupLocation: PopupLocation.Cursor,
		popupDelay: 0,
		minSelectedCharacters: 0,
		maxSelectedCharacters: 0,
		allowPopupOnEditableFields: false,
		hidePopupOnPageScroll: true,
		hidePopupOnRightClick: true,
		hidePopupOnSearch: true,
		useEngineShortcutWithoutPopup: false,
		mouseLeftButtonBehaviour: OpenResultBehaviour.ThisTab,
		mouseRightButtonBehaviour: OpenResultBehaviour.ThisTab,
		mouseMiddleButtonBehaviour: OpenResultBehaviour.NewBgTabNextToThis,
		shortcutBehaviour: OpenResultBehaviour.NewBgTabNextToThis,
		popupAnimationDuration: 100,
		autoCopyToClipboard: AutoCopyToClipboard.Off,
		websiteBlocklist: "",

		showSelectionTextField: true,
		selectionTextFieldLocation: SelectionTextFieldLocation.Top,
		useSingleRow: true,
		nPopupIconsPerRow: 4,
		iconAlignmentInGrid: IconAlignment.Middle,
		popupItemSize: 24,
		popupSeparatorWidth: 60,
		popupItemPadding: 2,
		popupItemVerticalPadding: 1,
		popupItemHoverBehaviour: ItemHoverBehaviour.HighlightAndMove,
		popupItemBorderRadius: 0,
		popupBackgroundColor: "#FFFFFF",
		popupHighlightColor: "#3399FF",
		popupPaddingX: 3,
		popupPaddingY: 1,
		popupOffsetX: 0,
		popupOffsetY: 0,
		popupBorderRadius: 4,
		useCustomPopupCSS: false,
		customPopupCSS: "",

		enableEnginesInContextMenu: true,
		contextMenuItemBehaviour: OpenResultBehaviour.NewTabNextToThis,
		contextMenuItemRightButtonBehaviour: OpenResultBehaviour.NewTabNextToThis,
		contextMenuItemMiddleButtonBehaviour: OpenResultBehaviour.NewBgTabNextToThis,
		contextMenuString: "Search for “%s”",
		// sectionsExpansionState: {},

		searchEngines: [

			// special engines (SearchEngine_SSS or a subclass)

			createDefaultEngine({
				type: SearchEngineType.SSS,
				id: "copyToClipboard",
				isPlainText: false,
			}),
			createDefaultEngine({
				type: SearchEngineType.SSS,
				id: "openAsLink",
			}),
			createDefaultEngine({
				type: SearchEngineType.SSS,
				id: "separator",
			}),

			// actual search engines (SearchEngine_Custom)

			createDefaultEngine({
				name: "Google",
				searchUrl: "https://www.google.com/search?q={searchTerms}",
				iconUrl: defaultEngineIcons.google.url,
			}),
			createDefaultEngine({
				name: "Bing",
				searchUrl: "https://www.bing.com/search?q={searchTerms}",
				iconUrl: defaultEngineIcons.bing.url,
				isEnabled: false,
			}),
			createDefaultEngine({
				name: "DuckDuckGo",
				searchUrl: "https://duckduckgo.com/?q={searchTerms}",
				iconUrl: defaultEngineIcons.duckduckgo.url,
			}),
			createDefaultEngine({
				name: "Yandex.ru",
				searchUrl: "https://yandex.ru/search/?text={searchTerms}",
				iconUrl: defaultEngineIcons.yandex.url,
				isEnabled: false,
			}),
			createDefaultEngine({
				name: "Baidu",
				searchUrl: "https://www.baidu.com/s?wd={searchTerms}",
				iconUrl: defaultEngineIcons.baidu.url,
				isEnabled: false,
			}),
			createDefaultEngine({
				name: "YouTube",
				searchUrl: "https://www.youtube.com/results?search_query={searchTerms}",
				iconUrl: defaultEngineIcons.youtube.url,
			}),
			createDefaultEngine({
				name: "IMDB",
				searchUrl: "https://www.imdb.com/find?s=all&q={searchTerms}",
				iconUrl: defaultEngineIcons.imdb.url,
			}),
			createDefaultEngine({
				name: "Wikipedia (en)",
				searchUrl: "https://en.wikipedia.org/wiki/Special:Search?search={searchTerms}",
				iconUrl: defaultEngineIcons.wikipedia.url,
			}),
			createDefaultEngine({
				name: "Amazon.com",
				searchUrl: "https://www.amazon.com/s?url=search-alias%3Daps&field-keywords={searchTerms}",
				iconUrl: defaultEngineIcons.amazon.url,
			}),
			// createDefaultEngine({
			// 	name: "Amazon.co.uk",
			// 	searchUrl: "https://www.amazon.co.uk/s?url=search-alias%3Daps&field-keywords={searchTerms}",
			// 	iconUrl: defaultEngineIcons.amazon.url,
			// 	isEnabled: false,
			// }),
			createDefaultEngine({
				name: "eBay.com",
				searchUrl: "https://www.ebay.com/sch/{searchTerms}",
				iconUrl: defaultEngineIcons.ebay.url,
			}),
			// createDefaultEngine({
			// 	name: "eBay.co.uk",
			// 	searchUrl: "https://www.ebay.co.uk/sch/{searchTerms}",
			// 	iconUrl: defaultEngineIcons.ebay.url,
			// 	isEnabled: false,
			// }),
			createDefaultEngine({
				name: "Translate to EN",
				searchUrl: "https://translate.google.com/?sl=auto&tl=en&op=translate&text={searchTerms}",
				iconUrl: defaultEngineIcons.translate.url,
			}),
			createDefaultEngine({
				name: "Google Maps",
				searchUrl: "https://www.google.com/maps/search/{searchTerms}",
				iconUrl: defaultEngineIcons.maps.url,
				isEnabled: false,
			}),
			createDefaultEngine({
				name: "Steam",
				searchUrl: "https://store.steampowered.com/search/?term={searchTerms}",
				iconUrl: defaultEngineIcons.steam.url,
				isEnabled: false,
			}),
			createDefaultEngine({
				name: "(Example) Search current site on Google",
				searchUrl: "https://www.google.com/search?q={searchTerms} site:{hostname}",
				iconUrl: defaultEngineIcons.google.url,
				isEnabled: false,
			}),
		],

		// Icon cache for every engine that comes active by default in SSS. Other engines' icons will automatically fill this object when they are loaded in the options page.
		searchEnginesCache: createDefaultIconCache(),
	};

	if (DEBUG) { log("Startup time is: " + new Date().toLocaleString()); }

	let isFirstLoad: boolean = true;
	let browserVersion: number = 0;
	const sss: SSS = new SSS();

	// show message on installation
	browser.runtime.onInstalled.addListener(details => {
		if (details.reason == "install") {
			browser.tabs.create({ url: "/res/msg-pages/sss-intro.html" });
		}
	});

	// Register wake-up listeners synchronously, before loading any settings.
	let ready: Promise<void>;
	const afterReady = (action: () => any) => waitForReady().then(action).catch(getErrorHandler("Background operation failed."));
	browser.runtime.onMessage.addListener((msg, sender, respond) => {
		if (!msg || msg.target === "offscreen") return;
		if (["getPopupSettings", "engineClick", "log", "getDataForSettingsPage", "runBackwardsCompatibilityUpdates", "generateUniqueEngineId"].indexOf(msg.type) < 0) return;
		waitForReady().then(() => onContentScriptMessage(msg, sender, respond)).catch(error => {
			console.warn("Message failed", error);
			respond({ error: String(error) });
		});
		return true;
	});
	browser.storage.onChanged.addListener(onSettingsChanged);
	browser.contextMenus.onClicked.addListener((info, tab) => afterReady(() => onContextMenuItemClicked(info, tab)));
	browser.commands.onCommand.addListener(command => afterReady(() => {
		if (sss.settings.popupOpenBehaviour !== PopupOpenBehaviour.Off) return onCommand(command);
	}));
	browser.webNavigation.onDOMContentLoaded.addListener(details => afterReady(() => {
		if (sss.settings.popupOpenBehaviour !== PopupOpenBehaviour.Off || sss.settings.useEngineShortcutWithoutPopup) return onDOMContentLoaded(details);
	}));
	browser.runtime.onStartup.addListener(() => afterReady(() => setup_Popup()));
	ready = initializeBackground();
	ready.catch(getErrorHandler("Error loading settings."));

	async function initializeBackground(): Promise<void> {
		browserVersion = await BrowserCompat.version();
		await onSettingsAcquired(await browser.storage.local.get() as Settings);
	}

	function waitForReady(): Promise<void> {
		const observed = ready;
		return observed.catch(() => {
			// Share one retry across concurrent wake-up events after a transient failure.
			if (ready === observed) ready = initializeBackground();
			return ready;
		});
	}

	/* ------------------------------------ */
	/* -------------- SETUP --------------- */
	/* ------------------------------------ */

	// Main SSS setup. Called when settings are acquired. Prepares everything.
	async function onSettingsAcquired(settings: Settings)
	{
		let doSaveSettings = false;

		// If settings object is empty, use defaults.
		if (settings === undefined || isObjectEmpty(settings)) {
			if (DEBUG) { log("Empty settings! Using defaults."); }
			settings = defaultSettings;	// not a copy, but we will exit this function right after
			doSaveSettings = true;
		} else if (isFirstLoad) {
			doSaveSettings = runBackwardsCompatibilityUpdates(settings);
		}

		if (doSaveSettings) {
			await browser.storage.local.set(settings);
		}

		uniqueIdToEngineDictionary = {};
		for (const engine of settings.searchEngines) {
			uniqueIdToEngineDictionary[engine.uniqueId] = engine;
		}

		// save settings and also keep subsets of them for content-script-related purposes
		sss.settings = settings;
		sss.activationSettingsForContentScript = getActivationSettingsForContentScript(settings);
		sss.settingsForContentScript = getPopupSettingsForContentScript(settings);
		sss.blockedWebsitesCache = buildBlockedWebsitesCache(settings.websiteBlocklist);

		if (isFirstLoad) {
			if (DEBUG) { log("loading ", settings); }
		}

		await setup_ContextMenu();
		setup_Popup();

		if (isFirstLoad) {
			if (DEBUG) { log("Swift Selection Search has started!"); }
			isFirstLoad = false;
		}
	}

	// small subset of settings needed for activating content scripts (no need to pass everything if the popup isn't ever called)
	function getActivationSettingsForContentScript(settings: Settings): ActivationSettings
	{
		const activationSettings = new ActivationSettings();
		activationSettings.useEngineShortcutWithoutPopup = settings.useEngineShortcutWithoutPopup;
		activationSettings.popupLocation = settings.popupLocation;
		activationSettings.popupOpenBehaviour = settings.popupOpenBehaviour;
		activationSettings.middleMouseSelectionClickMargin = settings.middleMouseSelectionClickMargin;
		activationSettings.popupDelay = settings.popupDelay;
		activationSettings.browserVersion = browserVersion;
		return activationSettings;
	}

	// settings for when a content script needs to show the popup
	function getPopupSettingsForContentScript(settings: Settings): ContentScriptSettings
	{
		const contentScriptSettings = new ContentScriptSettings();
		contentScriptSettings.settings = Object.assign({}, settings);	// shallow copy
		contentScriptSettings.settings.searchEngines = settings.searchEngines.filter(engine => engine.isEnabled && BrowserCompat.supportsEngine(engine));
		contentScriptSettings.settings.searchEnginesCache = {};
		contentScriptSettings.sssIcons = sssIcons;	// add information about special SSS icons (normally not in settings because it doesn't change)

		// get icon cache for enabled engines
		for (const engine of contentScriptSettings.settings.searchEngines)
		{
			if (engine.type !== SearchEngineType.SSS)
			{
				const iconCache: string = settings.searchEnginesCache[(engine as SearchEngine_Custom).iconUrl];
				if (iconCache) {
					contentScriptSettings.settings.searchEnginesCache[(engine as SearchEngine_Custom).iconUrl] = iconCache;
				}
			}
		}
		return contentScriptSettings;
	}

	// Builds an array of regular expressions based on the websites in the blocklist.
	// This makes it easier to just match the regex and a part of the URL later.
	function buildBlockedWebsitesCache(websitesBlocklistText: string): RegExp[]
	{
		websitesBlocklistText = websitesBlocklistText.trim();

		const websites: string[] = websitesBlocklistText.split("\n");
		const websiteRegexes: RegExp[] = [];

		for (let i = 0; i < websites.length; i++)
		{
			const website: string = websites[i].trim();
			if (website.length == 0) continue;

			let regexStr: string;

			if (website.startsWith("/") && website.endsWith("/"))
			{
				regexStr = website.substr(1, website.length-2);	// string without the / /
			}
			else if (website.includes("*"))
			{
				regexStr = escapeRegexString(website);
				regexStr = "^" + regexStr.replace("\\*", "(.*?)");	// ^ matches start of string, * are replaced by a non greedy match for "any characters"
			}
			else
			{
				regexStr = "^" + escapeRegexString(website);	// ^ matches start of string
			}

			try {
				const regex = new RegExp(regexStr);
				websiteRegexes.push(regex);
			} catch (e) {
				console.warn("[WARNING] [Swift Selection Search]\nRegex parse error in \"Website blocklist\". Problematic regex is:\n\n\t" + website + "\n\n" + e);
			}
		}

		return websiteRegexes;
	}

	function escapeRegexString(str: string): string
	{
		return str.replace(/[.*+\-?^${}()|[\]\\]/g, "\\$&"); // $& means the whole matched str
	}

	// Adds settings that were not available in older versions of SSS to the settings object.
	// For simplicity, all other code in SSS assumes that all settings exist and have a value.
	// This method ensures it, regardless of what SSS version the user last changed settings at.
	function runBackwardsCompatibilityUpdates(settings: Settings): boolean
	{
		let shouldSave: boolean = false;

		// in the comments you can see the first version of SSS where the setting was included
		if (createSettingIfNonExistent(settings, "popupItemVerticalPadding"))             shouldSave = true; // 3.1.0
		if (createSettingIfNonExistent(settings, "allowPopupOnEditableFields"))           shouldSave = true; // 3.6.0
		if (createSettingIfNonExistent(settings, "popupBorderRadius"))                    shouldSave = true; // 3.9.1
		if (createSettingIfNonExistent(settings, "popupItemBorderRadius"))                shouldSave = true; // 3.12.0
		if (createSettingIfNonExistent(settings, "minSelectedCharacters"))                shouldSave = true; // 3.13.0
		if (createSettingIfNonExistent(settings, "middleMouseSelectionClickMargin"))      shouldSave = true; // 3.14.1
		if (createSettingIfNonExistent(settings, "hidePopupOnRightClick"))                shouldSave = true; // 3.15.0
		if (createSettingIfNonExistent(settings, "popupSeparatorWidth"))                  shouldSave = true; // 3.21.0
		// if (createSettingIfNonExistent(settings, "popupOpenCommand"))                  shouldSave = true; // 3.22.0, removed in 3.48.0
		// if (createSettingIfNonExistent(settings, "popupDisableCommand"))               shouldSave = true; // 3.22.0, removed in 3.48.0
		if (createSettingIfNonExistent(settings, "iconAlignmentInGrid"))                  shouldSave = true; // 3.25.0
		if (createSettingIfNonExistent(settings, "popupDelay"))                           shouldSave = true; // 3.29.0
		if (createSettingIfNonExistent(settings, "maxSelectedCharacters"))                shouldSave = true; // 3.30.0
		if (createSettingIfNonExistent(settings, "contextMenuString"))                    shouldSave = true; // 3.32.0
		if (createSettingIfNonExistent(settings, "showSelectionTextField"))               shouldSave = true; // 3.40.0
		if (createSettingIfNonExistent(settings, "useCustomPopupCSS"))                    shouldSave = true; // 3.40.0
		if (createSettingIfNonExistent(settings, "customPopupCSS"))                       shouldSave = true; // 3.40.0
		if (createSettingIfNonExistent(settings, "selectionTextFieldLocation"))           shouldSave = true; // 3.41.0
		if (createSettingIfNonExistent(settings, "websiteBlocklist"))                     shouldSave = true; // 3.42.0
		if (createSettingIfNonExistent(settings, "useDarkModeInOptionsPage"))             shouldSave = true; // 3.43.0
		if (createSettingIfNonExistent(settings, "mouseRightButtonBehaviour"))            shouldSave = true; // 3.43.0
		if (createSettingIfNonExistent(settings, "contextMenuItemRightButtonBehaviour"))  shouldSave = true; // 3.43.0
		if (createSettingIfNonExistent(settings, "contextMenuItemMiddleButtonBehaviour")) shouldSave = true; // 3.43.0
		if (createSettingIfNonExistent(settings, "searchEngineIconsSource"))              shouldSave = true; // 3.44.0
		if (createSettingIfNonExistent(settings, "shortcutBehaviour"))                    shouldSave = true; // 3.46.0
		if (createSettingIfNonExistent(settings, "useEngineShortcutWithoutPopup"))        shouldSave = true; // 3.46.0

		// 3.7.0
		// convert old unchangeable browser-imported engines to normal ones
		for (const engine of settings.searchEngines)
		{
			if (engine.type === SearchEngineType.BrowserLegacy)
			{
				// a BrowserLegacy engine was essentially an old Custom engine with an id and iconSrc
				const customEngine = engine as SSS.SearchEngine_Custom;

				if (customEngine.iconUrl === undefined) {
					customEngine.iconUrl = customEngine["iconSrc"];
					delete customEngine["iconSrc"];
					delete customEngine["id"];
				}

				// just say that BrowserLegacy is a Custom engine from now on, since they are equivalent at this point
				customEngine.type = SearchEngineType.Custom;	// 3.47.0 (this specific line only)
				shouldSave = true;
			}
		}

		// 3.25.0
		// add isEnabledInContextMenu to all engines
		for (const engine of settings.searchEngines)
		{
			if (engine.isEnabledInContextMenu === undefined) {
				engine.isEnabledInContextMenu = engine.type !== SearchEngineType.SSS && (engine.isEnabled || settings.contextMenuEnginesFilter === ContextMenuEnginesFilter.All);
				shouldSave = true;
			}
		}

		// 3.47.0
		for (const engine of settings.searchEngines) {
			if (engine.uniqueId === undefined) {
				engine.uniqueId = generateUniqueEngineId(engine);
				shouldSave = true;
			}
		}

		// 3.48.0
		// Settings "popupOpenCommand" and "popupDisableCommand" could be deleted now, but we are
		// keeping them in case SSS needs to be reverted to the old version for some reason.
		if (upgradeDefaultEngineIcons(settings)) shouldSave = true;

		return shouldSave;
	}

	function upgradeDefaultEngineIcons(settings: Settings): boolean
	{
		let changed = false;
		const icons = Object.keys(defaultEngineIcons).map(id => defaultEngineIcons[id]);
		for (const engine of settings.searchEngines) {
			if (engine.type !== SearchEngineType.Custom) continue;
			const custom = engine as SearchEngine_Custom;
			const original = defaultSettings.searchEngines.find(candidate => candidate.type === SearchEngineType.Custom
				&& (candidate as SearchEngine_Custom).searchUrl === custom.searchUrl) as SearchEngine_Custom;
			if (!original) continue;
			const icon = icons.find(candidate => candidate.url === original.iconUrl && candidate.legacyUrl === custom.iconUrl);
			if (icon) {
				custom.iconUrl = icon.url;
				changed = true;
			}
		}
		if (!settings.searchEnginesCache) {
			settings.searchEnginesCache = {};
			changed = true;
		}
		const bundled = createDefaultIconCache();
		for (const url of Object.keys(bundled)) {
			if (settings.searchEnginesCache[url] !== bundled[url]) {
				settings.searchEnginesCache[url] = bundled[url];
				changed = true;
			}
		}
		return changed;
	}

	function createSettingIfNonExistent(settings: Settings, settingName: string): boolean
	{
		if (settings[settingName] === undefined) {
			settings[settingName] = defaultSettings[settingName];
			return true;
		}
		return false;
	}

	// Generates a unique string ID to be used for an engine, and stores the engine in the IDs dictionary (if engine is provided).
	function generateUniqueEngineId(engine: SearchEngine = null): string
	{
		let uniqueId: string = null;
		let isUnique = false;

		// generate until unique (first try almost every time)
		while (!isUnique)
		{
			uniqueId = Math.random().toString(36).substring(2);	// substring(2) removes "0." from start
			isUnique = uniqueIdToEngineDictionary[uniqueId] === undefined;
		}

		if (engine !== null) {
			uniqueIdToEngineDictionary[uniqueId] = engine;
		}

		return uniqueId;
	}

	// whenever settings change, we re-aquire all settings and setup everything again as if just starting
	// (definitely not performant, but very robust)
	function onSettingsChanged(changes: object, area: string)
	{
		if (area !== "local" || isObjectEmpty(changes)) return;

		if (DEBUG) { log("onSettingsChanged in " + area); }
		if (DEBUG) { log(changes); }

		ready = ready.catch(() => {}).then(async () => {
			await onSettingsAcquired(await browser.storage.local.get() as Settings);
			await updateSettingsOnAllTabs();
		});
		ready.catch(getErrorHandler("Error updating settings."));
	}

	function updateSettingsOnAllTabs()
	{
		return browser.tabs.query({}).then(tabs => {
			for (const tab of tabs) {
				activateTab(tab);
			}
		}, getErrorHandler("Error querying tabs."));
	}

	function activateTab(tab: browser.tabs.Tab, frameId?: number)
	{
		browser.tabs.sendMessage(tab.id, {
			type: "activate",
			activationSettings: sss.activationSettingsForContentScript,
			isPageBlocked: isPageBlocked(tab),
		}, frameId === undefined ? {} : { frameId }).then(() => {}, () => {});	// suppress errors
	}

	function isPageBlocked(tab: browser.tabs.Tab): boolean
	{
		if (sss.blockedWebsitesCache === undefined) return false;	// can happen when reloading extension in about:debugging
		if (sss.blockedWebsitesCache.length == 0) return false;
		if (!tab.url) return false;	// tab.url is undefined if we don't have the "tabs" permission

		// NOTE: This indexOf assumes that if :// is present, it's right after the protocol, but here's a valid URL that breaks this:
		// "es:some text like http://abc.com" ("es" is the protocol used by the search tool Everything).
		const index = tab.url.indexOf("://");
		const url: string = index >= 0 ? tab.url.substr(index + 3) : tab.url;

		for (const regex of sss.blockedWebsitesCache)
		{
			if (url.match(regex)) {
				if (DEBUG) { log("regex " + regex + " matches this URL. BLOCKED " + url); }
				return true;
			}
		}

		return false;
	}

	// default error handler for promises
	function getErrorHandler(text: string): (reason: any) => void
	{
		if (DEBUG) {
			return error => { log(`${text} (${error})`); };
		} else {
			return error => console.warn(text, error);
		}
	}

	function isObjectEmpty(obj: object): boolean
	{
		for (let _ in obj) {
			return false;	// has at least one element
		}
		return true;
	}

	// act when a content script requests something from this script
	async function onContentScriptMessage(msg, sender, callbackFunc)
	{
		if (DEBUG) {
			if (msg.type !== "log") {
				log("msg.type: " + msg.type);
			}
		}

		switch (msg.type)
		{
			// messages from content script

			case "getPopupSettings":
				callbackFunc(sss.settingsForContentScript);
				break;

			case "engineClick":
				await onSearchEngineClick(msg.engine, msg.openingBehaviour, msg.selection, msg.href, null);
				callbackFunc({ ok: true });
				break;

			case "log":
				if (DEBUG) { log("[content script log]", msg.log); }
				callbackFunc({ ok: true });
				break;

			// messages from settings page

			case "getDataForSettingsPage":
				callbackFunc({
					DEBUG: DEBUG,
					browserVersion: browserVersion,
					sssIcons: sssIcons,
					defaultSettings: defaultSettings
				});
				break;

			case "runBackwardsCompatibilityUpdates":
				runBackwardsCompatibilityUpdates(msg.settings);
				callbackFunc(msg.settings);
				break;

			case "generateUniqueEngineId":
				// Generate an ID but don't provide any engine since this message happens for engines currently being created in the settings menu.
				// After the engine is created, the settings will be saved and we'll regenerate the IDs dictionary then.
				callbackFunc(generateUniqueEngineId());
				break;

			default: break;
		}
	}

	function createDefaultEngine(engine) : SearchEngine
	{
		engine.uniqueId = generateUniqueEngineId(engine);

		if (engine.type === undefined) {
			engine.type = SearchEngineType.Custom;
		}

		if (engine.isEnabled === undefined) {
			engine.isEnabled = true;
		}

		if (engine.isEnabledInContextMenu === undefined) {
			engine.isEnabledInContextMenu = engine.isEnabled;
		}

		return engine;
	}

	/* ------------------------------------ */
	/* ----------- CONTEXT MENU ----------- */
	/* ------------------------------------ */

	async function setup_ContextMenu()
	{
		// cleanup first
		await browser.contextMenus.removeAll();

		if (sss.settings.enableEnginesInContextMenu !== true) return;

		// define parent menu
		await BrowserCompat.createMenu({
			id: "sss",
			title: sss.settings.contextMenuString,
			contexts: ["selection"/* , "link" */],
			// The code in onContextMenuItemClicked already allows SSS to search by a link's text by right clicking it,
			// so uncommenting the above "link" context would magically add this feature. However, by default, SSS's
			// contextMenuString uses %s, which Firefox replaces ONLY with the currently selected text, MEANING that if you just
			// right click a link with nothing selected, the context menu would just say [Search for “%s”] with a literal %s.
			// Since this feels dumb, the feature is commented-out for now.
		});

		const engines: SearchEngine[] = sss.settings.searchEngines;

		// define sub options (one per engine)
		for (let i = 0; i < engines.length; i++)
		{
			const engine = engines[i];
			if (!engine.isEnabledInContextMenu || !BrowserCompat.supportsEngine(engine)) continue;

			const contextMenuOption = {
				id: "" + i,
				title: undefined,
				type: undefined,
				parentId: "sss",
				icons: undefined,
			};

			if (engine.type === SearchEngineType.SSS) {
				const concreteEngine = engine as SearchEngine_SSS;
				if (concreteEngine.id === "separator") {
					contextMenuOption.type = "separator";
					await BrowserCompat.createMenu(contextMenuOption);
					continue;
				}
				contextMenuOption.title = sssIcons[concreteEngine.id].name;
			} else {
				const concreteEngine = engine as SearchEngine_Custom;
				contextMenuOption.title = concreteEngine.name;
			}

			let icon: string;

			if (engine.type === SearchEngineType.SSS) {
				const concreteEngine = engine as SearchEngine_SSS;
				icon = sssIcons[concreteEngine.id].iconPath;
			}
			else {
				const iconUrl: string = (engine as SearchEngine_NonSSS).iconUrl;

				if (iconUrl.startsWith("data:")) {
					icon = iconUrl;
				} else {
					icon = sss.settings.searchEnginesCache[iconUrl];
					if (icon === undefined) {
						icon = iconUrl;
					}
				}
			}

			contextMenuOption.icons = { "32": icon };

			contextMenuOption.id = "" + i;
			await BrowserCompat.createMenu(contextMenuOption);
		}

	}

	function onContextMenuItemClicked(info: browser.contextMenus.OnClickData, tab: browser.tabs.Tab)
	{
		const menuId: number = parseInt(info.menuItemId as string);
		const selectedEngine: SearchEngine = sss.settings.searchEngines[menuId];
		const button = info?.button ?? 0;
		return onSearchEngineClick(selectedEngine, getOpenResultBehaviourForContextMenu(button), info.selectionText ?? info.linkText, info.pageUrl, info.linkText);
	}

	function getOpenResultBehaviourForContextMenu(button: number)
	{
		if (button === 0) return sss.settings.contextMenuItemBehaviour;
		if (button === 1) return sss.settings.contextMenuItemMiddleButtonBehaviour;
		/* if (button === 2)  */return sss.settings.contextMenuItemRightButtonBehaviour;
	}

	/* ------------------------------------ */
	/* ------------ SHORTCUTS ------------- */
	/* ------------------------------------ */

	function onCommand(command: string)
	{
		switch (command)
		{
			case "open-popup":        return onOpenPopupCommand();
			case "toggle-auto-popup": return onToggleAutoPopupCommand();
		}
	}

	function onOpenPopupCommand()
	{
		if (DEBUG) { log("open-popup"); }
		return getActiveTab().then(tab => browser.tabs.sendMessage(tab.id, { type: "showPopup" }));
	}

	function onToggleAutoPopupCommand()
	{
		if (DEBUG) { log("toggle-auto-popup, sss.settings.popupOpenBehaviour: " + sss.settings.popupOpenBehaviour); }

		// toggles value between Auto and Keyboard
		if (sss.settings.popupOpenBehaviour === PopupOpenBehaviour.Auto) {
			return browser.storage.local.set({ popupOpenBehaviour: PopupOpenBehaviour.Keyboard });
		} else if (sss.settings.popupOpenBehaviour === PopupOpenBehaviour.Keyboard) {
			return browser.storage.local.set({ popupOpenBehaviour: PopupOpenBehaviour.Auto });
		}
	}

	/* ------------------------------------ */
	/* -------------- POPUP --------------- */
	/* ------------------------------------ */

	function setup_Popup()
	{
		// If the user has set the option to always use the engine shortcuts, we inject the script
		// even if the opening behaviour of the popup is set to Off (never).
		if (sss.settings.popupOpenBehaviour !== PopupOpenBehaviour.Off || sss.settings.useEngineShortcutWithoutPopup) {
			// register page load event and try to add the content script to all open pages
			return browser.tabs.query({}).then(installOnOpenTabs, getErrorHandler("Error querying tabs."));
		}
	}

	function onDOMContentLoaded(details)
	{
		return injectContentScript(details.tabId, details.frameId, false);
	}

	function installOnOpenTabs(tabs: browser.tabs.Tab[])
	{
		if (DEBUG) { log("installOnOpenTabs"); }

		for (const tab of tabs) {
			injectContentScriptIfNeeded(tab.id, undefined, true);	// inject on all frames if possible
		}
	}

	function injectContentScriptIfNeeded(tabId: number, frameId?: number, allFrames: boolean = false)
	{
		// try sending message to see if content script exists. if it errors then inject it
		browser.tabs.sendMessage(tabId, { type: "isAlive" }, frameId === undefined ? {} : { frameId }).then(
			msg => {
				if (msg === undefined) {
					injectContentScript(tabId, frameId, allFrames);
				}
			},
			() => injectContentScript(tabId, frameId, allFrames)
		);
	}

	function injectContentScript(tabId: number, frameId?: number, allFrames: boolean = false)
	{
		return BrowserCompat.inject(tabId, frameId, allFrames)
			.then(frames => browser.tabs.get(tabId).then(tab => {
				if (frames === undefined) activateTab(tab, frameId);
				else for (const injectedFrame of frames) activateTab(tab, injectedFrame);
			}))
			.catch(getErrorHandler("Page does not allow content-script injection."));
	}

	/* ------------------------------------ */
	/* ---------- ENGINE CLICKS ----------- */
	/* ------------------------------------ */

	async function onSearchEngineClick(
		selectedEngine: SearchEngine,
		openingBehaviour: OpenResultBehaviour,
		searchText: string,
		href: string,
		linkText: string)
	{
		if (!selectedEngine || typeof searchText !== "string" || !searchText.trim()) return;
		// Check if it's a special SSS engine (engine groups never contain these).

		if (selectedEngine.type === SearchEngineType.SSS)
		{
			const engine_SSS = selectedEngine as SearchEngine_SSS;

			if (engine_SSS.id === "copyToClipboard") {
				// Only assume link if the searchText is the link text.
				// This prioritizes selection over link (since it shows on the "%s" part of the SSS context menu and causes confusion).
				if (searchText === linkText) {
					await BrowserCompat.copyText(linkText);
				} else {
					await copyToClipboard(selectedEngine as SearchEngine_SSS_Copy);
				}
			}
			else if (engine_SSS.id === "openAsLink") {
				const url: string = getOpenAsLinkSearchUrl(searchText);
				await createTabForSearch(openingBehaviour, 0, url);
				if (DEBUG) { log("open as link: " + url); }
			}

			return;
		}

		// Prepare a list of all engines to search (even if only one).

		let engines: SearchEngine[];

		if (selectedEngine.type === SearchEngineType.Group)
		{
			const visiting = new Set<SearchEngine_Group>();
			// Ignore missing references and cycles in imported groups.
			function fillWithGroupEngines(expandedEngines: SearchEngine[], groupEngine: SearchEngine_Group)
			{
				if (visiting.has(groupEngine)) return;
				visiting.add(groupEngine);
				for (const engineId of (groupEngine as SearchEngine_Group).enginesUniqueIds)
				{
					const engine = uniqueIdToEngineDictionary[engineId];
					if (!BrowserCompat.supportsEngine(engine)) continue;
					if (engine.type === SearchEngineType.Group) {
						fillWithGroupEngines(expandedEngines, engine as SearchEngine_Group);
					} else {
						expandedEngines.push(engine);
					}
				}
				visiting.delete(groupEngine);
			}

			engines = [];
			fillWithGroupEngines(engines, selectedEngine as SearchEngine_Group);
		}
		else
		{
			engines = BrowserCompat.supportsEngine(selectedEngine) ? [selectedEngine] : [];
		}

		// Go through all engines in the list and search using each of them.

		let tabIndexOffset: number = 0;

		for (let i = 0; i < engines.length; i++)
		{
			const engine = engines[i];

			// For the second engine in the group onward, we change the opening behaviour
			// so that the engines open after the first in a way that makes sense.
			if (i == 1)
			{
				switch (openingBehaviour)
				{
					case OpenResultBehaviour.ThisTab:            openingBehaviour = OpenResultBehaviour.NewBgTabNextToThis; break;
					case OpenResultBehaviour.NewTab:             openingBehaviour = OpenResultBehaviour.NewBgTab; break;
					case OpenResultBehaviour.NewBgTab:           break;
					case OpenResultBehaviour.NewTabNextToThis:   openingBehaviour = OpenResultBehaviour.NewBgTabNextToThis; break;
					case OpenResultBehaviour.NewBgTabNextToThis: break;
					case OpenResultBehaviour.NewWindow:          openingBehaviour = OpenResultBehaviour.NewBgTabNextToThis; break;
					case OpenResultBehaviour.NewBgWindow:        openingBehaviour = OpenResultBehaviour.NewBgTabNextToThis; break;
				}
			}

			// check if it's a custom engine
			if (engine.type === SearchEngineType.Custom)
			{
				const engine_Custom = engine as SearchEngine_Custom;
				let openingBehaviourBeforeDiscard: OpenResultBehaviour;

				if (engine_Custom.discardOnOpen) {
					// To be able to discard we need to open the URL in a new tab, regardless of opening behaviour choice.
					// We'll discard the tab when it finishes opening the search.
					openingBehaviourBeforeDiscard = openingBehaviour;
					openingBehaviour = OpenResultBehaviour.NewBgTabNextToThis;
				}

				const query = getSearchQuery(engine_Custom, searchText, new URL(href));
				const tab: browser.tabs.Tab = await createTabForSearch(openingBehaviour, tabIndexOffset, query);

				if (engine_Custom.discardOnOpen) {
					// We wanted to have a way to know that the browser has already changed the URL by this point
					// (especially if for non-http schemes like es:{searchTerms} for the Everything application),
					// in order to close the tab, but sadly that's unknown at the moment.
					// Instead we (UGLYYYY) wait 50ms for the search to hopefully be started.
					await new Promise(finish => setTimeout(finish, 50));
					await browser.tabs.remove(tab.id);

					// Return to normal opening behaviour after discard.
					openingBehaviour = openingBehaviourBeforeDiscard;

					// If opening behaviour was set to NewBgTabNextToThis, the offset will be increased at the end
					// of this iteration, but we removed the tab, so we counter that increase here.
					if (openingBehaviour === OpenResultBehaviour.NewBgTabNextToThis) tabIndexOffset--;
				}
			}
			// check if it's a browser-managed engine
			else if (engine.type === SearchEngineType.BrowserSearchApi)
			{
				const engine_BrowserSearchApi = engine as SearchEngine_BrowserSearchApi;

				// NOTE: Ideally, above we'd like to create a new empty tab with createTabForSearch, and then always
				// call browser.search.search() on that tab.id, which would magically support every opening behaviour.
				// However, life is sad and another addon can modify the "new tab" page. That would cause a race
				// condition with this code when it tries to load the search URL. Only one or the other would work.

				// Because of that, we comment this out and resort to the old way that only supports ThisTab or NewTab.
				// const tab: browser.tabs.Tab = await getTabForSearch(openingBehaviour, tabIndexOffset);

				const tab: browser.tabs.Tab = await getActiveTab();

				await browser.search.search({
					engine: engine_BrowserSearchApi.name,
					query: cleanSearchText(searchText),
					// we want all open behaviours that are not "ThisTab" to open in another tab
					tabId: openingBehaviour === OpenResultBehaviour.ThisTab ? tab.id : undefined,
					// tabId: tab.id	// could be simply this if it wasn't for the big explanation above
				});
			}

			// if we've just opened a background tab next to the active one, make sure subsequent tabs open further away each time
			if (openingBehaviour === OpenResultBehaviour.NewBgTabNextToThis) tabIndexOffset++;
		}
	}

	function copyToClipboard(engine: SearchEngine_SSS_Copy)
	{
		if (engine.isPlainText) {
			return copyToClipboardAsPlainText();
		} else {
			return copyToClipboardAsHtml();
		}
	}

	function copyToClipboardAsHtml()
	{
		return getActiveTab().then(tab => browser.tabs.sendMessage(tab.id, { type: "copyToClipboardAsHtml" }));
	}

	function copyToClipboardAsPlainText()
	{
		return getActiveTab().then(tab => browser.tabs.sendMessage(tab.id, { type: "copyToClipboardAsPlainText" }));
	}

	function getOpenAsLinkSearchUrl(link: string): string
	{
		// trim text and add http protocol as default if selected text doesn't have it
		link = link.trim();

		if (!link.includes("://") && !link.startsWith("about:")) {
			link = "http://" + link;
		}

		return link;
	}

	function cleanSearchText(searchText: string): string
	{
		return searchText.trim().replace("\r\n", " ").replace("\n", " ");
	}

	// gets the complete search URL by applying the selected text to the engine's own searchUrl
	function getSearchQuery(engine: SearchEngine_Custom, searchText: string, url: URL): string
	{
		searchText = cleanSearchText(searchText);

		const hasCustomEncoding = engine.encoding && engine.encoding !== "utf8";
		if (hasCustomEncoding) {
			// encode to bytes, then convert bytes to hex and add % before each pair of characters (so it can be used in the URL)
			const buffer = iconv.encode(searchText, engine.encoding);
			searchText = "%" + buffer.toString("hex").toUpperCase().replace(/([A-Z0-9]{2})\B/g, "$1%");
		}

		let query = engine.searchUrl;

		// https://developer.mozilla.org/en-US/docs/Web/API/URL#Properties
		// NOTE: regex "i" flag ignores case
		if (/\{hash/i.test(query))     { query = SearchVariables.modifySearchVariable(query, "hash",     url.hash,     false); }
		if (/\{hostname/i.test(query)) { query = SearchVariables.modifySearchVariable(query, "hostname", url.hostname, false); }	// must be replaced before "host"
		if (/\{host/i.test(query))     { query = SearchVariables.modifySearchVariable(query, "host",     url.host,     false); }
		if (/\{href/i.test(query))     { query = SearchVariables.modifySearchVariable(query, "href",     url.href,     false); }
		if (/\{origin/i.test(query))   { query = SearchVariables.modifySearchVariable(query, "origin",   url.origin,   false); }
		if (/\{password/i.test(query)) { query = SearchVariables.modifySearchVariable(query, "password", url.password, false); }
		if (/\{pathname/i.test(query)) { query = SearchVariables.modifySearchVariable(query, "pathname", url.pathname, false); }
		if (/\{port/i.test(query))     { query = SearchVariables.modifySearchVariable(query, "port",     url.port,     false); }
		if (/\{protocol/i.test(query)) { query = SearchVariables.modifySearchVariable(query, "protocol", url.protocol, false); }
		if (/\{search/i.test(query))   { query = SearchVariables.modifySearchVariable(query, "search",   url.search,   false); }
		if (/\{username/i.test(query)) { query = SearchVariables.modifySearchVariable(query, "username", url.username, false); }

		query = SearchVariables.modifySearchVariable(query, "searchTerms", searchText, !hasCustomEncoding);

		return query;
	}

	// Creates/reuses a tab based on the opening behaviour, to be used for a search (the search is done automatically if searchUrl is not null).
	async function createTabForSearch(openingBehaviour: OpenResultBehaviour, tabIndexOffset: number, searchUrl: string = null): Promise<browser.tabs.Tab>
	{
		const tab: browser.tabs.Tab = await getActiveTab();

		const lastTabIndex: number = 9999;	// "guarantees" tab opens as last for some behaviours
		const options: object = {};

		if (searchUrl !== null) {
			options["url"] = searchUrl
		}

		if (openingBehaviour !== OpenResultBehaviour.ThisTab
		 && openingBehaviour !== OpenResultBehaviour.NewWindow
		 && openingBehaviour !== OpenResultBehaviour.NewBgWindow)
		{
			options["openerTabId"] = tab.id;	// This makes tabs "children" of other tabs, which is useful for tab managing addons like Tree Style Tab.
		}

		switch (openingBehaviour)
		{
			case OpenResultBehaviour.ThisTab:
				if (searchUrl !== null) {
					await browser.tabs.update(tab.id, options);
				}
				return tab;	// doesn't actually create a tab, just returns the active one

			case OpenResultBehaviour.NewTab:
				options["index"] = lastTabIndex + 1;
				return browser.tabs.create(options);

			case OpenResultBehaviour.NewBgTab:
				options["index"] = lastTabIndex + 1;
				options["active"] = false;
				return browser.tabs.create(options);

			case OpenResultBehaviour.NewTabNextToThis:
				options["index"] = tab.index + 1 + tabIndexOffset;
				return browser.tabs.create(options);

			case OpenResultBehaviour.NewBgTabNextToThis:
				options["index"] = tab.index + 1 + tabIndexOffset;
				options["active"] = false;
				return browser.tabs.create(options);

			case OpenResultBehaviour.NewWindow:
				return browser.windows.create(options).then(window => window.tabs[0]);

			case OpenResultBehaviour.NewBgWindow:
				// options["focused"] = false;	// fails because it's unsupported by Firefox
				return browser.windows.create(options).then(window => window.tabs[0]);
		}
	}

	function getActiveTab(): Promise<browser.tabs.Tab>
	{
		return browser.tabs.query({currentWindow: true, active: true}).then(tabs => tabs[0]);
	}
}
