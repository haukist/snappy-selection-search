# Chrome support validation

Target: Windows Chrome Stable. The development check on 2026-11-07 used installed
Chrome 156.0.8078.81, a disposable profile, and the ZIP extracted into a fresh
directory. Search fixtures run on loopback; tests do not submit searches to public
search engines. Browser profiles and unpacked test copies are removed after a run.

## Automated checks

- `npm test`: existing search-variable examples, initialization before storage is
  ready, concurrent settings requests, settings/menu update serialization, worker
  recreation, URL substitutions, Shift JIS encoding, preservation/exclusion of
  Firefox-only engines, cyclic/missing group references, empty searches/groups,
  context-menu dispatch, denied injection, recovery after failed initial/updated
  settings reads, clipboard document ownership, queue recovery and immutable menu
  arguments.
- Both browser builds type-check the project and emit TypeScript with const enums
  resolved across files. Chrome packaging checks and loads the extracted ZIP.
- `npm run test:chrome`: real options startup, imported-engine labels, custom and
  group searches, trusted selection/click/shortcut input, synthetic-event rejection,
  strict CSP and ordinary pages, iframe and reload behavior, actual JSON backup
  download/import, offscreen clipboard copy/paste, content-script copy/paste, and
  seven result-opening modes. The worker-stop check observes a stopped extension
  worker through CDP before sending the first settings request and search. No
  worker DevTools frontend is opened. Results are in `test-results/chrome.json`.
- `tests/security-firefox.py`: six passing real-Firefox DOM/event/CSP scenarios
  with mocked background APIs, including trusted-input security regression checks.
- `tests/firefox-integration.py`: actual MV2 build/background/options startup,
  popup creation under strict CSP, and trusted shortcut executing a local search.

## Remaining manual checks

The native Chrome context menu is created successfully during integration tests,
and its event dispatch is covered with a background API mock. An actual native
menu click remains unverified: Windows Computer Use stopped because it could not
determine the current browser URL confidently enough to enforce policy. The test
can pause for that click when `SSS_NATIVE_MENU=1`; choose the extension's **Local**
menu entry, then let the local search assertion finish.

Only current installed Windows Stable was tested. Chrome 116 is the manifest API
floor (`runtime.getContexts`); compatibility with every intermediate release is
not claimed. Store submission, signed Firefox distribution and public publication
are outside this work.

## Independent review

Gemini 3.8 Flash (Medium), through the `gemini-code-review` skill and agy CLI,
reviewed all 17 implementation files against the original `master`, then reviewed
the recovery changes against the first implementation commit. New files were
included by committing them before comparison; no implementation files were
excluded as untracked.

Confirmed improvements: recover from rejected settings initialization/update
chains, serialize retries, preserve clipboard-document ownership, copy menu
arguments before removing Chrome-unsupported properties, and safely inspect key
event targets. Regression tests cover failed first reads, failed refreshes,
persistent failures, recovery, clipboard ownership and failed clipboard requests.

Other findings were checked before adoption. Offscreen responses are synchronous,
so they do not need an asynchronous message-channel lifetime; the clipboard path
matches Chrome's offscreen sample and passes real paste tests. The native DOM-host
factory uses ordinary constructible-function/class semantics and passes both
Firefox and Chrome integration tests; it avoids Chrome's unavailable isolated-world
custom-element registry. Cosmetic function-size/argument-count thresholds did not
justify restructuring existing search logic.

The follow-up review's hypothetical document/window key target cannot propagate
through this handler's `document.documentElement` listener (those nodes are its
ancestors). Real trusted shortcut tests pass in both browsers. A retry promise
returned from `.catch()` is adopted by the returned promise and handled by the
message/event caller's catch; the persistent-failure test verifies errors are
returned without unhandled rejection and later requests can recover.

## Manual installation

Extract the generated Chrome ZIP, open `chrome://extensions`, enable Developer
mode, choose **Load unpacked**, and select the extracted directory. Keep this
directory in place; load the directory rather than the ZIP itself. Use the
extension's **Extension options** page for configuration.
