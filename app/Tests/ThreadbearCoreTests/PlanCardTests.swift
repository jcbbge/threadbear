import XCTest
@testable import ThreadbearCore

/// "Plan first" (docs/protocol.md): the plan card, its approval, and the
/// checklist it turns into.
final class PlanCardTests: XCTestCase {
    private func card(_ model: TranscriptModel, _ itemId: String = "tu1") -> PlanCard? {
        for row in model.rows { if case .planCard(let card) = row.content, card.itemId == itemId { return card } }
        return nil
    }

    /// Claude's plan: tool.call, plan.proposed, then the ExitPlanMode approval.
    private func claudePlan(from seq: Int = 1) -> [Event] {
        [
            E.call(seq, "tu1", name: "ExitPlanMode", kind: "other", title: "Finish the plan", input: ["plan": "1. A\n2. B"]),
            E.event(seq + 1, "plan.proposed", ["itemId": "tu1", "text": "1. A\n2. B"]),
            E.event(seq + 2, "approval.requested", ["approvalId": "ap1", "itemId": "tu1", "name": "ExitPlanMode", "title": "Finish the plan", "input": [:], "options": ["allow", "deny"]]),
        ]
    }

    func testClaudesPlanIsOneCardThatReturnApproves() {
        let model = TranscriptModel(events: [E.user(0, "Plan it")] + claudePlan())
        XCTAssertEqual(card(model)?.state, .waiting)
        // No generic approval card beside it, but Return still answers it.
        XCTAssertFalse(model.rows.contains { if case .approval = $0.content { return true } else { return false } })
        XCTAssertEqual(model.pendingApprovalIds, ["ap1"])
    }

    func testApprovedPlanTakesItsStepsThenLaterTurnsGetTheirOwn() {
        var model = TranscriptModel(events: [E.user(0, "Plan it")] + claudePlan())
        _ = model.apply([
            E.event(4, "approval.resolved", ["approvalId": "ap1", "decision": "allow"]),
            E.event(5, "plan.resolved", ["itemId": "tu1", "decision": "go"]),
            E.event(6, "plan.updated", ["entries": [["text": "A", "status": "completed"], ["text": "B", "status": "in_progress"]]]),
        ])
        XCTAssertEqual(model.pendingApprovalIds, [])
        XCTAssertEqual(card(model)?.state, .approved)
        XCTAssertEqual(card(model)?.entries.map(\.text), ["A", "B"])
        XCTAssertFalse(model.rows.contains { $0.kind == .plan }, "no second checklist")
        _ = model.apply([
            E.event(7, "turn.completed", ["turnId": "t1", "outcome": "completed", "durationMs": 10]),
            E.event(8, "turn.started", ["turnId": "t2"], turn: "t2"),
            E.event(9, "plan.updated", ["entries": [["text": "Other", "status": "pending"]]], turn: "t2"),
        ])
        XCTAssertEqual(card(model)?.entries.map(\.text), ["A", "B"])
        XCTAssertTrue(model.rows.contains { $0.kind == .plan })
    }

    func testCodexPlanGoesAheadInTheNextTurn() {
        var model = TranscriptModel(events: [
            E.user(0, "Plan it"),
            E.event(1, "plan.proposed", ["itemId": "p1", "text": "Do it"]),
            E.event(2, "turn.completed", ["turnId": "t1", "outcome": "completed", "durationMs": 10]),
        ])
        _ = model.apply([
            E.event(3, "plan.resolved", ["itemId": "p1", "decision": "go"], turn: nil),
            E.event(4, "turn.started", ["turnId": "t2"], turn: "t2"),
            E.event(5, "plan.updated", ["entries": [["text": "Do it", "status": "in_progress"]]], turn: "t2"),
        ])
        XCTAssertEqual(card(model, "p1")?.entries.count, 1)
    }

    func testSentBackStaysAPlanWithNoButtons() {
        var model = TranscriptModel(events: [E.user(0, "Plan it")] + claudePlan())
        _ = model.apply([
            E.event(4, "approval.resolved", ["approvalId": "ap1", "decision": "deny"]),
            E.event(5, "plan.resolved", ["itemId": "tu1", "decision": "revise"]),
        ])
        XCTAssertEqual(card(model)?.state, .sentBack)
        XCTAssertEqual(model.pendingApprovalIds, [])
    }

    func testThePlanFileIsntAChange() {
        XCTAssertTrue(TranscriptModel.isPlanFile("/Users/mike/.claude/plans/plan-add-csv-tender-puffin.md"))
        XCTAssertFalse(TranscriptModel.isPlanFile("/Users/mike/dev/app/plans/next.md"))
    }

    func testAHeadingBecomesTheTitle() {
        XCTAssertEqual(PlanCardText.split("# Plan: add CSV\n\n## Steps\n1. A").title, "Plan: add CSV")
        XCTAssertEqual(PlanCardText.split("# Plan: add CSV\n\n## Steps\n1. A").body, "## Steps\n1. A")
        XCTAssertEqual(PlanCardText.split("## Add `bye.txt`\n\n### Steps").title, "Add `bye.txt`")
        XCTAssertNil(PlanCardText.split("1. A\n2. B").title)
        XCTAssertNil(PlanCardText.split("#hashtag plan").title)
    }

    func testPreviewCutsALongPlanAtALine() {
        let short = (1...13).map { "Line \($0)" }.joined(separator: "\n")
        XCTAssertFalse(PlanCardText.preview(short).clipped, "a line or two over shows whole")
        let long = (1...30).map { "Line \($0)" }.joined(separator: "\n")
        let (text, clipped) = PlanCardText.preview(long)
        XCTAssertTrue(clipped)
        XCTAssertEqual(text.components(separatedBy: "\n").count, PlanCardText.previewLines)
        let fenced = "# Plan\n```\n" + (1...30).map { "code \($0)" }.joined(separator: "\n") + "\n```"
        XCTAssertTrue(PlanCardText.preview(fenced).text.hasSuffix("```"))
    }
}
