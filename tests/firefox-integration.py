"""Smoke-test the actual Firefox MV2 build (the security harness mocks background APIs)."""
import argparse
import json
from pathlib import Path
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import zipfile

from selenium import webdriver
from selenium.webdriver import ActionChains
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.firefox.service import Service
from selenium.webdriver.support.ui import WebDriverWait

ROOT = Path(__file__).resolve().parents[1]
requests = []


class Fixture(BaseHTTPRequestHandler):
    def do_GET(self):
        requests.append(self.path)
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Security-Policy', "default-src 'none'; style-src 'none'; img-src data:")
        self.end_headers()
        self.wfile.write(b'<!doctype html><title>Firefox fixture</title><p><span id="selection">Firefox selection</span></p>')

    def log_message(self, *args):
        pass


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--firefox', required=True)
    parser.add_argument('--geckodriver', required=True)
    args = parser.parse_args()
    build = ROOT / 'dist/firefox'
    manifest = json.loads((build / 'manifest.json').read_text())
    assert manifest['manifest_version'] == 2
    extension_id = manifest['applications']['gecko']['id']
    uuid = 'ab2de731-4ea0-4cd7-9e8b-f30a277a0a22'
    server = ThreadingHTTPServer(('127.0.0.1', 0), Fixture)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = f'http://127.0.0.1:{server.server_port}'
    try:
        with tempfile.TemporaryDirectory(prefix='sss-firefox-') as temp:
            addon = Path(temp) / 'extension.xpi'
            with zipfile.ZipFile(addon, 'w') as archive:
                for file in build.rglob('*'):
                    if file.is_file():
                        archive.write(file, file.relative_to(build).as_posix())
            options = Options()
            options.binary_location = args.firefox
            options.add_argument('-headless')
            options.set_preference('extensions.webextensions.uuids', json.dumps({extension_id: uuid}))
            with webdriver.Firefox(options=options, service=Service(args.geckodriver, service_args=['--allow-system-access'])) as driver:
                driver.install_addon(str(addon), temporary=True)
                driver.switch_to.new_window('tab')
                with driver.context(driver.CONTEXT_CHROME):
                    addon_url = driver.execute_script("return WebExtensionPolicy.getByID(arguments[0]).getURL('settings/settings.html');", extension_id)
                    driver.execute_script("gBrowser.selectedBrowser.loadURI(Services.io.newURI(arguments[0]), {triggeringPrincipal:Services.scriptSecurityManager.getSystemPrincipal()});", addon_url)
                wait = WebDriverWait(driver, 20)
                wait.until(lambda d: d.execute_script("return document.querySelector('#engines')?.children.length > 0 && getComputedStyle(document.body).display !== 'none'"))
                print('PASS: actual Firefox MV2 background and options initialize')
                config = {'popupDelay': 0, 'popupAnimationDuration': 0, 'shortcutBehaviour': 'new-bg-tab',
                          'searchEngines': [{'type': 'custom', 'uniqueId': 'local', 'name': 'Local', 'shortcut': 'G',
                                             'searchUrl': origin + '/search?q={searchTerms}', 'iconUrl': '',
                                             'isEnabled': True, 'isEnabledInContextMenu': True}]}
                driver.execute_async_script("const done=arguments[arguments.length-1];browser.storage.local.set(arguments[0]).then(()=>browser.runtime.sendMessage({type:'getPopupSettings'})).then(done);", config)
                driver.get(origin)
                wait.until(lambda d: d.find_element(By.ID, 'selection'))
                ActionChains(driver).double_click(driver.find_element(By.ID, 'selection')).perform()
                wait.until(lambda d: d.execute_script("return !!document.querySelector('sss-popup')"))
                print('PASS: actual Firefox content script creates popup under strict CSP')
                ActionChains(driver).send_keys('g').perform()
                wait.until(lambda _: any(url.startswith('/search?q=') for url in requests))
                print('PASS: actual Firefox trusted shortcut executes a custom search')
    finally:
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
    main()
