"""Firefox regressions for SSS-01/02 using real content scripts in a temporary add-on.

Run `npm ci && npx tsc`, install Python selenium, then:
    python tests/security-firefox.py --geckodriver PATH --firefox PATH
The background runtime is mocked: searches and clipboard writes are recorded,
never sent externally. Firefox uses a disposable profile and a loopback fixture.
"""
import argparse
import json
from pathlib import Path
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import zipfile

from selenium import webdriver
from selenium.webdriver import ActionChains
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.firefox.service import Service
from selenium.webdriver.support.ui import WebDriverWait

ROOT = Path(__file__).resolve().parents[1]
CSP = "default-src 'none'; script-src 'self'; style-src 'none'; img-src data:"
SETTINGS = {
    "popupOpenBehaviour": "auto", "popupLocation": "selection", "popupDelay": 0,
    "useEngineShortcutWithoutPopup": True, "middleMouseSelectionClickMargin": 14,
    "minSelectedCharacters": 0, "maxSelectedCharacters": 0,
    "allowPopupOnEditableFields": False, "hidePopupOnSearch": False,
    "showSelectionTextField": False, "autoCopyToClipboard": "always",
    "popupAnimationDuration": 0, "useSingleRow": True, "popupItemSize": 24,
    "popupItemPadding": 2, "popupItemVerticalPadding": 1, "popupItemBorderRadius": 0,
    "popupBackgroundColor": "#FFFFFF", "popupHighlightColor": "#3399FF",
    "popupBorderRadius": 4, "popupPaddingX": 3, "popupPaddingY": 1,
    "popupOffsetX": 0, "popupOffsetY": 0, "popupSeparatorWidth": 60,
    "shortcutBehaviour": "new-bg-tab", "mouseLeftButtonBehaviour": "new-bg-tab",
    "mouseMiddleButtonBehaviour": "new-bg-tab", "mouseRightButtonBehaviour": "new-bg-tab",
    "searchEnginesCache": {}, "searchEngines": [{
        "type": "custom", "name": "Local test", "shortcut": "G",
        "searchUrl": "https://example.invalid/?q={searchTerms}",
        "iconUrl": "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24'/>",
    }],
}


def make_addon(path):
    # A lexical browser mock leaves DOM/event handling and stylesheet loading real.
    bootstrap = """
(function(realBrowser) {
const settings = SETTINGS_JSON;
const params = new URL(location.href).searchParams;
settings.popupOpenBehaviour = params.get('mode') || 'auto';
settings.showSelectionTextField = params.has('focus');
settings.useEngineShortcutWithoutPopup = params.get('always') !== 'false';
settings.useCustomPopupCSS = true;
settings.customPopupCSS = params.has('invalid') ? '} } invalid' :
    '@media all { .sss-content { background-color: rgb(12, 34, 56); } }' +
    '@supports (display: grid) { .sss-content { border-top: 3px solid black; } }' +
    '@keyframes sss-test { from { opacity: 0; } to { opacity: 1; } }' +
    '@font-face { font-family: SSSTest; src: local(Arial); }';
let receive, searches = 0, copies = 0;
const browser = {runtime: {
    getURL: path => realBrowser.runtime.getURL(path),
    onMessage: {addListener: fn => receive = fn},
    sendMessage: msg => {
        if (msg.type === 'engineClick') searches++;
        return Promise.resolve({settings, sssIcons: {}});
    }
}};
document.execCommand = () => { copies++; return true; };
""".replace("SETTINGS_JSON", json.dumps(SETTINGS))
    scripts = "\n".join((ROOT / "src/content-scripts" / name).read_text(encoding="utf-8")
                        for name in ["selectionchange.js", "page-script.js"])
    harness = """
receive({type:'activate', activationSettings: {...settings, browserVersion: 140}, isPageBlocked:false});
document.addEventListener('sss-test-command', () => {
    if (document.body.dataset.command === 'force') {
        receive({type:'showPopup'});
        return;
    }
    const popup = document.querySelector('sss-popup');
    if (popup) popup.enginesContainer.firstChild.dispatchEvent(new MouseEvent('mouseup', {button:0}));
});
setInterval(() => {
    const popup = document.querySelector('sss-popup');
    let state = {searches, copies, popup: !!popup};
    if (popup) {
        const style = getComputedStyle(popup.content);
        const icon = popup.enginesContainer.firstChild.getBoundingClientRect();
        Object.assign(state, {shown:popup.isShown(), background:style.backgroundColor,
            focused:!!popup.inputField && popup.inputField.matches(':focus'),
            customRules: Array.from(popup.popupStyle.sheet?.cssRules || []).flatMap(
                group => Array.from(group.cssRules || []).map(rule => rule.type)),
            position:style.position, visibility:style.visibility, width:parseFloat(getComputedStyle(popup.enginesContainer.firstChild).width),
            x:icon.x + icon.width / 2, y:icon.y + icon.height / 2});
    }
    document.body.dataset.sssState = JSON.stringify(state);
}, 20);
})(browser);
"""
    manifest = {
        "manifest_version": 2, "name": "SSS security regression", "version": "1.0",
        "browser_specific_settings": {"gecko": {"id": "sss-regression@example.invalid"}},
        "web_accessible_resources": ["content-scripts/popup.css"],
        "content_scripts": [{"matches": ["http://127.0.0.1/*"], "js": ["test.js"]}],
    }
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("manifest.json", json.dumps(manifest))
        archive.writestr("test.js", bootstrap + scripts + harness)
        archive.write(ROOT / "src/content-scripts/popup.css", "content-scripts/popup.css")


class Fixture(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Security-Policy", CSP)
        self.end_headers()
        self.wfile.write(b"<html><body><p id='text'>Selection regression</p>"
                         b"<div id='probe'>CSP probe</div></body></html>")

    def log_message(self, *_args):
        pass


def state(driver):
    return driver.execute_script("return JSON.parse(document.body.dataset.sssState || 'null')")


def wait_for(driver, predicate):
    try:
        return WebDriverWait(driver, 5).until(lambda d: (s := state(d)) and predicate(s) and s)
    except Exception:
        print('Last fixture state:', state(driver))
        raise


def synthetic_selection(driver):
    driver.execute_script("""
const text = document.getElementById('text');
let range = document.createRange(); range.selectNodeContents(text);
getSelection().removeAllRanges(); getSelection().addRange(range);
for (const type of ['keydown','mouseup','input','mousedown']) {
    let ev = type === 'keydown' ? new KeyboardEvent(type,{key:'g',keyCode:71,bubbles:true}) :
        type === 'input' ? new Event(type,{bubbles:true}) : new MouseEvent(type,{button:type==='mousedown'?1:0,bubbles:true});
    text.dispatchEvent(ev);
}
for (const init of [{key:'a',keyCode:65,ctrlKey:true},
                    {key:'ArrowRight',keyCode:39,shiftKey:true}, {key:'Enter',keyCode:13}]) {
    text.dispatchEvent(new KeyboardEvent('keydown', {...init,bubbles:true}));
}
const fake = new Event('customselectionchange');
fake.event = {isTrusted:true}; document.dispatchEvent(fake);
const notification = new Event('customselectionchange');
notification.event = new MouseEvent('mouseup'); document.dispatchEvent(notification);
const inherited = new Event('customselectionchange');
inherited.event = Object.create(Event.prototype, {isTrusted:{value:true}});
document.dispatchEvent(inherited);
""")
    # Synchronize past both delayed selection notifications and state publication.
    driver.execute_async_script("setTimeout(arguments[arguments.length-1], 150)")


def test_mode(driver, url, mode, always=True, invalid=False):
    driver.get(f"{url}/?mode={mode}&always={str(always).lower()}" + ("&invalid=1" if invalid else ""))
    wait_for(driver, lambda s: True)
    synthetic_selection(driver)
    assert state(driver) == {"searches": 0, "copies": 0, "popup": False}, state(driver)
    if mode == "off":
        ActionChains(driver).send_keys('g').perform()
        wait_for(driver, lambda s: s['searches'] == 1)
        print("PASS: synthetic events blocked and trusted shortcut works with popup off")
        return
    paragraph = driver.find_element('id', 'text')
    if mode == "middle-mouse":
        # The existing selection was made by the fixture; the opening click is native.
        actions = ActionChains(driver)
        rect = driver.execute_script("let r=getSelection().getRangeAt(0).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}")
        actions.w3c_actions.pointer_action.move_to_location(int(rect['x']), int(rect['y']))
        actions.w3c_actions.pointer_action.click(button=1)
        actions.perform()
    else:
        ActionChains(driver).double_click(paragraph).perform()
    s = wait_for(driver, lambda s: s.get('shown') and s.get('visibility') == 'visible' and s.get('width') == 24)
    assert s['copies'] >= 1, s
    assert s['position'] == 'absolute', s
    assert s['background'] == ('rgb(255, 255, 255)' if invalid else 'rgb(12, 34, 56)'), s
    if not invalid:
        assert {5, 7, 12} <= set(s['customRules']), s  # font-face, keyframes, supports
    baseline = s['searches']
    copy_baseline = s['copies']
    synthetic_selection(driver)
    driver.execute_script("document.dispatchEvent(new Event('sss-test-command'))")
    driver.execute_async_script("setTimeout(arguments[arguments.length-1], 100)")
    assert state(driver)['searches'] == baseline, state(driver)
    assert state(driver)['copies'] == copy_baseline, state(driver)
    ActionChains(driver).send_keys('g').perform()
    wait_for(driver, lambda s: s['searches'] == baseline + 1)
    # Native pointer actions reach the icon inside the closed shadow root.
    for button in [0, 1, 2]:
        s = state(driver)
        actions = ActionChains(driver)
        actions.w3c_actions.pointer_action.move_to_location(int(s['x']), int(s['y']))
        actions.w3c_actions.pointer_action.click(button=button)
        actions.perform()
        baseline += 1
        wait_for(driver, lambda s: s['searches'] == baseline + 1)
    driver.execute_script("let style=document.createElement('style');style.textContent='#probe {color: rgb(255, 0, 0)}';document.head.append(style)")
    assert driver.execute_script("return getComputedStyle(document.getElementById('probe')).color") != 'rgb(255, 0, 0)'
    print(f"PASS: {mode}, always={always}, invalidCSS={invalid}: native selection/search, synthetic rejection, strict CSP styling")


def test_forced_focus(driver, url):
    driver.get(f"{url}/?mode=keyboard&always=false&focus=1")
    wait_for(driver, lambda s: True)
    synthetic_selection(driver)
    driver.execute_script("document.body.dataset.command='force'; document.dispatchEvent(new Event('sss-test-command'))")
    wait_for(driver, lambda s: s.get('shown') and s.get('visibility') == 'visible' and s.get('focused'))
    print("PASS: initial forced popup focuses its text input after stylesheet load")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--firefox', help='Firefox binary path')
    parser.add_argument('--geckodriver', help='Geckodriver executable path (otherwise Selenium Manager)')
    args = parser.parse_args()
    manifest = json.loads((ROOT / 'src/manifest.json').read_text(encoding='utf-8'))
    assert not {'webRequest', 'webRequestBlocking'} & set(manifest['permissions'])
    assert 'modifyCSPRequest' not in (ROOT / 'src/swift-selection-search.ts').read_text(encoding='utf-8')
    server = ThreadingHTTPServer(('127.0.0.1', 0), Fixture)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        with tempfile.TemporaryDirectory(prefix='sss-security-') as temp:
            addon = Path(temp) / 'regression.xpi'
            make_addon(addon)
            options = Options()
            options.add_argument('-headless')
            if args.firefox:
                options.binary_location = args.firefox
            service = Service(args.geckodriver) if args.geckodriver else Service()
            with webdriver.Firefox(options=options, service=service) as driver:
                driver.install_addon(str(addon), temporary=True)
                url = f'http://127.0.0.1:{server.server_port}'
                for mode, always, invalid in [('off', True, False), ('auto', True, False),
                                              ('auto', False, False), ('middle-mouse', True, False),
                                              ('auto', True, True)]:
                    test_mode(driver, url, mode, always, invalid)
                test_forced_focus(driver, url)
    finally:
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
    main()
