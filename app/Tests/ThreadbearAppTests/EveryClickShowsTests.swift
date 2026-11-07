import Foundation
import XCTest

/// Every click shows something at once (AGENTS.md, "Assume every action is
/// slow to land"), and a Task that calls the runner and shows nothing looks
/// like any other code, so this catches it from the source, as TipsTests does
/// for `.help`. Every runner call that changes something has to sit in a
/// function that uses `whileBusy` and friends, or be listed below by someone
/// who has checked what that function shows. A new call site in a new
/// function fails until then, which is the moment to think about it.
final class EveryClickShowsTests: XCTestCase {
    /// RunnerAPI's calls that only read, or that nobody clicks for.
    private static let quiet: Set<String> = [
        "hello", "listThreads", "searchThreads", "samples", "renderPanel", "convexPanelDeployments",
        "convexPanelLogin", "convexPanelKey", "threadHighlights", "threadCommands", "explain", "panelShown",
        "events", "subscribe", "subagent", "unsubscribe", "markSeen", "startRequest", "importMedia", "usageStats",
        "listClis", "listSchedules", "listRunners", "remoteLogins", "remoteThreads", "previewSchedule",
        "listProjects", "getProject", "refreshProjectTasks", "librarianStatus", "connectorsStatus", "listPools",
        // Not calls: helpers on the request types in the same file.
        "applied", "params",
    ]

    /// The calls that change something.
    private static let changing: Set<String> = [
        "send", "editMessage", "createThread", "hibernateWhen", "removeHighlight", "runAction", "trustPatches",
        "interrupt", "updateThread", "share", "tickAsk", "respond", "answerStartRequest", "approvePlan",
        "answerSecret", "checkClis", "updateCli", "setCliPolicy", "createSchedule", "updateSchedule",
        "deleteSchedule", "setRunnerOrder", "runSchedule", "createProject", "updateProject", "setProjectIcon",
        "mergeProject", "deleteProject", "setThreadProjects", "runLibrarian", "updateLibrarian", "savePools",
    ]

    /// Functions that show their click some other way, and how.
    private static let showsItsOwnWay: [String: String] = [
        "RemoteRunners.swift setRunnerOrder": "the rows move at once",
        "RemoteRunners.swift sendNewThread": "creatingThread: the Send button spins",
        "AppModel+ThreadActions.swift startThreadSpoken": "said, not clicked: Voice shows Working on it at once (VoiceMode.send), and creatingThread spins Send",
        "ThreadSession.swift tickAsk": "the box changes at once",
        "ThreadSession.swift answerSecret": "async: the card awaits it and shows its own state",
        "PaneModel.swift removeHighlight": "the row goes at once",
        "AppModel+ThreadActions.swift sendEdit": "editing.sending: the box shows it's sending",
        "AppModel+ThreadActions.swift send": "creatingThread: the Send button spins",
        "AppModel+ThreadActions.swift post": "the message shows dimmed in the transcript",
        "AppModel+ThreadActions.swift bringInUpstream": "creatingThread: the buttons spin",
        "AppModel+ThreadActions.swift share": "async: the share popover shows its own state",
        "AppModel+ThreadActions.swift rename": "the title changes at once",
        "AppModel+ThreadActions.swift archive": "the row slides off at once",
        "AppModel+ThreadActions.swift hibernateWhen": "the row goes at once",
        "AppModel+Chrome.swift runAction": "runningActions: the chip spins",
        "AppModel+Chrome.swift trustPatches": "trustingPatches: the row spins",
        "AppModel+Chrome.swift investigateError": "creatingThread: the banner spins",
        "PoolsModel.swift savePools": "async: Settings awaits it and shows its own state",
        "Schedules.swift saveSchedule": "async: the editor awaits it and shows its own state",
        "Schedules.swift setSchedulePaused": "the row changes at once",
        "Schedules.swift confirmedDeleteSchedule": "the row goes at once",
        "RefusalRecovery.swift continueRefusal": "continuingRefusals: the button spins",
        "Projects.swift updateProject": "the page changes at once",
        "Projects.swift confirmedDelete": "the project goes at once",
        "Projects.swift confirmedMerge": "the project goes at once",
        "Projects.swift setProjects": "the chips change at once",
        "Projects.swift setLibrarianPaused": "the button and switch change at once",
    ]

    private var sources: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources")
    }

    /// Every call on a client that changes something, with the function it's
    /// in and the source from there down to the call.
    private func changingCalls() throws -> [(place: String, call: String, line: String, span: String)] {
        let names = Self.changing.joined(separator: "|")
        let call = try NSRegularExpression(pattern: #"(\bclient\??|\bnow|\bnext|\$0)\.("# + names + #")\("#)
        let function = try NSRegularExpression(pattern: #"\bfunc (\w+)"#)
        func first(_ regex: NSRegularExpression, in text: String, group: Int) -> String? {
            guard let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
                  let range = Range(match.range(at: group), in: text) else { return nil }
            return String(text[range])
        }
        var found: [(place: String, call: String, line: String, span: String)] = []
        let files = FileManager.default.enumerator(at: sources.appendingPathComponent("Threadbear"), includingPropertiesForKeys: nil)!
        for case let file as URL in files where file.pathExtension == "swift" {
            let lines = try String(contentsOf: file, encoding: .utf8).components(separatedBy: "\n")
            var start = 0
            var name = ""
            for (index, line) in lines.enumerated() {
                let code = line.components(separatedBy: "//").first ?? line
                if let inFunction = first(function, in: code, group: 1) {
                    start = index
                    name = inFunction
                }
                if let method = first(call, in: code, group: 2) {
                    found.append(("\(file.lastPathComponent) \(name)", method, code, lines[start...index].joined(separator: "\n")))
                }
            }
        }
        return found
    }

    func testARunnerCallThatChangesSomethingShowsItAtOnce() throws {
        let calls = try changingCalls()
        XCTAssertFalse(calls.isEmpty, "the scan has stopped finding anything")
        let markers = ["whileBusy(", "beginBusy(", "startAnswering(", "cliCall("]
        let silent = calls.filter { call in
            !markers.contains { call.span.contains($0) } && Self.showsItsOwnWay[call.place] == nil
        }
        XCTAssertEqual(silent.map { "\($0.place): \($0.call)" }, [], """
            A click on this shows nothing until the runner answers. Use whileBusy with .busy(_:), or a guess that \
            a failure takes back (AppModel+Busy.swift), or if it shows some other way, say how in showsItsOwnWay.
            """)
    }

    /// `try?` on one of these loses the error: the click looks like it worked.
    func testNoCallThatChangesSomethingSwallowsItsError() throws {
        let swallowed = try changingCalls().filter { $0.line.contains("try?") }
        XCTAssertEqual(swallowed.map { "\($0.place): \($0.call)" }, [], "say why it failed: show(error)")
    }

    /// A list that's out of date passes things it shouldn't.
    func testTheListHasNothingStale() throws {
        let places = Set(try changingCalls().map(\.place))
        XCTAssertEqual(Set(Self.showsItsOwnWay.keys).subtracting(places), [])
    }

    /// A new runner call has to be sorted into one list or the other.
    func testEveryRunnerCallIsSorted() throws {
        let api = try String(contentsOf: sources.appendingPathComponent("ThreadbearCore/RPC/RunnerAPI.swift"), encoding: .utf8)
        let function = try NSRegularExpression(pattern: #"(?m)^    (?:public )?func (\w+)\("#)
        let names = function.matches(in: api, range: NSRange(api.startIndex..., in: api)).compactMap { match in
            Range(match.range(at: 1), in: api).map { String(api[$0]) }
        }
        XCTAssertFalse(names.isEmpty)
        let unsorted = Set(names).subtracting(Self.quiet).subtracting(Self.changing)
        XCTAssertEqual(unsorted, [], "add it to quiet or changing")
    }
}
