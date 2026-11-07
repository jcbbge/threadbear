import XCTest
@testable import ThreadbearCore

/// Dragging a screenshot's floating thumbnail hands over a temp file that
/// macOS deletes as the drop ends, before the runner has read it (issue #2).
/// The composer keeps a copy of any picture dropped from a temp folder.
final class DroppedFilesTests: XCTestCase {
    var temp: URL!
    var keep: URL!

    override func setUpWithError() throws {
        temp = FileManager.default.temporaryDirectory.appendingPathComponent("dropped-\(UUID().uuidString)", isDirectory: true)
        keep = temp.appendingPathComponent("threadbear-paste", isDirectory: true)
        try FileManager.default.createDirectory(at: temp, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: temp)
    }

    func testTempFoldersAreTransient() {
        XCTAssertTrue(DroppedFiles.isTransient(URL(fileURLWithPath: "/var/folders/rz/abc/T/TemporaryItems/NSIRD_screencaptureui_x/Screenshot.png"), temp: temp))
        XCTAssertTrue(DroppedFiles.isTransient(URL(fileURLWithPath: "/private/var/folders/rz/abc/T/TemporaryItems/NSIRD_screencaptureui_x/Screenshot.png"), temp: temp))
        XCTAssertTrue(DroppedFiles.isTransient(temp.appendingPathComponent("shot.png"), temp: temp))
        XCTAssertFalse(DroppedFiles.isTransient(URL(fileURLWithPath: "/Users/me/Desktop/Screenshot.png"), temp: temp))
        // A network share's own TemporaryItems could stall the drop.
        XCTAssertFalse(DroppedFiles.isTransient(URL(fileURLWithPath: "/Volumes/Share/TemporaryItems/shot.png"), temp: temp))
        // Its own copies aren't copied again.
        XCTAssertFalse(DroppedFiles.isTransient(keep.appendingPathComponent("a/shot.png"), temp: temp, keep: keep))
    }

    func testATempPictureIsCopiedUnderItsOwnName() throws {
        let src = temp.appendingPathComponent("Screenshot 2026-11-05 at 4.46.12\u{202F}PM.png")
        try Data([0x89, 0x50, 0x4E, 0x47]).write(to: src)
        let elsewhere = URL(fileURLWithPath: "/Users/me/Desktop/kept.png")

        let out = DroppedFiles.keepingTransient([src, elsewhere], temp: temp, into: keep)
        XCTAssertEqual(out.count, 2)
        XCTAssertNotEqual(out[0], src)
        XCTAssertEqual(out[0].lastPathComponent, src.lastPathComponent)
        XCTAssertTrue(out[0].path.hasPrefix(keep.path))
        // The original going away (as the thumbnail's does) leaves the copy.
        try FileManager.default.removeItem(at: src)
        XCTAssertEqual(try Data(contentsOf: out[0]), Data([0x89, 0x50, 0x4E, 0x47]))
        XCTAssertEqual(out[1], elsewhere)
    }

    /// Copying in Photos puts a file in the Photos library on the clipboard,
    /// which needs a permission Threadbear hasn't got, and the JPEG itself.
    func testPhotosLibraryFilesAreSpotted() {
        XCTAssertTrue(DroppedFiles.isInPhotosLibrary(URL(fileURLWithPath: "/Users/me/Pictures/Photos Library.photoslibrary/resources/derivatives/4/ABC_1_105_c.jpeg")))
        XCTAssertFalse(DroppedFiles.isInPhotosLibrary(URL(fileURLWithPath: "/Users/me/Pictures/holiday.jpeg")))
    }

    func testImageDataIsSavedUnderTheFilesName() throws {
        let jpeg = Data([0xFF, 0xD8, 0xFF, 0xE0])
        let saved = try XCTUnwrap(DroppedFiles.save(jpeg, named: "ABC_1_105_c.jpeg", into: keep))
        XCTAssertEqual(saved.lastPathComponent, "ABC_1_105_c.jpeg")
        XCTAssertTrue(saved.path.hasPrefix(keep.path))
        XCTAssertEqual(try Data(contentsOf: saved), jpeg)
        // Two with the same name don't overwrite each other.
        let again = try XCTUnwrap(DroppedFiles.save(jpeg, named: "ABC_1_105_c.jpeg", into: keep))
        XCTAssertNotEqual(again, saved)
    }

    /// A screen recording's floating thumbnail is in the same space; it
    /// goes in as a path, which has to outlive the drop.
    func testARecordingThatWouldVanishIsKeptToo() throws {
        let space = temp.appendingPathComponent("TemporaryItems/NSIRD_screencaptureui_x", isDirectory: true)
        try FileManager.default.createDirectory(at: space, withIntermediateDirectories: true)
        let mov = space.appendingPathComponent("Screen Recording.mov")
        try Data(repeating: 7, count: 64).write(to: mov)
        XCTAssertTrue(DroppedFiles.isVanishing(mov))

        let out = try XCTUnwrap(DroppedFiles.keepingVanishing([mov], into: keep).first)
        try FileManager.default.removeItem(at: mov)
        XCTAssertEqual(out.lastPathComponent, "Screen Recording.mov")
        XCTAssertEqual(try Data(contentsOf: out).count, 64)
    }

    /// A document in an ordinary temp folder stays put, so an agent asked
    /// to edit it edits that file and not a copy.
    func testADocumentInAnOrdinaryTempFolderStaysWhereItIs() throws {
        let doc = temp.appendingPathComponent("config.json")
        try Data("{}".utf8).write(to: doc)
        XCTAssertFalse(DroppedFiles.isVanishing(doc))
        XCTAssertEqual(DroppedFiles.keepingVanishing([doc], into: keep), [doc])
    }

    /// Copied on the main thread during the drop, so a folder isn't.
    func testAFolderIsNotCopied() throws {
        let space = temp.appendingPathComponent("TemporaryItems/big", isDirectory: true)
        try FileManager.default.createDirectory(at: space, withIntermediateDirectories: true)
        XCTAssertEqual(DroppedFiles.keepingVanishing([space], into: keep), [space])
        XCTAssertEqual(DroppedFiles.keepingTransient([space], temp: temp, into: keep), [space])
    }

    func testASymlinkIsKeptAsTheFileItPointsAt() throws {
        let target = temp.appendingPathComponent("real.png")
        try Data([1, 2, 3]).write(to: target)
        let link = temp.appendingPathComponent("link.png")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: target)

        let out = try XCTUnwrap(DroppedFiles.keepingTransient([link], temp: temp, into: keep).first)
        XCTAssertEqual(out.lastPathComponent, "link.png")
        try FileManager.default.removeItem(at: target)
        XCTAssertEqual(try Data(contentsOf: out), Data([1, 2, 3]))
    }

    func testAFileThatCannotBeCopiedIsPassedOnAsItWas() {
        let gone = temp.appendingPathComponent("gone.png")
        XCTAssertEqual(DroppedFiles.keepingTransient([gone], temp: temp, into: keep), [gone])
    }
}
