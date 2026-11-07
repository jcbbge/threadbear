import AppKit
import SwiftUI
import ThreadbearCore

/// The sidebar's small animations, in one place so they share timings and
/// all go quiet together under Reduce Motion (System Settings >
/// Accessibility > Display), where movement becomes a short fade or
/// nothing. Everything here runs on things Mike does many times a day, so
/// each stays well under a quarter of a second and never holds up a click
/// (Mike asked for "a bit of juice" 27 Oct).
@MainActor
enum Juice {
    static var reduceMotion: Bool { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }

    /// Rows arriving, leaving and gliding between Inbox and Running.
    static var rows: Animation {
        reduceMotion ? .easeInOut(duration: 0.15) : .snappy(duration: 0.32, extraBounce: 0.04)
    }

    /// The selected row's highlight sliding to the next one. Short, as the
    /// arrow keys repeat; none at all under Reduce Motion.
    static var selection: Animation? { reduceMotion ? nil : .snappy(duration: 0.2) }

    /// Hover highlights and buttons fading in and out.
    static let hover = Animation.easeOut(duration: 0.12)

    /// Small things popping in: an unread dot, a badge.
    static var pop: Animation {
        reduceMotion ? .easeOut(duration: 0.12) : .spring(response: 0.3, dampingFraction: 0.55)
    }

    /// A word or number changing in place.
    static var swap: Animation? { reduceMotion ? nil : .snappy(duration: 0.25) }

    /// A thread row turning up or going away. A fade with a slight grow
    /// from its top edge, so the rows around it make room smoothly; a row
    /// changing section also glides there (`sidebarRowSpace`).
    static var row: AnyTransition {
        reduceMotion ? .opacity : .opacity.combined(with: .scale(scale: 0.96, anchor: .top))
    }

    /// Something small appearing: a dot, a badge, a count.
    static var popIn: AnyTransition {
        reduceMotion ? .opacity : .scale(scale: 0.2).combined(with: .opacity)
    }
}

/// A sent message lifting off the composer: Return is the most-used action
/// in the app, so this stays well under 200 ms and delays nothing (the row's
/// there and the scroll's pinned before it starts). Mike picked it from a
/// mockup, 7 Nov. It fades the whole cell up from nothing, the bubble's own
/// 0.5 for "on its way" staying as it is, so it arrives at that.
@MainActor
enum SendLift {
    static let key = "sendLift"
    static let rise: CGFloat = 14
    static let duration: CFTimeInterval = 0.17
    static let firstFrame: CFTimeInterval = 0.02

    /// Only what's going to the runner now, and not one queued behind a turn
    /// or anything from history.
    static func rises(_ row: TranscriptRow) -> Bool {
        if case .user(let message) = row.content { return message.pending == .sending }
        return false
    }

    /// `begun`: when a lift already under way started, for the row taking
    /// over from the faded one (in `CACurrentMediaTime`'s time).
    static func lift(_ view: NSView, begun: CFTimeInterval? = nil) {
        view.wantsLayer = true
        guard let layer = view.layer else { return }
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 0
        fade.toValue = 1
        guard !Juice.reduceMotion else {
            // A quick fade on the faded row alone: nothing to carry on with.
            guard begun == nil else { return }
            fade.duration = 0.1
            layer.add(fade, forKey: key)
            return
        }
        // Additive, so it leaves the layer's own geometry to AppKit.
        let up = CABasicAnimation(keyPath: "transform.translation.y")
        up.isAdditive = true
        up.fromValue = view.downward(zoomed(rise))
        up.toValue = 0
        // A hair after the group starts, held at their start until then. The
        // curve's steepest at the start, and the cell's first frame reaches
        // the screen a frame or two after the commit: left to start at once,
        // most of the rise was over before anyone could see it (filmed, 7
        // Nov). On the parts, not the group, so the group still starts when
        // it's committed, however busy the main thread is by then.
        for part in [fade, up] {
            part.beginTime = firstFrame
            part.duration = duration
            part.fillMode = .backwards
            part.timingFunction = CAMediaTimingFunction(controlPoints: 0, 0, 0.2, 1)
        }
        let group = CAAnimationGroup()
        group.animations = [fade, up]
        group.duration = firstFrame + duration
        if let begun { group.beginTime = layer.convertTime(begun, from: nil) }
        layer.add(group, forKey: key)
    }
}

extension NSView {
    /// A distance below where this view is, in its layer's translation:
    /// which way that runs depends on whether its superview is flipped.
    func downward(_ distance: CGFloat) -> CGFloat {
        superview?.isFlipped == true ? distance : -distance
    }
}

extension EnvironmentValues {
    /// Goes up by one with each message sent from a composer, so its send
    /// arrow nudges.
    @Entry var sendNudges = 0
    /// Shared by a sidebar list's rows: the selected row's highlight is
    /// matched in it, so it slides from row to row, and a thread's rows
    /// are, so one that moves from Running to the Inbox glides up there
    /// rather than vanishing and turning up somewhere else.
    @Entry var sidebarRowSpace: Namespace.ID? = nil
}

extension View {
    /// `matchedGeometryEffect` in the list's space, when there is one.
    @ViewBuilder
    func matched(_ id: String, in space: Namespace.ID?) -> some View {
        if let space {
            matchedGeometryEffect(id: id, in: space)
        } else {
            self
        }
    }

    /// A row's highlight: the faint hover square fading in and out, and the
    /// selected row's grey, matched across the list so it slides.
    func rowHighlight(selected: Bool, hovering: Bool, selectedColor: Color, space: Namespace.ID?) -> some View {
        background {
            ZStack {
                if hovering && !selected {
                    RoundedRectangle(cornerRadius: SidebarMetrics.corner)
                        .fill(SidebarMetrics.hover)
                        .transition(.opacity)
                }
                if selected {
                    RoundedRectangle(cornerRadius: SidebarMetrics.corner)
                        .fill(selectedColor)
                        .matched("selection", in: space)
                }
            }
            .animation(Juice.hover, value: hovering)
        }
    }
}

/// The inbox with nothing in it: the bear, waving once as it rises into
/// place, over the usual note. A small reward for clearing everything. After
/// bedtime it's asleep and says so, rather than waving at you at midnight.
struct InboxZero: View {
    @Environment(AppModel.self) private var app
    @State private var shown = false
    @State private var waves = 0

    /// 10 pm until 5 am, on the Mac's own clock.
    nonisolated static func isBedtime(_ date: Date, calendar: Calendar = .current) -> Bool {
        let hour = calendar.component(.hour, from: date)
        return hour >= 22 || hour < 5
    }

    var body: some View {
        // Asks once a minute, so a bear left on screen does nod off at 10.
        TimelineView(.everyMinute) { context in
            let bedtime = Self.isBedtime(BearGeometry.date(context.date))
            VStack(alignment: .leading, spacing: zoomed(6)) {
                if bedtime { asleep } else { waving }
                Text(bedtime ? "Nothing in the inbox. Off to bed." : "Nothing in the inbox.")
                    .font(.system(size: TypeScale.sidebarPreview))
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.leading, SidebarMetrics.leading)
        .padding(.top, zoomed(14))
        .opacity(shown ? 1 : 0)
        .offset(y: shown || Juice.reduceMotion ? 0 : zoomed(8))
        .onAppear {
            withAnimation(Juice.reduceMotion ? .easeOut(duration: 0.2) : .snappy(duration: 0.4).delay(0.1)) { shown = true }
            // The thread pane's bear does the waving when he's just cleared
            // the inbox there (`PaneBear`): one wave on screen, not two.
            if !Juice.reduceMotion, app.inboxZeroBear == nil { waves += 1 }
        }
    }

    private var asleep: some View {
        SleepingBear()
            .frame(width: zoomed(30), height: zoomed(30))
            .accessibilityHidden(true)
    }

    private var waving: some View {
        // In December the hat's pom-pom is its own picture, to swing behind.
        let hat = BearGeometry.wearsHat(), side = zoomed(30)
        return ZStack {
            Image(nsImage: Bear.image(.wave, side: side, hat: hat, pom: false))
                .renderingMode(.template)
            if hat { swingingPom(side: side) }
        }
            .foregroundStyle(.secondary)
            .tiltWave(waves)
            .accessibilityHidden(true)
    }
}

extension View {
    /// A couple of quick tilts from its feet, like a wave, each time
    /// `trigger` changes, after `hold` seconds standing still.
    func tiltWave(_ trigger: Int, hold: Double = 0.25) -> some View {
        keyframeAnimator(initialValue: 0.0, trigger: trigger) { bear, angle in
            bear.rotationEffect(.degrees(angle), anchor: .bottom)
        } keyframes: { _ in
            KeyframeTrack {
                CubicKeyframe(0, duration: hold)
                CubicKeyframe(-9, duration: 0.14)
                CubicKeyframe(7, duration: 0.16)
                CubicKeyframe(-5, duration: 0.14)
                CubicKeyframe(0, duration: 0.2)
            }
        }
    }
}

/// Inbox zero in the thread pane: archiving the last thread there leaves
/// the pane on the new thread page, and once the archived page has landed
/// the bear rises above "What should we work on?" and waves once (Mike
/// picked it from a mockup, 7 Nov). No words: the heading stays as it is,
/// and the bear is the reward. It goes when he starts typing or opens a
/// thread. Not at bedtime, when the sidebar's bear is asleep.
struct PaneBear: View {
    @State private var shown = false
    @State private var waves = 0

    static var side: CGFloat { zoomed(44) }

    var body: some View {
        Image(nsImage: Bear.image(.wave, side: Self.side))
            .renderingMode(.template)
            .foregroundStyle(.secondary)
            // A beat after the archive box's bounce, which it follows.
            .tiltWave(waves, hold: 0.35)
            .opacity(shown ? 1 : 0)
            .offset(y: shown || Juice.reduceMotion ? 0 : zoomed(10))
            .onAppear {
                withAnimation(Juice.reduceMotion ? .easeOut(duration: 0.2) : .snappy(duration: 0.35).delay(0.1)) { shown = true }
                if !Juice.reduceMotion { waves += 1 }
            }
            .allowsHitTesting(false)
            .accessibilityHidden(true)
    }
}

extension InboxZero {
    /// A beat behind the tilts and the other way, with a settle at the end.
    private func swingingPom(side: CGFloat) -> some View {
        let tip = BearGeometry.waveFace(small: side < BearGeometry.smallSide, hat: true).hatTip ?? .zero
        return Image(nsImage: Bear.wavePom(side: side))
            .renderingMode(.template)
            .keyframeAnimator(initialValue: 0.0, trigger: waves) { pom, angle in
                pom.rotationEffect(.degrees(angle), anchor: UnitPoint(x: tip.x / 24, y: tip.y / 24))
            } keyframes: { _ in
                KeyframeTrack {
                    CubicKeyframe(0, duration: 0.35)
                    CubicKeyframe(31.5, duration: 0.14)
                    CubicKeyframe(-24.5, duration: 0.16)
                    CubicKeyframe(17.5, duration: 0.14)
                    CubicKeyframe(0, duration: 0.2)
                    CubicKeyframe(-10.5, duration: 0.13)
                    CubicKeyframe(0, duration: 0.13)
                }
            }
    }
}

private struct SleepingBear: NSViewRepresentable {
    func makeNSView(context: Context) -> SleepingBearView { SleepingBearView() }
    func updateNSView(_ view: SleepingBearView, context: Context) {}
}
