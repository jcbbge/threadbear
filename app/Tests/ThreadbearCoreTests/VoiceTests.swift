import XCTest
@testable import ThreadbearCore

final class SpokenTextTests: XCTestCase {
    func testMarkdownIsReadAsWords() {
        let reply = """
        ## Dinner tonight

        Try **lemon pasta**. It takes [20 minutes](https://example.com/recipe).

        - Boil the `pasta`
        - Zest a lemon
        """
        XCTAssertEqual(SpokenText.plain(reply), "Dinner tonight. Try lemon pasta. It takes 20 minutes. Boil the pasta. Zest a lemon.")
    }

    func testCodeAndTablesAreLeftForTheScreen() {
        let reply = """
        Here it is:

        ```swift
        let x = 1
        let y = 2
        ```

        | a | b |
        |---|---|
        | 1 | 2 |

        Done.
        """
        XCTAssertEqual(SpokenText.sentences(reply), ["Here it is: " + SpokenText.codeLine, SpokenText.tableLine, "Done."])
    }

    func testBareLinksAreNotSpelledOut() {
        XCTAssertEqual(SpokenText.plain("See https://threadbear.mikecann.app/docs for more"), "See a link for more.")
    }

    func testSentencesSplitAtStops() {
        XCTAssertEqual(SpokenText.sentences("One. Two? Three! Version 1.5 is out."), ["One.", "Two?", "Three!", "Version 1.5 is out."])
    }

    func testLongSentencesAreCut() {
        let long = Array(repeating: "word", count: 80).joined(separator: " ")
        let parts = SpokenText.sentences(long, maxLength: 60)
        XCTAssertGreaterThan(parts.count, 1)
        XCTAssertTrue(parts.allSatisfy { $0.count <= 60 })
        XCTAssertEqual(parts.joined(separator: " "), long + ".")
    }

    func testNothingToSay() {
        XCTAssertEqual(SpokenText.sentences("  \n---\n"), [])
    }
}

final class VoiceCatalogTests: XCTestCase {
    func testEmilyAndMikeComeFirst() {
        XCTAssertEqual(VoiceCatalog.voices.prefix(2).map(\.name), ["Emily", "Mike"])
        XCTAssertEqual(VoiceCatalog.voice("mike").engineVoice, "michael")
        XCTAssertEqual(VoiceCatalog.voice("nobody"), VoiceCatalog.defaultVoice)
        XCTAssertEqual(Set(VoiceCatalog.voices.map(\.id)).count, VoiceCatalog.voices.count)
    }

    func testSpeeds() {
        XCTAssertEqual(VoiceCatalog.speedTitle(1), "1x")
        XCTAssertEqual(VoiceCatalog.speedTitle(1.25), "1.25x")
        XCTAssertEqual(VoiceCatalog.speed(nil), 1)
        XCTAssertEqual(VoiceCatalog.speed(1.3), 1.25)
        XCTAssertEqual(VoiceCatalog.speed(9), 2)
    }

    func testLanguageFallsBackToEnglish() {
        XCTAssertEqual(VoiceCatalog.language("klingon").id, "english")
        XCTAssertEqual(VoiceCatalog.language("french").locale, "fr-FR")
    }
}

final class UtteranceTrackerTests: XCTestCase {
    typealias R = UtteranceTracker.Result

    func testSendsAfterAPause() {
        var t = UtteranceTracker(pause: 1)
        XCTAssertTrue(t.add(R(text: "what should", start: 0, end: 1, isFinal: false), now: 10))
        t.add(R(text: "what should I cook", start: 0, end: 1.6, isFinal: false), now: 10.5)
        XCTAssertEqual(t.pending, "what should I cook")
        XCTAssertNil(t.take(now: 11.2))
        XCTAssertEqual(t.take(now: 11.6), "what should I cook")
        XCTAssertNil(t.take(now: 20))
    }

    func testFinalReplacesTheGuessItCovers() {
        var t = UtteranceTracker(pause: 1)
        t.add(R(text: "what should I cook", start: 0, end: 1.6, isFinal: false), now: 0)
        t.add(R(text: "What should I cook?", start: 0, end: 1.6, isFinal: true), now: 0.2)
        t.add(R(text: "tonight", start: 1.8, end: 2.3, isFinal: false), now: 0.4)
        XCTAssertEqual(t.pending, "What should I cook? tonight")
    }

    func testLateFinalForSentAudioIsDropped() {
        var t = UtteranceTracker(pause: 1)
        t.add(R(text: "hello there", start: 0, end: 1, isFinal: false), now: 0)
        XCTAssertEqual(t.take(now: 1.5), "hello there")
        // The recogniser finalises the same stretch after it went.
        XCTAssertFalse(t.add(R(text: "Hello there.", start: 0, end: 1, isFinal: true), now: 1.7))
        XCTAssertFalse(t.hasWords)
        // What he says next still counts.
        XCTAssertTrue(t.add(R(text: "and more", start: 1.2, end: 2, isFinal: false), now: 1.8))
        XCTAssertEqual(t.pending, "and more")
    }

    func testSilenceAloneSendsNothing() {
        var t = UtteranceTracker(pause: 1)
        XCTAssertFalse(t.add(R(text: " ", start: 0, end: 1, isFinal: true), now: 0))
        XCTAssertNil(t.take(now: 5))
        XCTAssertNil(t.flush())
    }
}

final class SpokenAnswerTests: XCTestCase {
    let all: [ApprovalOption] = [.allow, .allowAlways, .deny]

    func testYes() {
        for said in ["Yes.", "yeah go ahead", "Go ahead, please.", "Sure", "OK, do it!", "yes thank you", "Um, yes."] {
            XCTAssertEqual(SpokenAnswer.decision(said, options: all), .allow, said)
        }
    }

    func testNo() {
        for said in ["No.", "Nope", "Don't do that.", "no thanks", "Cancel"] {
            XCTAssertEqual(SpokenAnswer.decision(said, options: all), .deny, said)
        }
    }

    func testAlways() {
        XCTAssertEqual(SpokenAnswer.decision("Always allow it", options: all), .allowAlways)
        // No always on this card: not taken as a plain yes either.
        XCTAssertNil(SpokenAnswer.decision("always allow", options: [.allow, .deny]))
    }

    func testAnythingMoreIsAMessage() {
        for said in ["No, use the other folder instead", "yes but only for the tests folder", "what does that command do", "thank you", ""] {
            XCTAssertNil(SpokenAnswer.decision(said, options: all), said)
        }
    }
}

/// A spoken yes can let a tool run, so it goes only to the card he heard.
final class SpokenApprovalsTests: XCTestCase {
    private func card(_ id: String, command: String = "npm test", options: [ApprovalOption] = [.allow, .allowAlways, .deny]) -> ApprovalRequest {
        ApprovalRequest(approvalId: id, name: "Bash", title: command, input: .object(["command": .string(command)]), options: options)
    }

    /// A read-out finishing at 10, and him speaking at 11 with the app quiet since 10.
    private func answer(_ a: inout SpokenApprovals, _ said: String, at: Double = 11) -> SpokenApprovals.Outcome {
        a.take(said, spokenAt: at, quietSince: 10)
    }

    func testNothingWaitingIsAMessage() {
        var a = SpokenApprovals()
        XCTAssertEqual(answer(&a, "yes"), .message)
    }

    func testAYesAnswersTheCardReadOut() {
        var a = SpokenApprovals()
        let first = card("a")
        a.requested(first)
        a.readOut(first, at: 10)
        XCTAssertEqual(answer(&a, "yes"), .answer(first, .allow))
        XCTAssertTrue(a.open.isEmpty)
        XCTAssertEqual(answer(&a, "yes"), .message, "answered once, and that's it")
    }

    func testBeforeItIsReadOutAYesAnswersNothing() {
        var a = SpokenApprovals()
        let first = card("a")
        a.requested(first)
        XCTAssertEqual(answer(&a, "yes"), .readAgain(first))
        XCTAssertEqual(a.open, [first], "still waiting")
    }

    /// The one the review found: a new card just before he speaks.
    func testANewCardJustBeforeHeSpeaksDoesNotTakeHisYes() {
        var a = SpokenApprovals()
        let first = card("a"), second = card("b", command: "rm -rf build")
        a.requested(first)
        a.readOut(first, at: 10)
        a.requested(second)
        XCTAssertEqual(answer(&a, "yes"), .readAgain(second))
        XCTAssertEqual(a.open, [first, second], "neither was answered")
    }

    /// Codex's: he says yes to A, the recogniser sits on it, B arrives and is
    /// read out, and only then does his yes reach us.
    func testAYesSaidBeforeTheCardWasReadOutDoesNotAnswerIt() {
        var a = SpokenApprovals()
        let first = card("a"), second = card("b")
        a.requested(first)
        a.readOut(first, at: 10)
        a.requested(second)
        a.readOut(second, at: 20)
        XCTAssertEqual(a.take("yes", spokenAt: 11, quietSince: 20), .readAgain(second))
        XCTAssertEqual(a.open, [first, second])
    }

    /// Codex's: its own "always allow" heard from the speakers.
    func testWordsSaidWhileItTalksDoNotAnswer() {
        var a = SpokenApprovals()
        let first = card("a")
        a.requested(first)
        a.readOut(first, at: 10)
        XCTAssertEqual(a.take("yes", spokenAt: 11, quietSince: .infinity), .readAgain(first), "still talking")
        a.readOut(first, at: 10)
        XCTAssertEqual(a.take("yes", spokenAt: 11, quietSince: 12), .readAgain(first), "stopped after he started")
        a.readOut(first, at: 10)
        XCTAssertEqual(a.take("yes", spokenAt: -.infinity, quietSince: 10), .readAgain(first), "no idea when it was said")
        a.readOut(first, at: 10)
        XCTAssertEqual(a.take("yes", spokenAt: 12, quietSince: 12), .answer(first, .allow))
    }

    func testAnOlderCardFinishingItsReadOutDoesNotBindOverANewerOne() {
        var a = SpokenApprovals()
        let first = card("a"), second = card("b")
        a.requested(first)
        a.requested(second)
        a.readOut(first, at: 10)
        XCTAssertNil(a.heard)
        XCTAssertEqual(answer(&a, "yes"), .readAgain(second))
        a.readOut(second, at: 10)
        XCTAssertEqual(answer(&a, "yes"), .answer(second, .allow))
        // Then the older one, once it has been read in turn.
        XCTAssertEqual(answer(&a, "yes"), .readAgain(first))
        a.readOut(first, at: 10)
        XCTAssertEqual(answer(&a, "no"), .answer(first, .deny))
    }

    func testAGoneCardIsNotAnswered() {
        var a = SpokenApprovals()
        let first = card("a")
        a.requested(first)
        a.readOut(first, at: 10)
        a.resolved("a")
        XCTAssertEqual(answer(&a, "yes"), .message)
    }

    func testAChangedCardMustBeHeardAgain() {
        var a = SpokenApprovals()
        let first = card("a", command: "npm test"), changed = card("a", command: "rm -rf build")
        a.requested(first)
        a.readOut(first, at: 10)
        a.requested(changed)
        XCTAssertEqual(answer(&a, "yes"), .readAgain(changed))
        // The first wording's read-out finishing late doesn't count for it.
        a.readOut(first, at: 10)
        XCTAssertEqual(answer(&a, "yes"), .readAgain(changed))
        a.readOut(changed, at: 10)
        XCTAssertEqual(answer(&a, "yes"), .answer(changed, .allow))
    }

    func testAlwaysOnlyWhereTheCardOffersIt() {
        var a = SpokenApprovals()
        let first = card("a", options: [.allow, .deny])
        a.requested(first)
        a.readOut(first, at: 10)
        XCTAssertEqual(answer(&a, "always allow"), .readAgain(first), "not a plain yes, and read out again")
        a.readOut(first, at: 10)
        XCTAssertEqual(answer(&a, "yes"), .answer(first, .allow))
    }

    func testLongerWordsAreAMessage() {
        var a = SpokenApprovals()
        let first = card("a")
        a.requested(first)
        a.readOut(first, at: 10)
        XCTAssertEqual(answer(&a, "no, use the other folder"), .message)
        XCTAssertEqual(a.heard, first, "still the card he heard")
    }

    /// Codex's: the first line of a command read out, the rest approved.
    func testACardTheWordsCannotCoverIsLeftToTheScreen() {
        let hidden = "echo checking\nrm -rf important"
        let cards = [
            // A title that isn't the whole command, as a multi-line one's isn't.
            ApprovalRequest(approvalId: "a", name: "Bash", title: "echo checking", input: .object(["command": .string(hidden)])),
            // No command to compare it with.
            ApprovalRequest(approvalId: "b", name: "Bash", title: "echo checking"),
            // What's written isn't in the title.
            ApprovalRequest(approvalId: "c", name: "Edit", title: "Edit a.ts", input: .object(["file_path": .string("a.ts")])),
            ApprovalRequest(approvalId: "d", name: "mcp__x__do", title: "x: do"),
            ApprovalRequest(approvalId: "e", name: StartRequest.cardName, title: "Start a thread"),
            ApprovalRequest(approvalId: "f", name: "ExitPlanMode", title: "Finish the plan"),
            card("g", command: String(repeating: "x", count: 161)),
            // Codex's second round: what can't be heard for what it is.
            card("h", command: "echo checking; rm -rf important"),
            card("i", command: "cat $(echo secret)"),
            card("j", command: "./safe\u{200B}"),
            card("k", command: "c\u{0430}t notes"),
            ApprovalRequest(approvalId: "l", name: "Read", title: "Read .env", input: .object(["file_path": .string("/production/.env")])),
        ]
        for each in cards {
            var a = SpokenApprovals()
            a.requested(each)
            XCTAssertNil(SpokenApprovals.reading(of: each), each.approvalId)
            a.readOut(each, at: 10)
            XCTAssertNil(a.heard, each.approvalId)
            XCTAssertEqual(answer(&a, "yes"), .onScreen(each), each.approvalId)
            XCTAssertEqual(a.open, [each], each.approvalId)
        }
    }

    func testAOneLineCommandIsReadAsItStands() {
        let command = "npm run test:unit -- --filter=a.b/c,d"
        XCTAssertEqual(SpokenApprovals.reading(of: card("a", command: command)), command)
    }

    func testClearForgetsAll() {
        var a = SpokenApprovals()
        let first = card("a")
        a.requested(first)
        a.readOut(first, at: 10)
        a.clear()
        XCTAssertEqual(answer(&a, "yes"), .message)
    }
}

final class SpokenAnswerWholePhraseTests: XCTestCase {
    let all: [ApprovalOption] = [.allow, .allowAlways, .deny]

    /// Codex's: questions that were a bag of allowed words.
    func testQuestionsAreNotAnswers() {
        for said in ["Do you always do that?", "Is that always on?", "Is that it?", "Do it for that?", "Go for it on that", "Not that way", "It's fine", "good", "go", "always", "do", "You always allow it?", "You approve it", "Okay?", "you always allow it", "do you"] {
            XCTAssertNil(SpokenAnswer.decision(said, options: all), said)
        }
    }

    func testWholeAnswers() {
        XCTAssertEqual(SpokenAnswer.decision("Yes, go ahead and do it.", options: all), .allow)
        XCTAssertEqual(SpokenAnswer.decision("Yes, always allow.", options: all), .allowAlways)
        XCTAssertEqual(SpokenAnswer.decision("No, don't do that.", options: all), .deny)
    }

    func testTheTrackerSaysWhereWhatsWaitingStarts() {
        var t = UtteranceTracker(pause: 1)
        XCTAssertNil(t.pendingStart)
        t.add(.init(text: "yes", start: 4.5, end: 5, isFinal: true), now: 0)
        t.add(.init(text: "go ahead", start: 5.2, end: 6, isFinal: false), now: 0)
        XCTAssertEqual(t.pendingStart, 4.5)
        _ = t.flush()
        XCTAssertNil(t.pendingStart)
    }
}
