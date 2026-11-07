import Foundation
import XCTest
@testable import ThreadbearCore

/// A text file open in the pane (TextFileDocument): read, written in
/// place, and watched so an agent's rewrite shows up without losing what
/// Mike has typed.
final class TextFileDocumentTests: XCTestCase {
    private var folder: URL!

    override func setUpWithError() throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("tb-textfile-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: folder)
    }

    private func file(_ name: String, _ text: String) throws -> URL {
        let url = folder.appendingPathComponent(name)
        try Data(text.utf8).write(to: url)
        return url
    }

    func testChangeOnDiskKeepsBothSidesApart() {
        typealias C = TextFileDocument.Change
        // Its own write, or a touch: nothing to do.
        XCTAssertEqual(TextFileDocument.change(onDisk: "a", saved: "a", shown: "a"), C.same)
        XCTAssertEqual(TextFileDocument.change(onDisk: "a", saved: "a", shown: "a typed"), C.same)
        // Nothing unsaved: take the file's.
        XCTAssertEqual(TextFileDocument.change(onDisk: "b", saved: "a", shown: "a"), C.reload("b"))
        // The file now says what's typed (the view's save, seen late).
        XCTAssertEqual(TextFileDocument.change(onDisk: "a typed", saved: "a", shown: "a typed"), C.reload("a typed"))
        // Both changed: Mike picks.
        XCTAssertEqual(TextFileDocument.change(onDisk: "b", saved: "a", shown: "a typed"), C.conflict("b"))
    }

    func testSavesInPlaceKeepingTheFilesMode() throws {
        let url = try file("run.sh", "#!/bin/sh\necho hi\n")
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: url.path)
        let doc = TextFileDocument(url: url)
        XCTAssertEqual(try doc.load(), "#!/bin/sh\necho hi\n")
        XCTAssertTrue(doc.isEditable)
        try doc.save("#!/bin/sh\necho bye\n")
        XCTAssertEqual(try String(contentsOf: url, encoding: .utf8), "#!/bin/sh\necho bye\n")
        XCTAssertEqual(doc.saved, "#!/bin/sh\necho bye\n")
        let mode = try FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions] as? Int
        XCTAssertEqual(mode, 0o755)
        // Shorter text doesn't leave the old tail behind.
        try doc.save("x")
        XCTAssertEqual(try String(contentsOf: url, encoding: .utf8), "x")
    }

    /// Read just before a save: someone else's write the watch hasn't
    /// reported yet shows up, its own write doesn't.
    func testChangedOnDiskSeesSomeoneElsesWrite() throws {
        let url = try file("notes.txt", "a")
        let doc = TextFileDocument(url: url)
        try doc.load()
        XCTAssertNil(try doc.changedOnDisk())
        try doc.save("b")
        XCTAssertNil(try doc.changedOnDisk(), "its own save")
        try Data("c".utf8).write(to: url)
        XCTAssertEqual(try doc.changedOnDisk(), "c")
        // Turned into something it can't write back: read only from then on.
        try Data([0x68, 0x69, 0xFF, 0xFE]).write(to: url)
        XCTAssertNotNil(try doc.changedOnDisk())
        XCTAssertFalse(doc.isEditable)
        doc.adopt("whatever")
        XCTAssertFalse(doc.isEditable, "taking the file's text doesn't make it editable")
        // Can't be read at all: nobody can say a save is safe.
        try FileManager.default.removeItem(at: url)
        XCTAssertThrowsError(try doc.changedOnDisk())
    }

    /// Bytes that aren't UTF-8 can decode to exactly the saved text: the
    /// check still marks it read only.
    func testChangedOnDiskSeesBytesThatReadTheSame() throws {
        let url = try file("same.txt", "hi\u{FFFD}")
        let doc = TextFileDocument(url: url)
        try doc.load()
        XCTAssertTrue(doc.isEditable)
        try Data([0x68, 0x69, 0xFF]).write(to: url)
        XCTAssertNil(try doc.changedOnDisk())
        XCTAssertFalse(doc.isEditable)
    }

    /// The watch, when a file being edited turns binary: the edits aren't
    /// thrown away (a conflict, read only), and putting it back as UTF-8
    /// with the same text makes it editable again.
    func testWatchKeepsEditsWhenTheFileTurnsBinary() throws {
        let url = try file("turns.txt", "hi")
        let doc = TextFileDocument(url: url)
        try doc.load()
        var seen: [TextFileDocument.Change] = []
        var shown = "hi typed"
        doc.watch(shown: { shown }) { seen.append($0) }
        defer { doc.stopWatching() }
        try Data([0x68, 0x69, 0xFF]).write(to: url)
        doc.check()
        XCTAssertEqual(seen.last, .conflict("hi\u{FFFD}"))
        XCTAssertFalse(doc.isEditable)
        // Checked again before anyone picks: the edits still aren't dropped.
        seen = []
        doc.check()
        XCTAssertEqual(seen.last ?? .same, .conflict("hi\u{FFFD}"))
        XCTAssertFalse(doc.isEditable)
        // Take the file's, then it's put back as UTF-8 with the same text.
        doc.adopt("hi\u{FFFD}")
        shown = "hi\u{FFFD}"
        try Data("hi\u{FFFD}".utf8).write(to: url)
        doc.check()
        XCTAssertEqual(seen.last, .reload("hi\u{FFFD}"))
        XCTAssertTrue(doc.isEditable)
    }

    func testBinaryAndCutOffFilesAreReadOnly() throws {
        let url = try file("blob.txt", "")
        try Data([0x68, 0x69, 0xFF, 0xFE]).write(to: url)
        let doc = TextFileDocument(url: url)
        try doc.load()
        XCTAssertTrue(doc.lossy)
        XCTAssertFalse(doc.isEditable)
        try doc.save("changed")
        XCTAssertEqual(try Data(contentsOf: url), Data([0x68, 0x69, 0xFF, 0xFE]), "a read-only file isn't written")
    }

    func testWatchReloadsWhatSomeoneElseWrote() throws {
        let url = try file("notes.md", "# One\n")
        let doc = TextFileDocument(url: url)
        try doc.load()
        var shown = "# One\n"
        let changed = expectation(description: "reload")
        var seen: [TextFileDocument.Change] = []
        doc.watch(shown: { shown }) { change in
            seen.append(change)
            changed.fulfill()
        }
        // An agent's atomic write: a new file renamed over this one.
        let temp = folder.appendingPathComponent("notes.md.tmp")
        try Data("# Two\n".utf8).write(to: temp)
        _ = try FileManager.default.replaceItemAt(url, withItemAt: temp)
        wait(for: [changed], timeout: 3)
        XCTAssertEqual(seen, [.reload("# Two\n")])
        XCTAssertEqual(doc.saved, "# Two\n")

        // Its own save isn't a change.
        shown = "# Two\nmore\n"
        try doc.save(shown)
        let quiet = expectation(description: "no change")
        quiet.isInverted = true
        seen = []
        doc.watch(shown: { shown }) { _ in quiet.fulfill() }
        wait(for: [quiet], timeout: 0.6)
        XCTAssertEqual(seen, [])

        // Someone else writes while there are unsaved edits: a conflict,
        // and nothing adopted until Mike picks.
        shown = "# Two\nmore\ntyping"
        let conflict = expectation(description: "conflict")
        doc.watch(shown: { shown }) { change in
            seen.append(change)
            conflict.fulfill()
        }
        try Data("# Three\n".utf8).write(to: url)
        wait(for: [conflict], timeout: 3)
        XCTAssertEqual(seen, [.conflict("# Three\n")])
        XCTAssertEqual(doc.saved, "# Two\nmore\n")
        doc.stopWatching()
    }
}
