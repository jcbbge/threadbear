import AppKit
import SwiftUI
import ThreadbearCore

/// The activity bar's Connectors icon: Mike's Connectors gateway's
/// services (docs/protocol.md, "Connectors"). Only once the runner has
/// answered `connectors.status`. The accent dot while a service is signed
/// out, as only Mike can sign it back in; a grey one while the gateway
/// can't be reached or a service is having trouble, which usually sorts
/// itself out (as Updates' dots go).
struct ConnectorsActivityButton: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        let status = app.connectors
        ActivityButton(symbol: WindowDock.connectorsSymbol, title: "Connectors",
                       tip: ConnectorsText.tooltip(status),
                       dot: ConnectorsText.needsYou(status), quietDot: ConnectorsText.quiet(status),
                       active: app.connectorsShown) {
            app.connectorsShown.toggle()
        }
    }
}

/// Each gateway service with its state, and Connect for one that's signed
/// out, which opens its sign-in page in the browser. The header's arrow
/// opens the gateway's admin page and a signed-in row's opens that
/// service's page, where it can be signed out (30 Oct: Mike wanted to edit
/// connectors from here, and the gateway already has the pages for it). A panel in the dock,
/// beside Usage and Updates. It asks the runner for a fresh look when it
/// opens; the runner also looks every few minutes by itself.
struct ConnectorsPanel: View {
    @Environment(AppModel.self) private var app
    @State private var aboutShown = false

    var body: some View {
        let status = app.connectors
        ScrollView {
            VStack(alignment: .leading, spacing: zoomed(12)) {
                HStack(alignment: .firstTextBaseline, spacing: zoomed(6)) {
                    // Where they live ("bruce"), rather than a label.
                    Text(ConnectorsText.host(status) ?? "Gateway")
                        .font(.system(size: zoomed(11), weight: .medium))
                        .foregroundStyle(.tertiary)
                        .accessibilityAddTraits(.isHeader)
                    Spacer(minLength: 0)
                    if ConnectorsText.manageURL(status) != nil {
                        Button { app.openConnectorsAdmin() } label: {
                            Image(systemName: "arrow.up.forward.square").font(.system(size: zoomed(11)))
                        }
                        .buttonStyle(.borderless)
                        .foregroundStyle(.secondary)
                        .tip("Manage connectors on \(ConnectorsText.host(status) ?? "the gateway")")
                    }
                    Button { app.refreshConnectors(shown: true) } label: {
                        Image(systemName: "arrow.clockwise").font(.system(size: zoomed(11)))
                    }
                    .buttonStyle(.borderless)
                    .busy(app.isBusy(BusyKey.refreshConnectors))
                    .foregroundStyle(.secondary)
                    .tip("Check the gateway again now")
                    Button { aboutShown.toggle() } label: {
                        Image(systemName: "info.circle").font(.system(size: zoomed(11)))
                    }
                    .buttonStyle(.borderless)
                    .foregroundStyle(.secondary)
                    .tip("What this panel shows")
                    .popover(isPresented: $aboutShown, arrowEdge: .bottom) { ConnectorsAbout(status: status) }
                }
                if let line = ConnectorsText.emptyLine(status), status?.services.isEmpty ?? true {
                    Text(line)
                        .font(.system(size: zoomed(12)))
                        .foregroundStyle(status?.state == "unreachable" ? .primary : .secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                ForEach(status?.services ?? []) { service in
                    ConnectorRow(service: service)
                }
            }
            .padding(zoomed(16))
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .onAppear { app.refreshConnectors() }
    }
}

private struct ConnectorRow: View {
    @Environment(AppModel.self) private var app
    let service: ConnectorService
    @State private var hovered = false

    var body: some View {
        let signedOut = service.state == "signed_out"
        HStack(alignment: .firstTextBaseline, spacing: zoomed(8)) {
            // A small mark for the state: filled when signed in, the
            // accent only where Mike has something to do.
            Circle()
                .fill(markColor)
                .frame(width: zoomed(6), height: zoomed(6))
                .alignmentGuide(.firstTextBaseline) { $0[.bottom] - zoomed(1) }
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: zoomed(2)) {
                Text(service.title)
                    .font(.system(size: zoomed(12), weight: signedOut ? .medium : .regular))
                    .lineLimit(1)
                Text(ConnectorsText.stateLine(service))
                    .font(.system(size: zoomed(11)))
                    .foregroundStyle(.secondary)
                if let message = service.message, service.state != "connected" {
                    Text(message)
                        .font(.system(size: zoomed(11)))
                        .foregroundStyle(.tertiary)
                        .lineLimit(3)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: zoomed(6))
            if let title = ConnectorsText.buttonTitle(service) {
                Button(title) { app.openConnect(service) }
                    .controlSize(.small)
                    .tip("Open \(service.title)'s sign-in page in your browser")
            } else if ConnectorsText.serviceURL(app.connectors, service) != nil {
                // A signed-in service has nothing to press, but Mike may
                // want to sign it out or switch accounts: its page on the
                // gateway has Disconnect. Quiet until the row's hovered.
                Button { app.openConnect(service) } label: {
                    Image(systemName: "arrow.up.forward").font(.system(size: zoomed(11)))
                }
                .buttonStyle(.borderless)
                .foregroundStyle(.secondary)
                .opacity(hovered ? 1 : 0.35)
                .tip("Open \(service.title)'s page on \(ConnectorsText.host(app.connectors) ?? "the gateway") to sign out or reconnect")
            }
        }
        .contentShape(Rectangle())
        .onHover { hovered = $0 }
        .accessibilityElement(children: .contain)
    }

    private var markColor: Color {
        switch service.state {
        case "signed_out": return .accentColor
        case "connected": return Color.secondary.opacity(0.7)
        case "error": return .orange
        default: return Color.secondary.opacity(0.3)
        }
    }
}

/// The ⓘ: where the services come from, and the claude.ai ones this
/// panel doesn't cover.
private struct ConnectorsAbout: View {
    let status: ConnectorsStatus?

    var body: some View {
        VStack(alignment: .leading, spacing: zoomed(8)) {
            Text("These are the services your agents get from the Connectors gateway\(host.map { " on \($0)" } ?? ""). Connect opens a service's sign-in page in your browser. The arrows open the gateway's own pages, to sign a service out or reconnect it.")
            Text("The runner checks every few minutes and when this panel opens. When an agent runs into a service that needs signing in, it asks you with a link to the page.")
            Text("claude.ai's own connectors are signed in on claude.ai, for each login.")
            if let checked = status?.checkedAt {
                Text("Last checked \(checked.formatted(date: .omitted, time: .shortened)).")
                    .foregroundStyle(.secondary)
            }
        }
        .font(.system(size: zoomed(12)))
        .fixedSize(horizontal: false, vertical: true)
        .frame(width: zoomed(280), alignment: .leading)
        .padding(zoomed(14))
    }

    private var host: String? { ConnectorsText.host(status) }
}
