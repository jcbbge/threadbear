import XCTest
@testable import ThreadbearCore

/// docs/protocol.md, "Needs you", Answering: stepping through the open
/// card's asks and the one message that answers them.
final class DecisionsTests: XCTestCase {
    private let merge = Ask(action: "Merge #52 to prod, or test locally first?", why: "Preview is green.", options: ["Merge", "Test locally first"], suggested: 0)
    private let signIn = Ask(action: "Sign in to PostHog in Chrome", reply: "done")
    private let events = Ask(action: "Which events matter most?")

    func testDecodesOptionsAndDropsAPickThatIsNotOne() throws {
        let json = #"{"action":"a","why":"w","options":["x","y"],"suggested":1}"#
        let ask = try JSONDecoder().decode(Ask.self, from: Data(json.utf8))
        XCTAssertEqual(ask.options, ["x", "y"])
        XCTAssertEqual(ask.suggested, 1)
        XCTAssertEqual(ask.why, "w")
        let bad = try JSONDecoder().decode(Ask.self, from: Data(#"{"action":"a","options":["x"],"suggested":3}"#.utf8))
        XCTAssertNil(bad.suggested)
        let plain = try JSONDecoder().decode(Ask.self, from: Data(#"{"action":"a"}"#.utf8))
        XCTAssertEqual(plain.options, [])
    }

    /// A plain ask offers its reply words; one with neither has only his own.
    func testChoices() {
        XCTAssertEqual(Decisions.choices(for: merge), ["Merge", "Test locally first"])
        XCTAssertEqual(Decisions.choices(for: signIn), ["done"])
        XCTAssertEqual(Decisions.choices(for: events), [])
    }

    /// An ask with neither still gets the word it asks for as a button.
    func testChoicesFromTheAsksOwnWords() {
        XCTAssertEqual(Decisions.choices(for: Ask(action: "Say go for Short 2 (Thomas on AI being dumb), or name another")), ["Go"])
        XCTAssertEqual(Decisions.choices(for: Ask(action: "Have a look, then reply \"export\" and I'll upload it")), ["export"])
        XCTAssertEqual(Decisions.choices(for: Ask(action: "Reply “ship it” for the plan")), ["ship it"])
        XCTAssertEqual(Decisions.choices(for: Ask(action: "Say whether $1 a day is right")), [])
        XCTAssertEqual(Decisions.choices(for: Ask(action: "Paste your key, then say \"key set\"", options: ["Done"])), ["Done"])
    }

    /// A list of quoted answers is a button each, not just the first
    /// (an ask from a turn that skipped end_turn, 28 Oct).
    func testChoicesFromAListOfQuotedAnswers() {
        let ask = Ask(action: "Say whether to keep \"Browser\" or rename the row to \"Website\", and whether to land it. Reply with \"Land it\", \"Website, then land it\", or what else to change.")
        XCTAssertEqual(Decisions.choices(for: ask), ["Land it", "Website, then land it"])
        XCTAssertEqual(Decisions.choices(for: Ask(action: "Reply \"merge\", \"wait\" or \"close\"")), ["merge", "wait", "close"])
        XCTAssertEqual(Decisions.choices(for: Ask(action: "Reply “yes” / “no”")), ["yes", "no"])
        // A quote further on isn't one of them.
        XCTAssertEqual(Decisions.choices(for: Ask(action: "Reply \"go\" when the \"Export\" step is done")), ["go"])
    }

    /// The card shows an ask the way the agent would have written it in
    /// its message: the action, then the why.
    func testAParagraphIsTheActionThenTheWhy() {
        XCTAssertEqual(Decisions.paragraph(Ask(action: "Pick a layout for the card", why: "Three mockups are in the review window.")),
                       "Pick a layout for the card. Three mockups are in the review window.")
        XCTAssertEqual(Decisions.paragraph(Ask(action: "Did it lock when you walked away?", why: "I picked the cutoff.")),
                       "Did it lock when you walked away? I picked the cutoff.")
        // A sentence that ends inside quotes, brackets or bold has its stop.
        XCTAssertEqual(Decisions.paragraph(Ask(action: "Tell me \"it locked.\"", why: "Then I tune it.")), "Tell me \"it locked.\" Then I tune it.")
        XCTAssertEqual(Decisions.paragraph(Ask(action: "Pair it (System Settings › Bluetooth.)", why: "Only paired phones count.")),
                       "Pair it (System Settings › Bluetooth.) Only paired phones count.")
        XCTAssertEqual(Decisions.paragraph(Ask(action: "Merge **#48**", why: "Checks pass.")), "Merge **#48**. Checks pass.")
        // No why, or an empty one: just the action.
        XCTAssertEqual(Decisions.paragraph(Ask(action: "Log in to Hugging Face")), "Log in to Hugging Face")
        XCTAssertEqual(Decisions.paragraph(Ask(action: "Log in", why: "  ")), "Log in")
        // The why's line breaks stay, so a list in it draws as one (Mike, 29
        // Oct: four questions run together were hard to read). The action
        // is a sentence, so its breaks still go.
        XCTAssertEqual(Decisions.paragraph(Ask(action: "Answer the\nfour questions", why: "My picks are in brackets:\n- Two or more logins? (yes)\n- On this Mac? (yes)\n")),
                       "Answer the four questions. My picks are in brackets:\n- Two or more logins? (yes)\n- On this Mac? (yes)")
        XCTAssertEqual(Decisions.paragraph(Ask(action: "Check the build", why: "It failed once.\n\nThe log has why.")),
                       "Check the build. It failed once.\n\nThe log has why.")
    }

    /// Markdown that starts an ask's text past a marker ("2. ", "- [ ] ")
    /// keeps the lines after the first in the same list item.
    func testContinuedLinesStayInTheListItem() {
        XCTAssertEqual(Decisions.continued("Picks:\n- one\n\n- two", under: "2. "), "Picks:\n   - one\n\n   - two")
        XCTAssertEqual(Decisions.continued("One line", under: "- [ ] "), "One line")
    }

    func testDecodesLinksAndWhatTheyOpen() throws {
        let json = #"{"action":"a","links":[{"title":"Open login","url":"https://hf.co/login"},{"title":"Notes","url":"~/notes.md"},{"title":"bad"}]}"#
        let ask = try JSONDecoder().decode(Ask.self, from: Data(json.utf8))
        XCTAssertEqual(ask.links, [AskLink(title: "Open login", url: "https://hf.co/login"), AskLink(title: "Notes", url: "~/notes.md")])
        XCTAssertEqual(ask.links[0].target?.absoluteString, "https://hf.co/login")
        XCTAssertEqual(ask.links[1].target?.path, NSHomeDirectory() + "/notes.md")
        XCTAssertNil(AskLink(title: "x", url: "javascript:alert(1)").target)
    }

    /// Numbered as on the card, question then answer, unpicked ones left
    /// out with the others keeping their numbers, then his own words.
    func testMessage() {
        let text = Decisions.message(asks: [merge, signIn, events], picks: [0: 1, 1: 0], extra: "  Also bump the version.  ")
        XCTAssertEqual(text, """
        1. Merge #52 to prod, or test locally first?
           Test locally first

        2. Sign in to PostHog in Chrome
           done

        Also bump the version.
        """)
        XCTAssertEqual(Decisions.message(asks: [merge], picks: [0: 0]), "Merge #52 to prod, or test locally first?\nMerge")
        XCTAssertEqual(Decisions.message(asks: [events], picks: [:], extra: "just this"), "just this")
        // A pick that isn't one of its choices doesn't count.
        XCTAssertEqual(Decisions.message(asks: [events], picks: [0: 0]), "")
        XCTAssertEqual(Decisions.answers(asks: [merge, events], picks: [0: 0, 1: 2]).map(\.answer), [AskAnswer(action: merge.action, answer: "Merge")])
    }

    /// The bubble finds his own words after the answers, or shows the text
    /// as it is when it doesn't start with them.
    func testExtraAfterTheAnswers() {
        let asks = [merge, signIn, events]
        let answers = Decisions.answers(asks: asks, picks: [0: 0, 1: 0]).map(\.answer)
        let text = Decisions.message(asks: asks, picks: [0: 0, 1: 0], extra: "Also this.\n\nAnd that.")
        XCTAssertEqual(Decisions.extra(in: text, answers: answers), "Also this.\n\nAnd that.")
        XCTAssertEqual(Decisions.extra(in: Decisions.message(asks: [merge], picks: [0: 1]), answers: [AskAnswer(action: merge.action, answer: "Test locally first")]), "")
        XCTAssertNil(Decisions.extra(in: "something else", answers: answers))
        XCTAssertNil(Decisions.extra(in: text, answers: []))
    }

    /// "Something else": each ask's own box is its answer, with his line
    /// breaks kept, and the composer's words come after as extra. Any
    /// number of asks can have one.
    func testSomethingElseTakesWhatHeWroteInItsBox() {
        let picks = [0: Decisions.ownAnswer, 1: 0, 2: Decisions.ownAnswer]
        let notes = [0: AskNote(text: "ThreadbearThreads"), 2: AskNote(text: " Signups\nand searches ")]
        let text = Decisions.message(asks: [merge, signIn, events], picks: picks, notes: notes, extra: "Thanks")
        XCTAssertEqual(text, """
        1. Merge #52 to prod, or test locally first?
           ThreadbearThreads

        2. Sign in to PostHog in Chrome
           done

        3. Which events matter most?
           Signups
           and searches

        Thanks
        """)
        let answers = Decisions.answers(asks: [merge, signIn, events], picks: picks, notes: notes).map(\.answer)
        XCTAssertEqual(answers.last, AskAnswer(action: events.action, answer: "Signups\nand searches"))
        XCTAssertEqual(Decisions.extra(in: text, answers: answers), "Thanks")
        // Nothing written: that ask isn't answered.
        XCTAssertEqual(Decisions.message(asks: [merge, events], picks: [1: Decisions.ownAnswer]), "")
        XCTAssertEqual(Decisions.message(asks: [events], picks: [0: Decisions.ownAnswer], notes: [0: AskNote(text: "Signups")]), "Which events matter most?\nSignups")
        // A box left with words in it after its Something else is taken back doesn't go.
        XCTAssertEqual(Decisions.message(asks: [events], picks: [:], notes: [0: AskNote(text: "Signups")], extra: "hi"), "hi")
    }

    /// Pictures in the boxes go first, in the card's order, numbered
    /// across the card, each a marker where its chip is in the box; a box
    /// can be just pictures, and one with no chip goes at the end.
    func testPicturesInTheBoxesAreNumberedAcrossTheCard() {
        let shot = { (name: String) in ImageRef(path: "/tmp/\(name).png", mediaType: "image/png") }
        let m = InlinePictures.markString
        let picks = [0: Decisions.ownAnswer, 1: Decisions.ownAnswer, 2: Decisions.ownAnswer]
        let notes = [
            0: AskNote(text: "Like this \(m)", images: [shot("a")]),
            1: AskNote(text: "\(m) \(m)", images: [shot("b"), shot("c")]),
            2: AskNote(text: "\(m) beats \(m), and", images: [shot("d"), shot("e"), shot("f")]),
        ]
        let answers = Decisions.answers(asks: [merge, signIn, events], picks: picks, notes: notes).map(\.answer.answer)
        XCTAssertEqual(answers, ["Like this [Picture 1]", "[Picture 2] [Picture 3]", "[Picture 4] beats [Picture 5], and [Picture 6]"])
        XCTAssertEqual(Decisions.images(asks: [merge, signIn, events], picks: picks, notes: notes).map(\.path),
                       ["a", "b", "c", "d", "e", "f"].map { "/tmp/\($0).png" })
        // A box whose Something else was taken back sends no pictures.
        XCTAssertEqual(Decisions.images(asks: [merge, signIn, events], picks: [1: Decisions.ownAnswer], notes: notes).count, 2)
    }

    /// One reply's answers come with what each does; a list that doesn't
    /// line up with the options is dropped rather than guessed at.
    func testOptionNotesDecodeWhenTheyLineUp() throws {
        let good = try JSONDecoder().decode(Ask.self, from: Data(#"{"action":"Deploy?","options":["Deploy it","Hold off"],"optionNotes":["I deploy and check it went out",""]}"#.utf8))
        XCTAssertEqual(good.optionNotes, ["I deploy and check it went out", ""])
        let short = try JSONDecoder().decode(Ask.self, from: Data(#"{"action":"Deploy?","options":["Deploy it","Hold off"],"optionNotes":["Only one"]}"#.utf8))
        XCTAssertEqual(short.optionNotes, [])
        let none = try JSONDecoder().decode(Ask.self, from: Data(#"{"action":"Deploy?","options":["Deploy it"]}"#.utf8))
        XCTAssertEqual(none.optionNotes, [])
        let back = try JSONDecoder().decode(Ask.self, from: JSONEncoder().encode(good))
        XCTAssertEqual(back, good)
    }

    /// Return in a Something else box goes on to the next ask with no
    /// pick rather than sending (Mike, 7 Nov: Return on ask 7 of 10 sent
    /// the card with 8 to 10 unanswered), wrapping round to earlier ones.
    func testNextUnansweredSkipsAnsweredAndWraps() {
        XCTAssertEqual(Decisions.nextUnanswered(after: 6, count: 10, picks: [0: 0, 6: Decisions.ownAnswer]), 7)
        XCTAssertEqual(Decisions.nextUnanswered(after: 2, count: 4, picks: [2: 1, 3: 0]), 0)
        XCTAssertEqual(Decisions.nextUnanswered(after: 0, count: 3, picks: [0: 0, 1: 1]), 2)
        // Every other ask answered (this one too, or not): nothing left, so Return sends.
        XCTAssertNil(Decisions.nextUnanswered(after: 1, count: 3, picks: [0: 0, 1: Decisions.ownAnswer, 2: 1]))
        XCTAssertNil(Decisions.nextUnanswered(after: 0, count: 2, picks: [1: 0]))
        XCTAssertNil(Decisions.nextUnanswered(after: 0, count: 1, picks: [:]))
        // The composer's Return counts the ask showing as well, after the rest.
        XCTAssertEqual(Decisions.nextUnanswered(after: 1, count: 2, picks: [0: Decisions.ownAnswer], orThis: true), 1)
        XCTAssertEqual(Decisions.nextUnanswered(after: 1, count: 3, picks: [0: 0], orThis: true), 2)
        XCTAssertEqual(Decisions.nextUnanswered(after: 0, count: 1, picks: [:], orThis: true), 0)
        XCTAssertNil(Decisions.nextUnanswered(after: 0, count: 2, picks: [0: 0, 1: 1], orThis: true))
    }

    /// Something else with an empty box sends nothing for that ask, so
    /// it's still unanswered (a Return there mustn't send the rest).
    func testAnEmptySomethingElseBoxIsNotAnAnswer() {
        let own = Decisions.ownAnswer
        let picks = [0: own, 1: 0, 2: own, 3: own]
        let notes = [0: AskNote(text: "  \n"), 2: AskNote(text: "mine"), 3: AskNote(text: "", images: [ImageRef(path: "/tmp/a.png", mediaType: "image/png")])]
        XCTAssertEqual(Decisions.filled(picks: picks, notes: notes), [1: 0, 2: own, 3: own])
        XCTAssertEqual(Decisions.nextUnanswered(after: 3, count: 4, picks: Decisions.filled(picks: picks, notes: notes)), 0)
    }
}
