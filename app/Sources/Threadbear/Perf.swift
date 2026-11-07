import BearDock
import AppKit
import ThreadbearCore
import os

/// `--perf-run`: opens the fixture threads served by the mock runner and
/// measures first paint, thread switches, a scripted fling, 60 s of 30 Hz
/// streaming while scrolled up, and memory with 20 threads loaded. Prints a
/// report and quits. Run it with Tools/perf-run.sh.
@MainActor
final class PerfRunner: NSObject {
    private static var current: PerfRunner?
    private let app: AppModel
    private var lines: [String] = []
    private var json: [String: Any] = [:]
    private let streamSeconds: Double

    private init(app: AppModel) {
        self.app = app
        let arguments = CommandLine.arguments
        if let index = arguments.firstIndex(of: "--stream-seconds"), index + 1 < arguments.count, let value = Double(arguments[index + 1]) {
            streamSeconds = value
        } else {
            streamSeconds = 60
        }
    }

    static func start(app: AppModel) {
        let runner = PerfRunner(app: app)
        current = runner
        Task { await runner.run() }
    }

    private func log(_ line: String) {
        lines.append(line)
        print(line)
        fflush(stdout)
    }

    private var window: NSWindow? { NSApp.windows.first { $0.isVisible && $0.contentView != nil && $0.title != "" && !($0 is DockPanelWindow) } ?? NSApp.windows.first }

    private func run() async {
        // Wait for the runner and the thread list.
        for _ in 0..<400 where app.connection != .connected || app.threads.isEmpty {
            try? await Task.sleep(for: .milliseconds(25))
        }
        guard app.connection == .connected else {
            log("perf: couldn't connect to the runner (\(app.connection))")
            NSApp.terminate(nil)
            return
        }
        try? await Task.sleep(for: .milliseconds(300))
        guard let window else {
            log("perf: the app has no window to measure")
            NSApp.terminate(nil)
            return
        }
        // Paint and display-link timings need the window on screen and in front.
        NSApp.activate()
        window.makeKeyAndOrderFront(nil)
        // `--perf-window 1280x860` (the default) sets the window's content size.
        var size = NSSize(width: 1280, height: 860)
        if let index = CommandLine.arguments.firstIndex(of: "--perf-window"), index + 1 < CommandLine.arguments.count {
            let parts = CommandLine.arguments[index + 1].split(separator: "x").compactMap { Double($0) }
            if parts.count == 2 { size = NSSize(width: parts[0], height: parts[1]) }
        }
        // The perf sizes are never saved as the window's frame.
        window.setFrameAutosaveName("")
        window.setContentSize(size)
        window.center()
        try? await Task.sleep(for: .milliseconds(300))

        log("Threadbear perf run")
        log("machine: \(machine()), macOS \(ProcessInfo.processInfo.operatingSystemVersionString)")
        log(String(format: "launch to window: %.0f ms, launch to thread list: %.0f ms", LaunchClock.windowMs ?? -1, LaunchClock.threadsMs ?? -1))
        json["launchToWindowMs"] = LaunchClock.windowMs
        json["launchToThreadListMs"] = LaunchClock.threadsMs

        let fixtures = app.threads.values.filter { $0.id.hasPrefix("fx_rows") }.sorted { $0.lastSeq < $1.lastSeq }
        guard let biggest = fixtures.last else {
            log("perf: no fx_rows fixtures loaded; run Tools/fixture-export first")
            NSApp.terminate(nil)
            return
        }

        checkpoint("thread list loaded")
        let debug = CommandLine.arguments.contains("--perf-debug")
        if debug { debugCells() }

        // 1. The biggest thread as the very first thing opened after launch:
        // nothing cached, no transcript or toolbar built yet. This is the
        // number for the 100 ms bar.
        log("")
        let coldMs = await measureOpen(biggest.id)
        let coldSession = app.session(for: biggest.id)
        log(String(format: "Open the biggest thread first thing after launch: %@ %.1f ms (%d events and %d rows loaded, %d shown, memory %.0f MB)",
                   biggest.id, coldMs, coldSession.model.events.count, coldSession.model.rows.count, coldSession.displayCount, memoryMB()))
        json["coldOpenBiggestMs"] = coldMs
        if debug { debugCells() }
        try? await Task.sleep(for: .milliseconds(150))

        // 2. First paint for the other fixtures (each opened for the first time).
        log("Open the other fixtures to first paint (first time each)")
        var opens: [[String: Any]] = [["thread": biggest.id, "ms": coldMs, "rowsLoaded": coldSession.model.rows.count, "shown": coldSession.displayCount]]
        for thread in fixtures.reversed().dropFirst() {
            let ms = await measureOpen(thread.id)
            let session = app.session(for: thread.id)
            log(String(format: "  %@: %.1f ms (%d events and %d rows loaded, %d shown, memory %.0f MB)",
                       thread.id, ms, session.model.events.count, session.model.rows.count, session.displayCount, memoryMB()))
            opens.append(["thread": thread.id, "ms": ms, "rowsLoaded": session.model.rows.count, "shown": session.displayCount])
            if debug { debugCells() }
            try? await Task.sleep(for: .milliseconds(150))
        }
        json["open"] = opens
        checkpoint("4 fixtures open")

        // 3. Switching between loaded threads.
        log("")
        log("Switch threads (warm)")
        var switches: [Double] = []
        for round in 0..<6 {
            for thread in (round % 2 == 0 ? fixtures : fixtures.reversed()) {
                switches.append(await measureSwitch(thread.id))
                try? await Task.sleep(for: .milliseconds(40))
            }
        }
        log(stats("  switch", switches))
        json["switchMs"] = statsJSON(switches)

        // 4. Fling to the top of the biggest thread and back.
        log("")
        log("Fling (\(biggest.id))")
        _ = await measureSwitch(biggest.id)
        app.transcript.scrollToBottom()
        try? await Task.sleep(for: .milliseconds(200))
        let fling = await Fling(controller: app.transcript, session: app.session(for: biggest.id), speed: 9000).run()
        log(String(format: "  up: %.1f s, %d frames, %d older pages, max frame gap %.1f ms, frames over 33 ms: %d, over 100 ms: %d",
                   fling.upSeconds, fling.upFrames, fling.prepends, fling.upMaxGap, fling.upOver33, fling.upOver100))
        log(String(format: "  down: %.1f s, %d frames, max frame gap %.1f ms, frames over 33 ms: %d, over 100 ms: %d",
                   fling.downSeconds, fling.downFrames, fling.downMaxGap, fling.downOver33, fling.downOver100))
        log(String(format: "  scrolled %.0f pt up and %.0f pt down (up/down %.2f); rows shown at the top: %d",
                   fling.upDistance, fling.downDistance, fling.downDistance > 0 ? fling.upDistance / fling.downDistance : 0, fling.rowsAtTop))
        log(String(format: "  jumps (the top row moved between frames with no scroll): %d, largest %.0f pt", fling.jumps, fling.maxJump))
        log(String(format: "  reached the top %d times before older rows were in, waiting %.0f ms in all (longest %.0f ms)", fling.stalls, fling.stallMs, fling.maxStallMs))
        let flung = app.session(for: biggest.id)
        log("  " + stats("older page fetch", flung.olderFetchMs, unit: "pages"))
        log("  " + stats("older page merge", flung.olderMergeMs, unit: "pages"))
        json["fling"] = fling.json
        json["olderFetchMs"] = statsJSON(flung.olderFetchMs)
        json["olderMergeMs"] = statsJSON(flung.olderMergeMs)
        checkpoint("after the fling")

        // 4b. Live resize with every row of the biggest thread shown (as
        // after the fling): narrow the window so the reading column changes
        // width, then 20 steps of 4 pt, timing each step's layout.
        log("")
        let resize = await measureResize()
        log(String(format: "Live resize with %d rows shown: per 4 pt step median %.1f ms, max %.1f ms (%d steps); all rows re-measured %.0f ms after the last step",
                   app.transcript.rowCount, resize.median, resize.max, resize.steps, resize.settleMs))
        json["resize"] = ["medianMs": resize.median, "maxMs": resize.max, "steps": resize.steps, "settleMs": resize.settleMs, "rows": app.transcript.rowCount]

        // 5. Streaming like a real turn: deltas at 30 Hz, and every 1.5 s the
        // text so far, a tool call and its result are persisted (each with a
        // thread.updated). Scrolled up for the bar, then pinned to the bottom.
        log("")
        log("Streaming \(Int(streamSeconds)) s at 30 Hz into \(biggest.id) with a tool call every 1.5 s, scrolled up")
        let scrolledUp = await measureStreaming(threadId: biggest.id, seconds: streamSeconds, pinned: false)
        log(String(format: "  CPU: %.1f%% of one core (%.2f s CPU over %.1f s), %d flushes, mean flush %.2f ms, memory %.0f MB; the row being read %@",
                   scrolledUp.cpuPercent, scrolledUp.cpuSeconds, scrolledUp.wallSeconds, scrolledUp.flushes, scrolledUp.meanFlushMs, scrolledUp.memoryMB,
                   scrolledUp.anchorHeld ? "stayed put" : "moved"))
        json["streamingScrolledUp"] = scrolledUp.json
        log("Streaming \(Int(streamSeconds)) s the same way, pinned to the bottom")
        let pinned = await measureStreaming(threadId: biggest.id, seconds: streamSeconds, pinned: true)
        log(String(format: "  CPU: %.1f%% of one core, %d flushes, mean flush %.2f ms; per 10 s: %@",
                   pinned.cpuPercent, pinned.flushes, pinned.meanFlushMs, pinned.windows.map { String(format: "%.1f%%", $0) }.joined(separator: ", ")))
        json["streamingPinned"] = pinned.json
        checkpoint("after streaming")

        // 6. Memory with 20 threads loaded and the biggest open. The other
        // 16 are copies of the real fixtures (perf-run.sh makes them), so
        // they're real-size threads, not small synthetic ones.
        log("")
        let copies = app.threads.values.filter { $0.id.hasPrefix("fx_copy_") }.sorted { $0.id < $1.id }
        let others = app.threads.values.filter { !$0.id.hasPrefix("fx_") && !$0.isArchived }.sorted { $0.id < $1.id }
        let extra = Array((copies + others).prefix(max(0, 20 - fixtures.count)))
        for thread in extra {
            _ = await measureOpen(thread.id)
        }
        _ = await measureSwitch(biggest.id)
        try? await Task.sleep(for: .seconds(1))
        let footprint = memoryMB()
        let graphics = graphicsMB()
        if debug { debugCells() }
        try? await Task.sleep(for: .seconds(5))
        let settled = memoryMB()
        let settledGraphics = graphicsMB()
        let peak = memoryPeakMB()
        let realSize = extra.filter { $0.id.hasPrefix("fx_copy_") }.count
        log(String(format: "Memory with %d threads loaded (%d real-size copies) and the biggest open: %.0f MB after 1 s (%.0f MB of it graphics), %.0f MB after 6 s (%.0f MB graphics); peak over the whole run %.0f MB (phys_footprint)",
                   app.loadedSessionCount, realSize, footprint, graphics, settled, settledGraphics, peak))
        if debug { debugCells() }
        json["memoryMB"] = footprint
        json["memorySettledMB"] = settled
        json["memoryGraphicsMB"] = graphics
        json["memorySettledGraphicsMB"] = settledGraphics
        json["memoryPeakMB"] = peak
        json["threadsLoaded"] = app.loadedSessionCount
        json["realSizeCopies"] = realSize
        json["memoryCheckpoints"] = memoryCheckpoints
        log("  checkpoints: " + memoryCheckpoints.map { String(format: "%@ %.0f MB", $0["at"] as! String, $0["mb"] as! Double) }.joined(separator: ", "))

        // 7. Archiving the open thread: a picture of its transcript drops
        // into the Archived heading while the next thread opens under it
        // (`ArchiveFlight`). On the real-size copies, so the fixtures
        // themselves stay in the inbox. Times the click itself (the
        // picture, then opening the next thread) and watches the frames
        // until the flight has landed.
        log("")
        log("Archive the open thread (\(min(5, copies.count)) real-size copies, scrolled to the bottom)")
        var archiveClicks: [Double] = [], pictures: [Double] = []
        var archiveMaxGap = 0.0, archiveOver33 = 0, archiveFrames = 0
        for copy in copies.prefix(5) {
            _ = await measureSwitch(copy.id)
            app.transcript.scrollToBottom()
            try? await Task.sleep(for: .milliseconds(300))
            let watch = FrameWatch()
            watch.start(on: app.transcript.scrollView)
            try? await Task.sleep(for: .milliseconds(100))
            let start = CACurrentMediaTime()
            app.archive(copy.id)
            archiveClicks.append((CACurrentMediaTime() - start) * 1000)
            pictures.append(ArchiveFlight.lastPictureMs)
            try? await Task.sleep(for: .seconds(ArchiveFlight.Destination.archive.duration + 0.5))
            watch.stop()
            archiveMaxGap = max(archiveMaxGap, watch.maxGap)
            archiveOver33 += watch.over33
            archiveFrames += watch.frames
        }
        log("  " + stats("click (picture and opening the next thread)", archiveClicks, unit: "archives"))
        log("  " + stats("of which the picture", pictures, unit: "archives"))
        log(String(format: "  frames from the click until it landed: %d, max gap %.1f ms, over 33 ms: %d", archiveFrames, archiveMaxGap, archiveOver33))
        json["archive"] = ["clickMs": statsJSON(archiveClicks), "pictureMs": statsJSON(pictures),
                           "frames": archiveFrames, "maxGapMs": archiveMaxGap, "over33": archiveOver33]

        // 8. The same for hibernating the open thread: slower and softer,
        // and on the next five copies, as those five have gone.
        log("")
        let tucking = Array(copies.dropFirst(5).prefix(5))
        log("Hibernate the open thread (\(tucking.count) real-size copies, scrolled to the bottom)")
        var tuckClicks: [Double] = [], tuckPictures: [Double] = []
        var tuckMaxGap = 0.0, tuckOver33 = 0, tuckFrames = 0
        for copy in tucking {
            _ = await measureSwitch(copy.id)
            app.transcript.scrollToBottom()
            try? await Task.sleep(for: .milliseconds(300))
            let watch = FrameWatch()
            watch.start(on: app.transcript.scrollView)
            try? await Task.sleep(for: .milliseconds(100))
            let start = CACurrentMediaTime()
            app.snooze(copy.id, until: Date().addingTimeInterval(3600))
            tuckClicks.append((CACurrentMediaTime() - start) * 1000)
            tuckPictures.append(ArchiveFlight.lastPictureMs)
            try? await Task.sleep(for: .seconds(ArchiveFlight.Destination.hibernate.duration + 0.5))
            watch.stop()
            tuckMaxGap = max(tuckMaxGap, watch.maxGap)
            tuckOver33 += watch.over33
            tuckFrames += watch.frames
        }
        log("  " + stats("click (picture and opening the next thread)", tuckClicks, unit: "hibernates"))
        log("  " + stats("of which the picture", tuckPictures, unit: "hibernates"))
        log(String(format: "  frames from the click until it landed: %d, max gap %.1f ms, over 33 ms: %d", tuckFrames, tuckMaxGap, tuckOver33))
        json["hibernate"] = ["clickMs": statsJSON(tuckClicks), "pictureMs": statsJSON(tuckPictures),
                             "frames": tuckFrames, "maxGapMs": tuckMaxGap, "over33": tuckOver33]

        // Counted last: it loads every event of every fixture, which would
        // skew the memory numbers above.
        log("")
        var rowCounts: [String: Int] = [:]
        for thread in fixtures { rowCounts[thread.id] = await countAllRows(thread.id) }
        log("Rows per fixture (whole thread, by the app's reducer): " + fixtures.map { "\($0.id) \(rowCounts[$0.id] ?? 0)" }.joined(separator: ", "))
        log(String(format: "Fling showed %d rows at the top%@ (the stream added rows since)", fling.rowsAtTop, fling.reachedFirst ? ", all of the thread" : ", NOT the whole thread"))
        json["rowsPerFixture"] = rowCounts

        // The plan's bars, judged from the numbers above.
        log("")
        log("Bars (plan.md, Performance bar)")
        let switchSorted = switches.sorted()
        let switchP95 = switchSorted.isEmpty ? 0 : switchSorted[min(switchSorted.count - 1, Int(Double(switchSorted.count) * 0.95))]
        let upMatchesDown = fling.downDistance > 0 && fling.upDistance / fling.downDistance > 0.9
        bar("Open the biggest thread first after launch, 100 ms or less", coldMs <= 100, String(format: "%.0f ms", coldMs))
        bar("Switch threads, 50 ms or less", switchP95 <= 50, String(format: "p95 %.0f ms, max %.0f ms", switchP95, switchSorted.last ?? 0))
        bar("Fling, no hang over 100 ms", fling.upOver100 + fling.downOver100 == 0,
            String(format: "max frame gap %.0f ms", max(fling.upMaxGap, fling.downMaxGap)))
        bar("Fling, no jumps", fling.jumps == 0 && upMatchesDown && fling.reachedFirst,
            String(format: "%d jumps (largest %.0f pt), up/down distance %.2f, %@", fling.jumps, fling.maxJump,
                   fling.downDistance > 0 ? fling.upDistance / fling.downDistance : 0, fling.reachedFirst ? "reached the first row" : "didn't reach the first row"))
        bar("Live resize of the biggest thread, no hang over 100 ms", resize.max <= 100, String(format: "max %.0f ms a step", resize.max))
        bar("Streaming scrolled up, 30% of a core or less", scrolledUp.cpuPercent <= 30 && scrolledUp.anchorHeld,
            String(format: "%.1f%%, the row being read %@", scrolledUp.cpuPercent, scrolledUp.anchorHeld ? "stayed put" : "moved"))
        bar("Archive the open thread, no hang over 100 ms", archiveMaxGap <= 100 && !archiveClicks.isEmpty,
            String(format: "max frame gap %.0f ms, click max %.0f ms", archiveMaxGap, archiveClicks.max() ?? 0))
        bar("20 threads loaded and the biggest open, 200 MB or less", footprint <= 200 && settled <= 200,
            String(format: "%.0f MB after 1 s (%.0f MB graphics), %.0f MB settled (peak %.0f MB)", footprint, graphics, settled, peak))
        json["bars"] = barResults

        if let index = CommandLine.arguments.firstIndex(of: "--perf-hold"), index + 1 < CommandLine.arguments.count,
           let seconds = Double(CommandLine.arguments[index + 1]) {
            log("Holding for \(Int(seconds)) s (pid \(getpid()))")
            try? await Task.sleep(for: .seconds(seconds))
        }

        writeReport()
        NSApp.terminate(nil)
    }


    /// Rows in the whole thread, counted with the app's own reducer (not timed).
    private func countAllRows(_ threadId: String) async -> Int {
        guard let client = app.client else { return 0 }
        var events: [Event] = []
        var after = 0
        while true {
            guard let page = try? await client.events(threadId: threadId, afterSeq: after, limit: 5000), !page.events.isEmpty else { break }
            events += page.events
            after = page.events.last?.seq ?? after
            if page.events.count < 5000 { break }
        }
        let all = events
        return await Task.detached { TranscriptModel(events: all).rows.count }.value
    }

    private var barResults: [[String: Any]] = []

    private func bar(_ name: String, _ met: Bool, _ detail: String) {
        log("  \(met ? "met" : "NOT MET"): \(name): \(detail)")
        barResults.append(["bar": name, "met": met, "detail": detail])
    }

    // MARK: Measurements

    private func measureOpen(_ threadId: String) async -> Double {
        let session = app.session(for: threadId)
        let signpost = perfLog.beginInterval("first paint", id: perfLog.makeSignpostID())
        let start = CACurrentMediaTime()
        if session.state != .loaded {
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                session.onLoaded = {
                    session.onLoaded = nil
                    continuation.resume()
                }
                app.select(threadId)
            }
        } else {
            app.select(threadId)
        }
        await waitForController(session)
        window?.displayIfNeeded()
        let elapsed = (CACurrentMediaTime() - start) * 1000
        perfLog.endInterval("first paint", signpost)
        return elapsed
    }

    private func measureSwitch(_ threadId: String) async -> Double {
        let session = app.session(for: threadId)
        let signpost = perfLog.beginInterval("switch", id: perfLog.makeSignpostID())
        let start = CACurrentMediaTime()
        app.select(threadId)
        await waitForController(session)
        window?.displayIfNeeded()
        let elapsed = (CACurrentMediaTime() - start) * 1000
        perfLog.endInterval("switch", signpost)
        return elapsed
    }

    /// Waits for SwiftUI to hand the session to the transcript controller.
    private func waitForController(_ session: ThreadSession) async {
        for _ in 0..<2000 where app.transcript.session !== session {
            await Task.yield()
            if app.transcript.session !== session { try? await Task.sleep(for: .microseconds(200)) }
        }
    }

    struct ResizeResult {
        var median = 0.0, max = 0.0, steps = 0, settleMs = 0.0
    }

    private func measureResize() async -> ResizeResult {
        guard let window else { return ResizeResult() }
        let original = window.frame.size
        let content = window.contentRect(forFrameRect: window.frame).size
        func setWidth(_ width: CGFloat) -> Double {
            let start = CACurrentMediaTime()
            window.setContentSize(NSSize(width: width, height: content.height))
            window.contentView?.layoutSubtreeIfNeeded()
            return (CACurrentMediaTime() - start) * 1000
        }
        // Narrow enough that the reading column is below its widest.
        var width = min(content.width, 1000)
        _ = setWidth(width)
        try? await Task.sleep(for: .milliseconds(600))
        var times: [Double] = []
        for _ in 0..<20 {
            width -= 4
            times.append(setWidth(width))
            // About one display frame between steps, as in a drag.
            try? await Task.sleep(for: .milliseconds(16))
        }
        // How long until the rest of the rows have their new heights.
        let settleStart = CACurrentMediaTime()
        let session = app.transcript.session
        let expectedWidth = app.transcript.width
        var settled = 0.0
        for _ in 0..<300 {
            try? await Task.sleep(for: .milliseconds(10))
            if let session, (0..<session.displayCount).allSatisfy({
                TranscriptController.renders.cached(session.displayRow($0), expanded: session.expanded.contains(session.displayRow($0).id), width: expectedWidth) != nil
            }) {
                settled = (CACurrentMediaTime() - settleStart) * 1000
                break
            }
        }
        window.setContentSize(NSSize(width: content.width, height: content.height))
        _ = original
        try? await Task.sleep(for: .milliseconds(600))
        let sorted = times.sorted()
        return ResizeResult(median: sorted[sorted.count / 2], max: sorted.last ?? 0, steps: times.count, settleMs: settled)
    }

    struct StreamResult {
        var cpuSeconds: Double
        var wallSeconds: Double
        var flushes: Int
        var meanFlushMs: Double
        var memoryMB: Double
        /// CPU % of one core in each 10 s window.
        var windows: [Double]
        /// Scrolled up: the row at the top of the screen was the same row at
        /// the same offset before and after.
        var anchorHeld: Bool
        var cpuPercent: Double { wallSeconds > 0 ? cpuSeconds / wallSeconds * 100 : 0 }
        var json: [String: Any] {
            ["cpuPercent": cpuPercent, "cpuSeconds": cpuSeconds, "wallSeconds": wallSeconds, "flushes": flushes, "meanFlushMs": meanFlushMs,
             "memoryMB": memoryMB, "cpuPercentPer10s": windows, "anchorHeld": anchorHeld]
        }
    }

    private func measureStreaming(threadId: String, seconds: Double, pinned: Bool) async -> StreamResult {
        let session = app.session(for: threadId)
        _ = await measureSwitch(threadId)
        let controller = app.transcript
        if pinned {
            controller.scrollToBottom()
        } else {
            // Scroll a few screens up from the bottom.
            controller.scrollToBottom()
            let clip = controller.scrollView.contentView
            clip.scroll(to: NSPoint(x: 0, y: max(0, clip.bounds.minY - clip.bounds.height * 4)))
            controller.scrollView.reflectScrolledClipView(clip)
        }
        controller.pagingEnabled = false
        try? await Task.sleep(for: .milliseconds(500))
        let before = controller.captureMemory()
        session.flushCount = 0
        session.flushTime = 0
        let cpuStart = cpuSeconds()
        let wallStart = CACurrentMediaTime()
        let signpost = perfLog.beginInterval("streaming", id: perfLog.makeSignpostID())
        _ = try? await app.client?.call("mock.stream", .object([
            "threadId": .string(threadId), "seconds": .number(seconds), "hz": .number(30), "tools": .bool(true),
        ]), as: EmptyResult.self)
        var windows: [Double] = []
        var windowStart = cpuStart
        var elapsed = 0.0
        while elapsed < seconds + 0.3 {
            let step = min(10, seconds + 0.3 - elapsed)
            try? await Task.sleep(for: .seconds(step))
            elapsed += step
            let now = cpuSeconds()
            windows.append((now - windowStart) / step * 100)
            windowStart = now
        }
        perfLog.endInterval("streaming", signpost)
        let cpu = cpuSeconds() - cpuStart
        let wall = CACurrentMediaTime() - wallStart
        let after = controller.captureMemory()
        controller.pagingEnabled = true
        let mean = session.flushCount > 0 ? session.flushTime / Double(session.flushCount) * 1000 : 0
        let held = pinned || (before.anchorId == after.anchorId && abs(before.offset - after.offset) <= 1)
        return StreamResult(cpuSeconds: cpu, wallSeconds: wall, flushes: session.flushCount, meanFlushMs: mean, memoryMB: memoryMB(),
                            windows: windows, anchorHeld: held)
    }

    // MARK: Report

    private func stats(_ label: String, _ values: [Double], unit: String = "switches") -> String {
        let sorted = values.sorted()
        guard !sorted.isEmpty else { return "\(label): no samples" }
        let median = sorted[sorted.count / 2]
        let p95 = sorted[min(sorted.count - 1, Int(Double(sorted.count) * 0.95))]
        return String(format: "%@: median %.1f ms, p95 %.1f ms, max %.1f ms (%d %@)", label, median, p95, sorted.last!, sorted.count, unit)
    }

    /// Prints the cells the table has made and their sizes (`--perf-debug`).
    private func debugCells() {
        let table = app.transcript.tableView
        var lines: [String] = []
        var area: CGFloat = 0
        for index in 0..<table.numberOfRows {
            guard let cell = table.view(atColumn: 0, row: index, makeIfNecessary: false) else { continue }
            area += cell.frame.width * cell.frame.height
            let kind = app.transcript.row(at: index)?.kind.rawValue ?? "?"
            lines.append("\(index):\(kind):\(Int(cell.frame.height))")
        }
        log("    cells: \(lines.count), total area \(Int(area / 1_000_000)) Mpt2: " + lines.joined(separator: " "))
        func dump(_ layer: CALayer, _ depth: Int) {
            guard depth < 8 else { return }
            let size = layer.bounds.size
            if size.width * size.height > 100_000 || depth < 2 {
                log("      " + String(repeating: " ", count: depth) + "\(type(of: layer)) \(Int(size.width))x\(Int(size.height)) contents=\(layer.contents.map { String(describing: type(of: $0)) } ?? "nil") delegate=\(layer.delegate.map { String(describing: type(of: $0)) } ?? "nil")")
            }
            for sub in layer.sublayers ?? [] { dump(sub, depth + 1) }
        }
        if let clipLayer = app.transcript.scrollView.layer { dump(clipLayer, 0) }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/vmmap")
        process.arguments = ["--summary", String(getpid())]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        try? process.run()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        let wanted = ["CoreAnimation", "CG raster data", "MALLOC_SMALL", "MALLOC_LARGE", "MALLOC_TINY", "IOSurface", "IOAccelerator", "CG image", "owned unmapped"]
        let regions = String(decoding: data, as: UTF8.self).split(separator: "\n").filter { line in wanted.contains { line.hasPrefix($0) } }
            .map { line -> String in
                let parts = line.split(separator: " ", omittingEmptySubsequences: true)
                // name ... VIRTUAL RESIDENT DIRTY ...: keep the name and DIRTY.
                let numbers = parts.filter { $0.last == "K" || $0.last == "M" || $0.last == "G" }
                let name = parts.prefix { !($0.last == "K" || $0.last == "M" || $0.last == "G") }.joined(separator: " ")
                return numbers.count >= 3 ? "\(name) \(numbers[2])" : name
            }
        log("    dirty: " + regions.joined(separator: ", "))
        if let window {
            log("    window: active \(NSApp.isActive), key \(window.isKeyWindow), screen \(window.screen?.localizedName ?? "?") at \(window.backingScaleFactor)x, occluded \(!window.occlusionState.contains(.visible))")
        }
    }

    private var memoryCheckpoints: [[String: Any]] = []

    private func checkpoint(_ label: String) {
        memoryCheckpoints.append(["at": label, "mb": memoryMB()])
    }

    private func statsJSON(_ values: [Double]) -> [String: Any] {
        let sorted = values.sorted()
        guard !sorted.isEmpty else { return [:] }
        return ["median": sorted[sorted.count / 2], "p95": sorted[min(sorted.count - 1, Int(Double(sorted.count) * 0.95))], "max": sorted.last!, "count": sorted.count]
    }

    private func writeReport() {
        let arguments = CommandLine.arguments
        guard let index = arguments.firstIndex(of: "--perf-report"), index + 1 < arguments.count else { return }
        let path = arguments[index + 1]
        if let data = try? JSONSerialization.data(withJSONObject: json, options: [.prettyPrinted, .sortedKeys]) {
            try? data.write(to: URL(fileURLWithPath: path))
        }
        try? (lines.joined(separator: "\n") + "\n").write(toFile: path.replacingOccurrences(of: ".json", with: ".txt"), atomically: true, encoding: .utf8)
    }

    private func machine() -> String {
        var size = 0
        sysctlbyname("machdep.cpu.brand_string", nil, &size, nil, 0)
        var buffer = [CChar](repeating: 0, count: size)
        sysctlbyname("machdep.cpu.brand_string", &buffer, &size, nil, 0)
        let memory = Double(ProcessInfo.processInfo.physicalMemory) / 1_073_741_824
        return String(cString: buffer) + String(format: ", %.0f GB", memory)
    }
}

func cpuSeconds() -> Double {
    var usage = rusage()
    getrusage(RUSAGE_SELF, &usage)
    return Double(usage.ru_utime.tv_sec) + Double(usage.ru_utime.tv_usec) / 1e6 + Double(usage.ru_stime.tv_sec) + Double(usage.ru_stime.tv_usec) / 1e6
}

func memoryMB() -> Double {
    Double(vmInfo()?.phys_footprint ?? 0) / 1_048_576
}

/// The part of phys_footprint that's GPU memory (CoreAnimation drawables
/// and the like), which the system hands back a few seconds after drawing.
func graphicsMB() -> Double {
    Double(vmInfo()?.ledger_tag_graphics_footprint ?? 0) / 1_048_576
}

/// The highest phys_footprint since the process started.
func memoryPeakMB() -> Double {
    Double(vmInfo()?.ledger_phys_footprint_peak ?? 0) / 1_048_576
}

private func vmInfo() -> task_vm_info_data_t? {
    var info = task_vm_info_data_t()
    var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
    let result = withUnsafeMutablePointer(to: &info) {
        $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
            task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
        }
    }
    guard result == KERN_SUCCESS else { return nil }
    return info
}

/// Scrolls the transcript at a fixed speed with a display link, up to the
/// first row (paging older rows in on the way) and back down, recording
/// the gap between frames.
@MainActor
final class Fling: NSObject {
    struct Result {
        var upSeconds = 0.0, downSeconds = 0.0
        var upFrames = 0, downFrames = 0
        var upMaxGap = 0.0, downMaxGap = 0.0
        var upOver33 = 0, downOver33 = 0
        var upOver100 = 0, downOver100 = 0
        var prepends = 0
        /// Points scrolled in each direction. Going up pages the whole thread
        /// in, so up should come out about the same as down; far less means
        /// the content jumped under the scroll position.
        var upDistance: CGFloat = 0, downDistance: CGFloat = 0
        /// Frames where the row at the top of the screen moved by more than
        /// 1 pt between one frame and the next without the fling scrolling.
        var jumps = 0
        var maxJump: CGFloat = 0
        var rowsAtTop = 0
        /// Got to the thread's first event (no older pages left).
        var reachedFirst = false
        /// Times the fling hit the top before the next older page was in.
        var stalls = 0
        var stallMs = 0.0
        var maxStallMs = 0.0
        var json: [String: Any] {
            ["upSeconds": upSeconds, "downSeconds": downSeconds, "upFrames": upFrames, "downFrames": downFrames,
             "upMaxGapMs": upMaxGap, "downMaxGapMs": downMaxGap, "upOver33": upOver33, "downOver33": downOver33,
             "upOver100": upOver100, "downOver100": downOver100, "olderPages": prepends, "rowsAtTop": rowsAtTop,
             "upDistancePt": upDistance, "downDistancePt": downDistance, "jumps": jumps, "maxJumpPt": maxJump, "reachedFirst": reachedFirst,
             "topStalls": stalls, "topStallMs": stallMs, "maxTopStallMs": maxStallMs]
        }
    }

    private let controller: TranscriptController
    private let session: ThreadSession
    private let speed: CGFloat
    private var link: CADisplayLink?
    private var last: CFTimeInterval = 0
    private var phaseStart: CFTimeInterval = 0
    private var goingUp = true
    private var result = Result()
    private var continuation: CheckedContinuation<Void, Never>?
    /// When the current wait at the top began, if waiting.
    private var stallStart: CFTimeInterval?
    /// The row at the top of the screen after the last frame's scroll, and
    /// its offset from the top of the clip view.
    private var tracked: (id: String, offset: CGFloat)?

    init(controller: TranscriptController, session: ThreadSession, speed: CGFloat) {
        self.controller = controller
        self.session = session
        self.speed = speed
    }

    func run() async -> Result {
        controller.onPrepend = { [weak self] in
            self?.result.prepends += 1
        }
        await withCheckedContinuation { continuation in
            self.continuation = continuation
            let link = controller.scrollView.displayLink(target: self, selector: #selector(tick(_:)))
            link.add(to: .main, forMode: .common)
            self.link = link
        }
        controller.onPrepend = nil
        return result
    }

    @objc private func tick(_ link: CADisplayLink) {
        let now = link.timestamp
        if last == 0 {
            last = now
            phaseStart = now
            return
        }
        let gap = (now - last) * 1000
        last = now
        if goingUp {
            result.upFrames += 1
            result.upMaxGap = max(result.upMaxGap, gap)
            if gap > 33 { result.upOver33 += 1 }
            if gap > 100 { result.upOver100 += 1 }
        } else {
            result.downFrames += 1
            result.downMaxGap = max(result.downMaxGap, gap)
            if gap > 33 { result.downOver33 += 1 }
            if gap > 100 { result.downOver100 += 1 }
        }
        let clip = controller.scrollView.contentView
        // Nothing scrolled since the last frame, so the row that was at the
        // top must still be exactly where it was, older pages or not.
        if let tracked, let index = session.displayIndex(of: tracked.id) {
            let offset = controller.tableView.rect(ofRow: index).minY - clip.bounds.minY
            let moved = abs(offset - tracked.offset)
            if moved > 1 {
                result.jumps += 1
                result.maxJump = max(result.maxJump, moved)
            }
        }
        defer { track() }
        let top = -controller.scrollView.contentInsets.top
        let step = speed * CGFloat(min(gap, 50) / 1000)
        let startY = clip.bounds.minY
        if goingUp {
            let target = max(top, clip.bounds.minY - step)
            clip.scroll(to: NSPoint(x: 0, y: target))
            controller.scrollView.reflectScrolledClipView(clip)
            result.upDistance += abs(clip.bounds.minY - startY)
            if target <= top + 0.5 {
                if session.hasMoreAbove {
                    // At the very top with older rows still to come: wait
                    // for the page, but give up if one takes over 5 s.
                    if stallStart == nil {
                        stallStart = now
                        result.stalls += 1
                    }
                    if now - stallStart! > 5 { endStall(now); finishUp(now) }
                } else {
                    endStall(now)
                    finishUp(now)
                }
            } else {
                endStall(now)
            }
        } else {
            let bottom = controller.tableView.frame.height + controller.scrollView.contentInsets.bottom - clip.bounds.height
            let target = min(bottom, clip.bounds.minY + step)
            clip.scroll(to: NSPoint(x: 0, y: target))
            controller.scrollView.reflectScrolledClipView(clip)
            result.downDistance += abs(clip.bounds.minY - startY)
            if target >= bottom - 0.5 {
                result.downSeconds = now - phaseStart
                link.invalidate()
                self.link = nil
                continuation?.resume()
                continuation = nil
            }
        }
    }

    private func track() {
        let clip = controller.scrollView.contentView.bounds
        let index = controller.tableView.row(at: NSPoint(x: 1, y: max(0, clip.minY + 1)))
        guard index >= 0, let row = controller.row(at: index) else {
            tracked = nil
            return
        }
        tracked = (row.id, controller.tableView.rect(ofRow: index).minY - clip.minY)
    }

    private func endStall(_ now: CFTimeInterval) {
        guard let start = stallStart else { return }
        let ms = (now - start) * 1000
        result.stallMs += ms
        result.maxStallMs = max(result.maxStallMs, ms)
        stallStart = nil
    }

    private func finishUp(_ now: CFTimeInterval) {
        result.upSeconds = now - phaseStart
        result.rowsAtTop = session.displayCount
        result.reachedFirst = !session.hasMoreAbove
        goingUp = false
        phaseStart = now
    }
}

/// Frame gaps for a while, from the window's display link: whether frames
/// kept coming through something short, like an archive's flight.
@MainActor
private final class FrameWatch: NSObject {
    private var link: CADisplayLink?
    private var last: CFTimeInterval = 0
    private(set) var frames = 0
    private(set) var maxGap = 0.0
    private(set) var over33 = 0

    func start(on view: NSView) {
        let link = view.displayLink(target: self, selector: #selector(tick(_:)))
        link.add(to: .main, forMode: .common)
        self.link = link
    }

    @objc private func tick(_ link: CADisplayLink) {
        let now = link.timestamp
        if last > 0 {
            let gap = (now - last) * 1000
            frames += 1
            maxGap = max(maxGap, gap)
            if gap > 33 { over33 += 1 }
        }
        last = now
    }

    func stop() {
        link?.invalidate()
        link = nil
    }
}
