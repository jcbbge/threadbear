import AppKit
import SwiftUI
import ThreadbearCore

/// The row under the composer's text: "+" (images and the folder), the
/// account, model and permission chips, and send (or Stop) on the right.
/// There's no folder chip: Mike asked twice for it gone (3 Nov), so the
/// folder is only changed from "+" > Folder, or the machine chip's menu
/// for a thread on another Mac.
struct ComposerControls: View {
    @Environment(AppModel.self) private var app
    @AppStorage(VoiceMode.enabledKey) private var voiceEnabled = true
    let thread: ThreadSummary?
    let running: Bool
    let canSend: Bool
    /// A new thread is being made from what's in the box.
    var sending = false
    let onAttach: () -> Void
    let onSend: () -> Void
    /// Opens the schedule editor with the draft, instead of sending it now.
    let onSchedule: () -> Void

    var body: some View {
        if let thread, let place = app.runnerPlace(of: thread) {
            // Its pickers fill from that Mac's logins once its connection
            // has said hello; until then just its name.
            if app.logins(for: thread) != nil {
                controls(remote: (thread, place))
            } else {
                remoteControls(thread, place: place)
            }
        } else if thread == nil, app.newThreadRunnerId != nil, app.newThreadLogins == nil {
            // A new thread for another runner, before its hello has said
            // what logins it has: the machine chip, and how it's going.
            draftWaitingControls
        } else {
            controls(remote: nil)
        }
    }

    /// The machine chip on the new-thread composer, when there's another
    /// runner to choose: which Mac the thread will run on.
    @ViewBuilder
    private var runsOnChip: some View {
        if thread == nil, !app.remoteRunners.isEmpty {
            let settings = ThreadSettings(app: app, thread: nil)
            let runner = app.newThreadRunner
            ComposerChip(icon: runner.map { RunnerIcon.symbol($0.icon) } ?? app.selfRunnerIcon, title: "",
                         help: "Runs on " + (runner.map { $0.online ? $0.name : "\($0.name), offline" } ?? "this Mac")) {
                settings.runnerMenu()
            }
            ChipDivider()
        }
    }

    private var draftWaitingControls: some View {
        HStack(spacing: zoomed(4)) {
            runsOnChip
                .padding(.leading, -zoomed(7))
            if let problem = app.newThreadRunnerProblem {
                Text("Can't reach \(app.newThreadRunner?.name ?? "it")")
                    .font(.system(size: TypeScale.chip))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .tip(problem)
            } else {
                ProgressView()
                    .controlSize(.mini)
                    .tip("Connecting to \(app.newThreadRunner?.name ?? "it")")
            }
            Spacer(minLength: zoomed(8))
            SendButton(running: false, canSend: canSend, sending: sending, onSend: onSend, onStop: {})
                .layoutPriority(1)
        }
        .frame(height: SendButton.size)
    }

    /// Another runner's thread: its Mac's icon and name, at the front of
    /// the row in place of "+" (a picture from here would be a path that
    /// Mac hasn't got) and the folder (it's that Mac's).
    private func runnerChip(_ thread: ThreadSummary, place: String) -> some View {
        HStack(spacing: zoomed(4)) {
            Image(systemName: app.runnerIcon(of: thread))
                .font(.system(size: TypeScale.chip - 1))
                .foregroundStyle(Color(nsColor: Theme.faintIcon))
            Text(app.runnerName(of: thread) ?? "")
                .font(.system(size: TypeScale.chip))
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .padding(.horizontal, zoomed(7))
        .frame(height: zoomed(26))
        .tip("\(place), in \(thread.cwd.abbreviatingHome)")
    }

    /// Another runner's thread before its connection has said hello: its
    /// Mac's name where the chips would be, and send.
    private func remoteControls(_ thread: ThreadSummary, place: String) -> some View {
        HStack(spacing: zoomed(4)) {
            HStack(spacing: zoomed(4)) {
                Image(systemName: app.runnerIcon(of: thread))
                    .font(.system(size: TypeScale.chip - 1))
                    .foregroundStyle(Color(nsColor: Theme.faintIcon))
                Text(app.runnerName(of: thread) ?? "")
                    .font(.system(size: TypeScale.chip))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            .padding(.horizontal, zoomed(7))
            .frame(height: zoomed(26))
            .tip("\(place), in \(thread.cwd.abbreviatingHome)")
            Spacer(minLength: zoomed(8))
            SendButton(running: running, canSend: canSend, sending: sending, stopping: app.isBusy(BusyKey.stop(thread.id)), onSend: onSend, onStop: { app.interrupt(thread.id) })
                .layoutPriority(1)
        }
        .frame(height: SendButton.size)
    }

    @ViewBuilder
    private func controls(remote: (thread: ThreadSummary, place: String)?) -> some View {
        let settings = ThreadSettings(app: app, thread: thread)
        let account = settings.account
        // A new thread for another runner: no pictures or schedules from
        // here (paths on this Mac). Its folder is in the machine chip's menu.
        let draftAway = thread == nil && app.newThreadRunnerId != nil
        // A login or pool pick can't be guessed (ThreadUpdate.applied), so
        // the chips that show it spin until the runner has made it.
        let moving = thread.map { app.isBusy(BusyKey.moving($0.id)) } ?? false
        HStack(spacing: zoomed(4)) {
            if let remote {
                runnerChip(remote.thread, place: remote.place)
                    .padding(.leading, -zoomed(7))
                ChipDivider()
            } else if draftAway {
                runsOnChip
                    .padding(.leading, -zoomed(7))
            } else {
                PlusButton(busy: thread.map { app.isBusy(BusyKey.movingFolder($0.id)) } ?? false) { settings.plusMenu(attach: onAttach, schedule: app.schedulesSupported ? onSchedule : nil) }
                    // Pulls the glyph back so it lines up with the text above.
                    .padding(.leading, -zoomed(7))
                runsOnChip
            }
            // With pools the runner picks the login, so there's no account
            // chip: the model chip names the pool (or the pinned login).
            if !settings.usesPools {
                ComposerChip(icon: "person.crop.circle", title: AccountName.short(account, accounts: settings.logins.accounts), help: settings.accountChipHelp,
                             badge: settings.accountBadge, busy: moving, popover: {
                    NSHostingController(rootView: AccountPickerView(threadId: thread?.id, close: $0).environment(app))
                }, openRequest: app.accountPickerRequest)
                ChipDivider()
            }
            ComposerChip(icon: settings.modelChipIcon, logo: settings.modelChipLogo, title: settings.modelChipTitle, help: settings.modelChipHelp, badge: settings.modelChipBadge, busy: moving, popover: {
                // The picker reads the thread live, so a pick made while
                // it's open shows straight away.
                NSHostingController(rootView: ModelPickerView(threadId: thread?.id, close: $0).environment(app))
            }, openRequest: app.modelPickerRequest)
            ChipDivider()
            ComposerChip(
                icon: settings.permissionMode.composerIcon,
                title: settings.permissionMode.composerTitle,
                help: settings.permissionMode.composerHelp
            ) {
                settings.permissionMenu()
            }
            Spacer(minLength: zoomed(8))
            // How full the context is, beside send: where you decide to
            // carry on, /compact or start afresh.
            if let thread, let meter = ContextMeter(thread) {
                ContextRing(meter: meter, openRequest: app.contextMeterRequest) {
                    NSHostingController(rootView: ContextPopover(threadId: thread.id).environment(app))
                }
            }
            // Voice for the thread, or on a new thread's composer, where
            // what's said first starts it (Settings > Voice can hide it).
            if voiceEnabled, VoiceMode.available, !draftAway {
                VoiceButton(threadId: thread?.id ?? VoiceMode.newThread, size: SendButton.size)
                    .layoutPriority(1)
            }
            SendButton(running: running, canSend: canSend, sending: sending, stopping: thread.map { app.isBusy(BusyKey.stop($0.id)) } ?? false, onSend: onSend, onStop: { app.interrupt(thread?.id) })
                .layoutPriority(1)
                // Right-click send for later, as Mail and Slack do. Not on
                // another Mac's thread: its schedules are made from there.
                .iconContextMenu {
                    if app.schedulesSupported, remote == nil, !draftAway { Button("Schedule…", systemImage: "clock", action: onSchedule) }
                }
        }
        .frame(height: SendButton.size)
    }
}

/// The folder, account, model and permission for the open thread, or the
/// settings the next new thread starts with, and the menus that change them.
/// Menus are built when a chip is clicked, so the composer doesn't redraw
/// whenever any thread in the list changes.
@MainActor
struct ThreadSettings {
    let app: AppModel
    let thread: ThreadSummary?
    /// The logins its pickers offer: the thread's runner's (another Mac's
    /// for one of its threads), this Mac's otherwise.
    let logins: RunnerLogins

    init(app: AppModel, thread: ThreadSummary?) {
        self.app = app
        self.thread = thread
        logins = app.logins(for: thread) ?? RunnerLogins(accounts: app.accounts, pools: app.pools, defaults: app.defaults)
    }

    var cwd: String { thread?.cwd ?? app.newThreadCwd ?? logins.defaults.cwd }
    /// A new thread's is the one with the most room until Mike picks one.
    var account: String { thread?.accountId ?? app.newThreadAccountId }
    /// "claude" or "codex": the account's, which a thread's own follows.
    var provider: String { thread?.provider ?? (logins.account(account)?.provider ?? "claude") }
    var model: String? { thread == nil ? app.lastModels[provider] : thread?.model }
    var effort: String? { thread == nil ? app.lastEfforts[provider] : thread?.effort }
    var permissionMode: PermissionMode { thread?.permissionMode ?? app.newThreadPermission }
    /// A new thread for another runner: its folders are paths on that Mac.
    var draftRunnerId: String? { thread == nil ? app.newThreadRunnerId : nil }
    /// Another runner's thread, or a new one for another runner.
    var isAway: Bool { thread.map(\.isRemote) ?? (app.newThreadRunnerId != nil) }

    /// What the account's CLI offers, once the runner has asked it.
    var choices: [ModelChoice] { logins.account(account)?.models ?? [] }

    /// The model a thread with none of its own runs on: the runner's
    /// default for a new thread, else the account's. For an open thread the
    /// last turn is the truth, and it already includes the runner's default.
    var defaultModel: String? {
        if let thread { return ComposerChips.resolvedModel(thread.modelInUse, logins.account(thread.accountId)?.defaultModel) }
        return ComposerChips.resolvedModel(logins.defaults.model(for: provider), logins.account(account)?.defaultModel)
    }

    /// The model the chip shows, resolved; nil only before the runner has
    /// said anything.
    var effectiveModel: String? { ComposerChips.resolvedModel(model, defaultModel) }

    /// The level the chip shows: the one chosen, else what the CLI said it
    /// ran the last turn at, else the level that will apply (the runner's
    /// default for a new thread, the account's, the model's).
    var effectiveEffort: String? {
        effort ?? thread?.effortInUse ?? ModelPicker.impliedEffort(
            model: effectiveModel, choices: choices, account: logins.account(account),
            runnerDefault: thread == nil ? logins.defaults.efforts[provider] : nil)
    }

    /// The account chip's "· 12%" or "Limit reached".
    var accountBadge: AccountUsageText.ChipBadge? { AccountUsageText.chipBadge(logins.account(account)?.usage) }

    /// The full sentence: the address, its note, and the room left.
    var accountChipHelp: String {
        AccountUsageText.tooltip(logins.account(account), fallback: (logins.account(account).map(AccountName.title) ?? account), now: app.now)
    }

    /// The account picker's sections and its last line.
    var accountSections: [AccountMenu.Section] { AccountMenu.sections(logins.accounts, selected: account, now: app.now) }
    var accountFooter: String? { AccountUsageText.sourceLine(logins.accounts, now: app.now) }
    func accountLines() -> [String] { AccountMenu.lines(accountSections, footer: accountFooter) }

    /// The pool's own icon in front of the chip, so which pool a thread is
    /// on shows at a glance; a pinned login's person, or (no pools) the
    /// sparkle the chip always had.
    /// The provider whose logo leads the model chip instead of
    /// `modelChipIcon`: the thread's own, unless its pool has an icon Mike
    /// picked for it (a pinned thread keeps the person).
    var modelChipLogo: String? {
        guard usesPools else { return provider }
        guard let pool else { return nil }
        return (pool.icon ?? "").isEmpty ? provider : nil
    }

    var modelChipIcon: String {
        guard usesPools else { return "sparkle" }
        guard let pool else { return "person.crop.circle" }
        let symbol = Pools.symbol(pool, accounts: logins.accounts)
        return ProjectIconImages.symbolExists(symbol) ? symbol : "square.stack"
    }

    var modelChipTitle: String { Pools.chipTitle(owner: owner, model: effectiveModel, effort: effectiveEffort, choices: choices) }

    /// With pools, the pool's badge when every login in it is running out,
    /// or a pinned login's own.
    var modelChipBadge: AccountUsageText.ChipBadge? {
        guard usesPools else { return nil }
        if let pool { return Pools.chipBadge(pool, accounts: logins.accounts) }
        return accountBadge
    }

    var modelChipHelp: String {
        var parts: [String] = []
        if let pool { parts.append("\(pool.title) pool") }
        else if usesPools { parts.append("Pinned to \((logins.account(account).map(AccountName.title) ?? account))") }
        if let model { parts.append(model) } else if let defaultModel { parts.append("\(defaultModel), the default") } else { parts.append("The account's default model") }
        if let effort { parts.append("\(ComposerChips.effortTitle(effort).lowercased()) effort") }
        else if let level = thread?.effortInUse { parts.append("\(level) effort, the model's own level") }
        else if let level = effectiveEffort { parts.append("\(ComposerChips.effortTitle(level).lowercased()) effort, the default") }
        else { parts.append("the model's own effort level") }
        return parts.joined(separator: ", ")
    }

    /// "+": images, the folder (it has no chip of its own), and sending
    /// the message later.
    func plusMenu(attach: @escaping () -> Void, schedule: (() -> Void)? = nil) -> NSMenu {
        let menu = NSMenu()
        let images = ActionMenuItem("Attach images…", symbol: "photo", handler: attach)
        menu.addItem(images)
        let folder = NSMenuItem(title: "Folder", symbol: "folder", action: nil)
        folder.submenu = folderMenu()
        menu.addItem(folder)
        if let schedule {
            menu.addItem(.separator())
            let later = ActionMenuItem("Schedule…", symbol: "clock", handler: schedule)
            menu.addItem(later)
        }
        return menu
    }

    func folderMenu() -> NSMenu {
        if let runnerId = draftRunnerId { return remoteFolderMenu(runnerId) }
        let menu = NSMenu()
        let current = cwd
        for folder in recentFolders(including: current) {
            let item = ActionMenuItem(folder.abbreviatingHome, symbol: "folder", checked: folder == current) { setCwd(folder) }
            if ComposerChips.sameFolder(folder, logins.defaults.cwd) { item.subtitle = "Default" }
            menu.addItem(item)
        }
        menu.addItem(.separator())
        menu.addItem(ActionMenuItem("Choose…", symbol: "folder.badge.plus") { chooseFolder() })
        return menu
    }

    /// The folder for a new thread on another runner: its default, the
    /// folders of its threads here, and Other… to type a path on that Mac.
    /// Nothing is checked on this Mac (the paths aren't here); that runner
    /// says if one isn't there when the thread starts.
    private func remoteFolderMenu(_ runnerId: String) -> NSMenu {
        let menu = NSMenu()
        let current = cwd
        var folders = app.remoteFolders(runnerId)
        if !current.isEmpty, !folders.contains(current) { folders.insert(current, at: 0) }
        for folder in folders.prefix(8) {
            let item = ActionMenuItem(folder, symbol: "folder", checked: folder == current) { setCwd(folder) }
            if folder == logins.defaults.cwd { item.subtitle = "Default" }
            menu.addItem(item)
        }
        if !folders.isEmpty { menu.addItem(.separator()) }
        let other = ActionMenuItem("Other…", symbol: "character.cursor.ibeam") { typeRemoteFolder() }
        menu.addItem(other)
        return menu
    }

    /// Asks for a path on the other Mac, as there's no folder picker for it.
    private func typeRemoteFolder() {
        let name = app.newThreadRunner?.name ?? "that Mac"
        let alert = NSAlert()
        alert.messageText = "A folder on \(name)"
        alert.informativeText = "Its full path, like /Users/\(name)/dev."
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24))
        field.stringValue = cwd
        field.placeholderString = "/Users/\(name)/dev"
        alert.accessoryView = field
        alert.addButton(withTitle: "Use")
        alert.addButton(withTitle: "Cancel")
        alert.window.initialFirstResponder = field
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        let folder = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        if !folder.isEmpty { setCwd(folder) }
    }

    /// "Runs on" for a new thread: this Mac, then each other runner, with
    /// the offline ones saying so (still a choice: it may be waking up).
    func runnerMenu() -> NSMenu {
        let menu = NSMenu()
        let chosen = app.newThreadRunnerId
        let byDefault = app.defaultRunnerId
        let here = ActionMenuItem("This Mac", symbol: app.selfRunnerIcon, checked: chosen == nil) { app.chooseNewThreadRunner(nil) }
        if byDefault == nil { here.markDefault() }
        menu.addItem(here)
        menu.addItem(.separator())
        for runner in app.remoteRunners {
            let item = ActionMenuItem(runner.name, symbol: RunnerIcon.symbol(runner.icon), checked: chosen == runner.id) { app.chooseNewThreadRunner(runner.id) }
            if !runner.online { item.subtitle = "Offline" }
            if byDefault == runner.id { item.markDefault() }
            menu.addItem(item)
        }
        // Where new threads start, set right here as the link menus' Default
        // is; the star above says which it is. Settings > Runners has it too.
        menu.addItem(.separator())
        let defaults = NSMenu()
        defaults.addItem(ActionMenuItem("This Mac", symbol: app.selfRunnerIcon, checked: byDefault == nil) { app.setDefaultRunner(nil) })
        for runner in app.remoteRunners {
            defaults.addItem(ActionMenuItem(runner.name, symbol: RunnerIcon.symbol(runner.icon), checked: byDefault == runner.id) { app.setDefaultRunner(runner.id) })
        }
        let defaultItem = NSMenuItem(title: "Default", symbol: "star", action: nil)
        defaultItem.submenu = defaults
        menu.addItem(defaultItem)
        // On another runner there's no "+": its folders are here.
        if draftRunnerId != nil, app.newThreadLogins != nil {
            menu.addItem(.separator())
            let folder = NSMenuItem(title: "Folder", symbol: "folder", action: nil)
            folder.submenu = folderMenu()
            menu.addItem(folder)
        }
        return menu
    }

    /// The providers in the picker's rail, and which column opens: the
    /// account's own provider.
    var providers: [ModelPicker.Provider] { ModelPicker.providers(logins.accounts) }
    var providerId: String { logins.account(account)?.provider ?? "claude" }

    /// The account whose models a provider's column lists: the thread's
    /// own when it's on that provider, else the provider's first.
    func listedAccount(for providerId: String) -> String? {
        if self.providerId == providerId { return account }
        // This Mac's last login for it only if this runner has it.
        if let last = app.accountForProvider(providerId), logins.account(last) != nil { return last }
        return providers.first { $0.id == providerId }?.accountIds.first
    }

    /// The rows of a provider's column. The default and the selection are
    /// only known for the thread's own account; another provider's column
    /// is a plain list until a model there is picked.
    func rows(for providerId: String, query: String = "") -> [ModelPicker.Row] {
        guard let listed = listedAccount(for: providerId) else {
            return ModelPicker.rows(choices: [], defaultId: nil, selected: nil, query: query)
        }
        let own = listed == account
        let choices = logins.account(listed)?.models ?? []
        let defaultId = own ? defaultModel : (logins.defaults.model(for: providerId) ?? logins.account(listed)?.defaultModel)
        return ModelPicker.rows(choices: choices, defaultId: defaultId, selected: own ? effectiveModel : nil, query: query, provider: providerId)
    }

    /// The levels the effort row offers for the model in use.
    var effortLevels: [String] { ModelPicker.effortLevels(for: effectiveModel, in: choices, provider: provider) }

    // MARK: Pools

    /// The runner has pools: the rail lists them, and the login is the
    /// runner's to pick unless the thread is pinned.
    var usesPools: Bool { !logins.pools.isEmpty && (app.poolsSupported || isAway) }

    /// The thread's pool, or the one a new thread starts on. Nil when it's
    /// pinned to a login (or there are no pools). A thread whose pool has
    /// since been deleted reads as pinned to the login it's on.
    var pool: Pool? {
        guard usesPools else { return nil }
        let id = thread.map { $0.poolId } ?? app.newThreadPoolId
        return id.flatMap(logins.pool)
    }

    /// On one login of Mike's choosing, which the runner never moves.
    var isPinned: Bool { usesPools && pool == nil }

    /// Who runs it, at the front of the model chip: the pool's title, or a
    /// pinned login's name. Nil without pools (the account chip says it).
    var owner: String? {
        guard usesPools else { return nil }
        return pool?.title ?? AccountName.login(account, accounts: logins.accounts)
    }

    /// The rail's column for a pinned thread: its own login's models, with
    /// no pool highlighted.
    static let pinnedColumn = "@pinned"

    /// The rail: pools with their count and best room, or (no pools) one
    /// icon per provider.
    var columns: [ModelPicker.Column] {
        guard usesPools else {
            return providers.map { ModelPicker.Column(id: $0.id, title: $0.title, symbol: ModelPicker.providerSymbol($0.id)) }
        }
        return logins.pools.map { ModelPicker.Column(id: $0.id, title: $0.title, subtitle: Pools.railSubtitle($0, accounts: logins.accounts), logins: Pools.logins($0, accounts: logins.accounts).count,
                                                    providers: Pools.providers($0, accounts: logins.accounts)) }
    }

    /// The column the picker opens on.
    var columnId: String {
        guard usesPools else { return providerId }
        return pool?.id ?? Self.pinnedColumn
    }

    /// A column's models. A pool lists each of its providers' models, under
    /// the provider's name when there's more than one. The default and the
    /// tick are only for the thread's own pool and provider; elsewhere it's
    /// a plain list until a model there is picked.
    func sections(for columnId: String, query: String = "") -> [ModelPicker.Section] {
        guard usesPools else { return [ModelPicker.Section(id: columnId, rows: rows(for: columnId, query: query))] }
        guard let shown = logins.pool(columnId) else {
            return [ModelPicker.Section(id: provider, rows: ModelPicker.rows(choices: choices, defaultId: defaultModel, selected: effectiveModel, query: query, provider: provider))]
        }
        let providers = Pools.providers(shown, accounts: logins.accounts)
        return providers.compactMap { providerId -> ModelPicker.Section? in
            let own = shown.id == pool?.id && providerId == provider
            let listed = own ? account : Pools.pickLogin(shown, accounts: logins.accounts, provider: providerId, current: app.lastAccountId(provider: providerId))
            let listedAccount = listed.flatMap(logins.account)
            let defaultId = own ? defaultModel : (logins.defaults.model(for: providerId) ?? listedAccount?.defaultModel)
            let rows = ModelPicker.rows(choices: listedAccount?.models ?? [], defaultId: defaultId, selected: own ? effectiveModel : nil,
                                        query: query, provider: providerId)
            if rows.isEmpty, !query.isEmpty { return nil }
            return ModelPicker.Section(id: providerId, title: providers.count > 1 ? ModelPicker.providerTitle(providerId) : nil, rows: rows)
        }
    }

    /// Picks a model from a column. Without pools, as `pick(_:in:)`. In the
    /// pinned column, or the thread's own pool and provider, it's just the
    /// model; anywhere else it moves the thread (or the draft) to that pool
    /// and provider.
    func pick(_ row: ModelPicker.Row, section: String, column: String) {
        guard usesPools else { return pick(row, in: column) }
        let model = row.isDefault ? nil : row.id
        if column == Self.pinnedColumn || (column == pool?.id && section == provider) { return setModel(model) }
        app.choosePool(column, provider: section, model: model, threadId: thread?.id)
    }

    /// "Pinned to gmail", for a pinned thread.
    var pinnedLine: String? { isPinned ? "Pinned to " + AccountName.login(account, accounts: logins.accounts) : nil }

    /// Every login with its room, the pinned one ticked, for the
    /// automation's pin menu. It reads the thread live, so the tick can't go stale.
    var pinSections: [AccountMenu.Section] { AccountMenu.sections(logins.accounts, selected: isPinned ? account : "", now: app.now) }

    func pin(_ accountId: String) {
        if let thread {
            app.pinThread(thread.id, to: accountId)
        } else {
            app.newThreadPool = nil
            app.newThreadProvider = nil
            app.newThreadAccount = accountId
        }
    }

    func unpin() {
        if let thread { app.unpinThread(thread.id) } else { app.newThreadAccount = nil }
    }

    /// Picks a row: the default row leaves the thread on the default (so
    /// it follows the account's setting), any other pins that model. A row
    /// from another provider's column moves the thread to that provider's
    /// account first.
    func pick(_ row: ModelPicker.Row, in providerId: String) {
        let model = row.isDefault ? nil : row.id
        guard let listed = listedAccount(for: providerId), listed != account else { return setModel(model) }
        if let thread {
            app.moveThread(thread.id, toAccount: listed, model: model)
        } else {
            app.newThreadAccount = listed
            app.remember(model: model, provider: providerId)
        }
    }

    /// The picker as text, for the automation's `composer-menu`: a `#`
    /// line per provider column, `[x]` on the chosen row, `*` on the
    /// default, the description after a dash, older rows indented, then
    /// the effort levels.
    func pickerLines() -> [String] {
        if usesPools { return poolPickerLines() }
        var lines: [String] = []
        for provider in providers {
            lines.append("# " + provider.title)
            for row in rows(for: provider.id) {
                var line = (row.isOlder ? "    " : "") + (row.isSelected ? "[x] " : "[ ] ") + row.title
                if row.isDefault { line += " *" }
                if let subtitle = row.subtitle, !subtitle.isEmpty { line += " - " + subtitle }
                lines.append(line)
            }
        }
        lines.append("# Effort")
        let chosen = effectiveEffort
        for level in effortLevels {
            var line = (chosen == level ? "[x] " : "[ ] ") + ComposerChips.effortTitle(level)
            if let porridge = ComposerChips.effortPorridge(level) { line += " - " + porridge }
            lines.append(line)
        }
        return lines
    }

    /// The pools picker as text: `# [x] Claude · 3 · 61%` per pool (ticked
    /// on the thread's own), `## Codex` over each provider in a mixed pool,
    /// the rows as above, then the effort levels and the pinned line, as
    /// the picker shows them.
    private func poolPickerLines() -> [String] {
        var lines: [String] = []
        func add(_ sections: [ModelPicker.Section]) {
            for section in sections {
                if let title = section.title { lines.append("## " + title) }
                for row in section.rows {
                    var line = (row.isOlder ? "    " : "") + (row.isSelected ? "[x] " : "[ ] ") + row.title
                    if row.isDefault { line += " *" }
                    if let subtitle = row.subtitle, !subtitle.isEmpty { line += " - " + subtitle }
                    lines.append(line)
                }
            }
        }
        if isPinned {
            lines.append("# " + (pinnedLine ?? "Pinned"))
            add(sections(for: Self.pinnedColumn))
        }
        for column in columns {
            lines.append("# " + (column.id == pool?.id ? "[x] " : "[ ] ") + column.title + (column.subtitle.map { " · " + $0 } ?? ""))
            add(sections(for: column.id))
        }
        lines.append("# Effort")
        let chosen = effectiveEffort
        for level in effortLevels {
            var line = (chosen == level ? "[x] " : "[ ] ") + ComposerChips.effortTitle(level)
            if let porridge = ComposerChips.effortPorridge(level) { line += " - " + porridge }
            lines.append(line)
        }
        if let pinnedLine { lines.append("--- " + pinnedLine + " · Unpin") }
        return lines
    }

    /// Picks a model or effort row by its title, as a click on it would.
    /// With pools, `column` names the pool to look in (the thread's own,
    /// then the rest, by default); "Unpin" unpins.
    func pickerClick(_ title: String, column: String? = nil) -> Bool {
        if usesPools {
            if title == "Unpin" {
                guard isPinned else { return false }
                unpin()
                return true
            }
            let order = column.map { [$0] } ?? ([columnId] + columns.map(\.id).filter { $0 != columnId })
            for id in order {
                for section in sections(for: id) {
                    if let row = section.rows.first(where: { $0.title == title }) {
                        pick(row, section: section.id, column: id)
                        return true
                    }
                }
            }
            if let level = effortLevels.first(where: { ComposerChips.effortTitle($0) == title }) {
                setEffort(level)
                return true
            }
            return false
        }
        for provider in providers {
            if let row = rows(for: provider.id).first(where: { $0.title == title }) {
                pick(row, in: provider.id)
                return true
            }
        }
        if let level = effortLevels.first(where: { ComposerChips.effortTitle($0) == title }) {
            setEffort(level)
            return true
        }
        return false
    }

    func permissionMenu() -> NSMenu {
        let menu = NSMenu()
        // Auto is Claude Code's; Codex has nothing like it, so it's only offered
        // for Claude (or if a thread is somehow on it already).
        let modes: [PermissionMode] = provider == "claude" || permissionMode == .auto ? [.full, .auto, .ask, .plan] : [.full, .ask, .plan]
        for mode in modes {
            let item = ActionMenuItem(mode.composerTitle, symbol: mode.composerIcon, checked: permissionMode == mode) { setPermission(mode) }
            item.subtitle = mode.composerHelp
            menu.addItem(item)
        }
        return menu
    }

    private func recentFolders(including cwd: String) -> [String] {
        var seen = Set<String>()
        var folders: [String] = []
        for folder in [cwd, logins.defaults.cwd] + app.threads.values.filter({ !$0.isRemote }).sorted(by: { $0.lastActivityAt > $1.lastActivityAt }).map(\.cwd) {
            guard !folder.isEmpty, seen.insert(folder).inserted else { continue }
            folders.append(folder)
            if folders.count >= 8 { break }
        }
        return folders
    }

    private func chooseFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.directoryURL = URL(fileURLWithPath: cwd)
        if panel.runModal() == .OK, let url = panel.url { setCwd(url.path) }
    }

    private func setCwd(_ folder: String) {
        if let thread { app.setCwd(thread.id, folder) } else { app.newThreadCwd = folder }
    }

    func setAccount(_ id: String) {
        if let thread { app.setAccount(thread.id, id) } else { app.newThreadAccount = id }
    }

    func setModel(_ model: String?) {
        if let thread { app.setModel(thread.id, model) } else { app.remember(model: model, provider: provider) }
    }

    func setEffort(_ effort: String?) {
        if let thread { app.setEffort(thread.id, effort) } else { app.remember(effort: effort, provider: provider) }
    }

    private func setPermission(_ mode: PermissionMode) {
        if let thread { app.setPermission(thread.id, mode) } else { app.newThreadPermission = mode }
    }
}

private extension PermissionMode {
    var composerTitle: String {
        switch self {
        case .full: "Full access"
        case .ask: "Ask before edits"
        case .auto: "Auto"
        case .plan: "Plan first"
        }
    }

    var composerIcon: String {
        switch self {
        case .full: "lock.open"
        case .ask: "lock"
        case .auto: "lock.shield"
        case .plan: "list.bullet.clipboard"
        }
    }

    var composerHelp: String {
        switch self {
        case .full: "Edits files and runs commands without asking"
        case .ask: "Asks before editing files or running commands"
        case .auto: "A safety check approves or blocks each action, and asks only when unsure"
        case .plan: "Reads and plans, and changes nothing until you approve its plan"
        }
    }
}

/// A quiet menu chip: icon, short label and a small chevron in secondary
/// colours, a faint fill on hover, and an AppKit menu that opens above it.
/// SwiftUI's `Menu` on macOS ignores label colours and sizes, which is why
/// the old chips came out as bright as the message text.
private struct ComposerChip: View {
    let icon: String
    /// A provider whose logo (ProviderLogo) stands in for `icon`.
    var logo: String? = nil
    let title: String
    let help: String
    /// After the title: "· 12%" in orange, "Limit reached" in red. Colour
    /// only here, where it means the account is running out.
    var badge: AccountUsageText.ChipBadge? = nil
    /// A pick from this chip is on its way: a spinner for the icon, and it
    /// won't open again until that's landed.
    var busy = false
    var menu: (() -> NSMenu)? = nil
    /// Instead of a menu: a popover above the chip, given a way to close
    /// itself.
    var popover: ((@escaping () -> Void) -> NSViewController)? = nil
    @State private var hovering = false
    @State private var anchor = MenuAnchor()

    /// Opening from outside (the automation), when set.
    var openRequest: Int = 0

    var body: some View {
        Button {
            open()
        } label: {
            HStack(spacing: zoomed(4)) {
                Group {
                    if busy {
                        SpinnerMark(color: .secondaryLabelColor)
                            .frame(width: TypeScale.chip, height: TypeScale.chip)
                    } else if let logo {
                        ProviderMark(provider: logo, symbol: icon, side: TypeScale.chip - 1)
                    } else {
                        Image(systemName: icon)
                            .font(.system(size: TypeScale.chip - 1))
                    }
                }
                .foregroundStyle(Color(nsColor: Theme.faintIcon))
                // No title: an icon-only chip (Runs on).
                if !title.isEmpty {
                    Text(title)
                        .font(.system(size: TypeScale.chip))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                switch badge {
                case .low(let percent)?:
                    Text("· " + percent)
                        .font(.system(size: TypeScale.chip))
                        .foregroundStyle(.orange)
                        .lineLimit(1)
                case .blocked?:
                    Text("Limit reached")
                        .font(.system(size: TypeScale.chip))
                        .foregroundStyle(.red)
                        .lineLimit(1)
                case nil:
                    EmptyView()
                }
                // An icon-only chip is just its icon: room is short on
                // the new-thread composer with the machine chip there too.
                if !title.isEmpty {
                    Image(systemName: "chevron.down")
                        .font(.system(size: zoomed(7.5), weight: .bold))
                        .foregroundStyle(Color(nsColor: Theme.faintIcon))
                }
            }
            .padding(.horizontal, zoomed(7))
            .frame(height: zoomed(26))
            .background(
                RoundedRectangle(cornerRadius: zoomed(7), style: .continuous)
                    .fill(Color.primary.opacity(hovering ? 0.07 : 0))
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .background(MenuAnchorView(anchor: anchor))
        .onHover { hovering = $0 }
        .onChange(of: openRequest) { _, _ in open() }
        .disabled(busy)
        .tip(busy ? "Moving this thread" : help)
    }

    private func open() {
        guard !busy else { return }
        if let menu { anchor.popUp(menu()) }
        else if let popover { anchor.show(popover) }
    }
}

/// A small ring for how full the thread's context is: grey, orange once
/// it's nearly full (the one place it has colour, as that's when it
/// matters). Clicking it opens ContextPopover.
private struct ContextRing: View {
    let meter: ContextMeter
    var openRequest: Int = 0
    let popover: () -> NSViewController
    @State private var hovering = false
    @State private var anchor = MenuAnchor()

    var body: some View {
        let side = zoomed(15)
        let line = zoomed(2.5)
        Button {
            anchor.show { _ in popover() }
        } label: {
            ZStack {
                Circle().stroke(Color.primary.opacity(0.22), lineWidth: line)
                Circle()
                    // A sliver even when nearly empty, so it reads as a meter.
                    .trim(from: 0, to: max(0.03, meter.fraction))
                    .stroke(meter.isNearlyFull ? Color.orange : Color.secondary, style: StrokeStyle(lineWidth: line, lineCap: .round))
                    .rotationEffect(.degrees(-90))
            }
            .frame(width: side, height: side)
            .frame(width: zoomed(26), height: zoomed(26))
            .background(Circle().fill(Color.primary.opacity(hovering ? 0.08 : 0)))
            .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .background(MenuAnchorView(anchor: anchor))
        .onHover { hovering = $0 }
        .onChange(of: openRequest) { _, _ in anchor.show { _ in popover() } }
        .tip(meter.tip)
        .accessibilityLabel(meter.tip)
    }
}

/// The ring's popover: the context in tokens, what happens when it fills,
/// then the model and login the thread is really running on and what it
/// has cost. Reads the thread live, so it moves while a turn runs.
struct ContextPopover: View {
    @Environment(AppModel.self) private var app
    let threadId: String

    var body: some View {
        let thread = app.threads[threadId]
        VStack(alignment: .leading, spacing: 6) {
            if let thread, let meter = ContextMeter(thread) {
                Text("Context").font(.system(size: 13, weight: .semibold))
                ProgressView(value: meter.fraction)
                    .progressViewStyle(.linear)
                    .tint(meter.isNearlyFull ? .orange : .secondary)
                HStack {
                    Text(meter.amount)
                    Spacer()
                    Text("\(meter.percent)%").foregroundStyle(.secondary)
                }
                .font(.system(size: 12))
                Text(ContextMeter.compactNote(provider: thread.provider))
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Divider().padding(.vertical, 2)
                let settings = ThreadSettings(app: app, thread: thread)
                row("Model", ComposerChips.chipTitle(model: settings.effectiveModel, effort: settings.effectiveEffort, choices: settings.choices))
                row("Login", settings.logins.account(thread.accountId).map(AccountName.title) ?? thread.accountId)
                if let cost = CostText.format(thread.costUsd) { row("Cost so far", cost) }
            }
        }
        .padding(14)
        .frame(width: 260)
    }

    private func row(_ name: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(name).foregroundStyle(.secondary)
            Spacer(minLength: 12)
            Text(value).lineLimit(1).truncationMode(.middle)
        }
        .font(.system(size: 12))
    }
}

private struct ChipDivider: View {
    var body: some View {
        Rectangle()
            .fill(Color.primary.opacity(0.12))
            .frame(width: 1, height: zoomed(12))
    }
}

/// Opens a small menu: "Attach images…" and the folder.
private struct PlusButton: View {
    /// A folder picked from its menu is on its way.
    var busy = false
    let menu: () -> NSMenu
    @State private var hovering = false
    @State private var anchor = MenuAnchor()

    var body: some View {
        Button {
            anchor.popUp(menu())
        } label: {
            Image(systemName: "plus")
                .font(.system(size: zoomed(15), weight: .regular))
                .foregroundStyle(.secondary)
                .frame(width: zoomed(26), height: zoomed(26))
                .background(Circle().fill(Color.primary.opacity(hovering ? 0.08 : 0)))
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .busy(busy)
        .background(MenuAnchorView(anchor: anchor))
        .onHover { hovering = $0 }
        .tip("Attach images, change the folder or schedule the message")
        .accessibilityLabel("Attach images, change the folder or schedule the message")
    }
}

/// A 28 pt circle (at 100%): filled with the text colour when there's something to
/// send (or a turn to stop), faint and empty-looking when there isn't.
private struct SendButton: View {
    let running: Bool
    let canSend: Bool
    let sending: Bool
    /// The Stop is on its way: a spinner until the turn has ended.
    var stopping = false
    let onSend: () -> Void
    let onStop: () -> Void
    @Environment(\.sendNudges) private var nudges

    static var size: CGFloat { zoomed(28) }

    var body: some View {
        // Stop only while there's nothing typed: a follow-up typed during a
        // turn is sent into that turn (the runner steers the CLI), so the
        // one round button never stops a turn Mike meant to add to. ⌘. and
        // the Thread menu still stop it.
        if sending {
            // The runner is making the thread: a spinner in the button's
            // place until it has, however long a busy Mac makes that.
            SpinnerMark(color: .secondaryLabelColor)
                .padding(zoomed(6))
                .frame(width: Self.size, height: Self.size)
                .background(Circle().fill(Color.primary.opacity(0.1)))
                .tip("Starting the thread")
                .accessibilityLabel("Starting the thread")
        } else if running && !canSend && stopping {
            SpinnerMark(color: .secondaryLabelColor)
                .padding(zoomed(6))
                .frame(width: Self.size, height: Self.size)
                .background(Circle().fill(Color.primary.opacity(0.1)))
                .tip("Stopping")
                .accessibilityLabel("Stopping")
        } else if running && !canSend {
            Button(action: onStop) {
                Image(systemName: "stop.fill").font(.system(size: zoomed(9), weight: .bold))
            }
            .buttonStyle(CircleButtonStyle(filled: true))
            .shortcutHint(AppShortcuts.shared.display(.stop), .before)
            .tip(AppShortcuts.shared.tip("Stop", .stop))
            .accessibilityLabel("Stop")
            .shortcut(.stop)
        } else {
            Button(action: onSend) {
                Image(systemName: "arrow.up").font(.system(size: zoomed(13), weight: .semibold))
                    // Up 3 pt and back as Return lands: the first half of
                    // the message leaving (`SendLift`).
                    .keyframeAnimator(initialValue: CGFloat(0), trigger: Juice.reduceMotion ? 0 : nudges) { arrow, y in
                        arrow.offset(y: y)
                    } keyframes: { _ in
                        CubicKeyframe(-zoomed(3), duration: 0.05)
                        CubicKeyframe(0, duration: 0.07)
                    }
            }
            .buttonStyle(CircleButtonStyle(filled: canSend))
            .disabled(!canSend)
            .tip(running ? "Send (into this turn)" : "Send (Return)")
            .accessibilityLabel("Send")
        }
    }
}

private struct CircleButtonStyle: ButtonStyle {
    let filled: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(filled ? AnyShapeStyle(.background) : AnyShapeStyle(.tertiary))
            .frame(width: SendButton.size, height: SendButton.size)
            .background(Circle().fill(filled ? Color.primary : Color.primary.opacity(0.1)))
            .opacity(configuration.isPressed ? 0.7 : 1)
            .contentShape(Circle())
    }
}

// MARK: - Model picker

/// The model picker, laid out like T3 Code's so other providers can join
/// without a redesign: a rail down the left, a search box, the column's
/// models with the default starred and the chosen one ticked, and the
/// effort level along the bottom. There's no "default" effort any more:
/// the level picked last is what a new thread starts on.
///
/// With pools (docs/pools-plan.md) the rail lists pools with their logins
/// and best room, and a mixed pool lists its models under each provider.
/// "Pin to a login ›" went (28 Oct): Mike didn't want it. A thread pinned
/// before then (or by a script) still gets a "Pinned to … · Unpin" line.
struct ModelPickerView: View {
    @Environment(AppModel.self) private var app
    /// Nil for the new-thread composer.
    let threadId: String?
    let close: () -> Void
    @State private var query = ""
    @State private var columnId: String?
    @FocusState private var searching: Bool

    static var width: CGFloat { zoomed(380) }
    static var railWidth: CGFloat { zoomed(44) }
    /// A pool's rail has words in it, so it and the popover are wider.
    static var poolWidth: CGFloat { zoomed(440) }
    static var poolRailWidth: CGFloat { zoomed(96) }

    /// The model list scrolls past 320 pt at 100%, or sooner when there
    /// isn't room above the chip for the search box, the list, the effort
    /// levels and a pinned thread's Unpin line.
    /// Sized from the window it ran off the bottom of the screen in a
    /// thread whose window went up near the top of it.
    static func listMaxHeight(pools: Bool) -> CGFloat {
        var chrome = zoomed(140)
        if pools { chrome += zoomed(40) }
        let room = AppWindow.roomAboveAnchor ?? (AppWindow.contentHeight ?? 800) - zoomed(170)
        return max(zoomed(120), min(zoomed(320), room - chrome))
    }

    private var settings: ThreadSettings { ThreadSettings(app: app, thread: threadId.flatMap { app.threads[$0] }) }

    var body: some View {
        let settings = settings
        let pools = settings.usesPools
        let column = columnId ?? settings.columnId
        let sections = settings.sections(for: column, query: query)
        let railWidth = pools ? Self.poolRailWidth : Self.railWidth
        // The rail is laid over the column's leading edge rather than
        // beside it in a stack: its full-height frame made the stack's
        // height a guess, and a short list (Codex's two models) floated in
        // the middle of a popover sized for a longer one.
        VStack(spacing: 0) {
                HStack(spacing: zoomed(6)) {
                    Image(systemName: "magnifyingglass")
                        .font(.system(size: zoomed(12)))
                        .foregroundStyle(.tertiary)
                    TextField("Search models", text: $query)
                        .textFieldStyle(.plain)
                        .font(.system(size: zoomed(13)))
                        .tip("Search by name or id. Return picks the first match.")
                        .focused($searching)
                        .onSubmit {
                            // Return takes the first match.
                            guard let section = sections.first(where: { !$0.rows.isEmpty }), let first = section.rows.first else { return }
                            settings.pick(first, section: section.id, column: column)
                            close()
                        }
                }
                .padding(.horizontal, zoomed(12))
                .frame(height: zoomed(36))
                Divider()
                ScrollView {
                    // Not lazy: a list this short costs nothing to build,
                    // and a lazy stack's guessed height left a short list
                    // (Codex's two models) floating in a popover sized for
                    // more.
                    VStack(alignment: .leading, spacing: zoomed(1)) {
                        ForEach(sections) { section in
                            if let title = section.title {
                                ListHeading(title: title, first: section.id == sections.first?.id)
                            }
                            ForEach(section.rows.filter { !$0.isOlder }) { row in
                                ModelRow(row: row, provider: section.id) {
                                    settings.pick(row, section: section.id, column: column)
                                    close()
                                }
                            }
                            let older = section.rows.filter(\.isOlder)
                            if !older.isEmpty {
                                ListHeading(title: "Older", first: false)
                                ForEach(older) { row in
                                    ModelRow(row: row, provider: section.id) {
                                        settings.pick(row, section: section.id, column: column)
                                        close()
                                    }
                                }
                            }
                        }
                        if sections.allSatisfy(\.rows.isEmpty) {
                            Text(query.isEmpty ? "No models listed yet" : "Nothing matches")
                                .font(.system(size: zoomed(13)))
                                .foregroundStyle(.secondary)
                                .padding(zoomed(10))
                        }
                    }
                    .padding(zoomed(6))
                }
                .frame(maxHeight: Self.listMaxHeight(pools: pools))
                .fixedSize(horizontal: false, vertical: true)
                Divider()
                EffortRow(levels: settings.effortLevels, chosen: settings.effectiveEffort) { settings.setEffort($0) }
                if pools, settings.pinnedLine != nil {
                    Divider()
                    PoolFooter(settings: settings, column: column, showPinned: { columnId = ThreadSettings.pinnedColumn },
                               close: close)
                }
        }
        .padding(.leading, railWidth + 1)
        .overlay(alignment: .leading) {
            HStack(spacing: 0) {
                PickerRail(columns: settings.columns, selected: column, width: railWidth) { id in
                    columnId = id
                    query = ""
                }
                Divider()
            }
        }
        .frame(width: pools ? Self.poolWidth : Self.width)
        .onAppear { searching = true }
        // Shut again for next time.
    }
}

/// A small heading in the model list: "Older", or a provider's name in a
/// mixed pool.
private struct ListHeading: View {
    let title: String
    let first: Bool

    var body: some View {
        Text(title)
            .font(.system(size: zoomed(11), weight: .medium))
            .foregroundStyle(.tertiary)
            .padding(.horizontal, zoomed(10))
            .padding(.top, zoomed(first ? 4 : 8))
            .padding(.bottom, zoomed(2))
            .accessibilityAddTraits(.isHeader)
    }
}

/// The picker's rail. A pool is its providers' logos over its title, with
/// "3 · 61%" under it; a provider (no pools) is its logo. The open column is filled in; a pinned
/// thread's opens on its own login, with no pool filled.
private struct PickerRail: View {
    let columns: [ModelPicker.Column]
    let selected: String
    let width: CGFloat
    let choose: (String) -> Void

    var body: some View {
        VStack(spacing: zoomed(4)) {
            ForEach(columns) { column in
                if let symbol = column.symbol {
                    IconButton(provider: column.id, symbol: symbol, title: column.title, active: column.id == selected) { choose(column.id) }
                } else {
                    PoolButton(column: column, active: column.id == selected) { choose(column.id) }
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, zoomed(6))
        .frame(width: width)
        .frame(maxHeight: .infinity)
        .background(Color.primary.opacity(0.03))
    }

    private struct IconButton: View {
        /// Without pools a column is a provider, so its id names the logo.
        let provider: String
        let symbol: String
        let title: String
        let active: Bool
        let action: () -> Void
        @State private var hovering = false

        var body: some View {
            Button(action: action) {
                ProviderMark(provider: provider, symbol: symbol, side: zoomed(16))
                    .foregroundStyle(active ? .primary : .secondary)
                    .frame(width: zoomed(30), height: zoomed(30))
                    .background(
                        RoundedRectangle(cornerRadius: zoomed(7), style: .continuous)
                            .fill(Color.primary.opacity(active ? 0.1 : hovering ? 0.06 : 0))
                    )
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .onHover { hovering = $0 }
            .tip(title)
            .accessibilityLabel(title)
        }
    }

    private struct PoolButton: View {
        let column: ModelPicker.Column
        let active: Bool
        let action: () -> Void
        @State private var hovering = false

        var body: some View {
            Button(action: action) {
                VStack(spacing: zoomed(1)) {
                    if !column.providers.isEmpty {
                        // A mixed pool shows each of its providers' logos.
                        HStack(spacing: zoomed(4)) {
                            ForEach(column.providers, id: \.self) { provider in
                                ProviderMark(provider: provider, symbol: ModelPicker.providerSymbol(provider), side: zoomed(15))
                            }
                        }
                        .foregroundStyle(active ? .primary : .secondary)
                        .padding(.bottom, zoomed(3))
                        .accessibilityHidden(true)
                    }
                    // One weight either way: a bolder chosen title
                    // ("Side projects") no longer fitted the rail.
                    Text(column.title)
                        .font(.system(size: zoomed(12)))
                        .foregroundStyle(active ? .primary : .secondary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.85)
                        .truncationMode(.tail)
                    if let subtitle = column.subtitle {
                        Text(subtitle)
                            .font(.system(size: zoomed(10.5)))
                            .monospacedDigit()
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                    }
                }
                .padding(.horizontal, zoomed(4))
                .frame(maxWidth: .infinity)
                .frame(height: zoomed(column.providers.isEmpty ? 40 : 56))
                .background(
                    RoundedRectangle(cornerRadius: zoomed(7), style: .continuous)
                        .fill(Color.primary.opacity(active ? 0.1 : hovering ? 0.06 : 0))
                )
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .padding(.horizontal, zoomed(6))
            .onHover { hovering = $0 }
            .tip(column.title + (column.subtitle.map { ": \($0)" } ?? ""))
            .accessibilityLabel(column.title + (active ? ", chosen" : ""))
        }
    }
}

/// Under the effort levels, for a pinned thread: the login it's on, and
/// Unpin to hand it back to the pool.
private struct PoolFooter: View {
    let settings: ThreadSettings
    let column: String
    let showPinned: () -> Void
    let close: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: zoomed(6)) {
            if let pinned = settings.pinnedLine {
                HStack(spacing: zoomed(4)) {
                    Button(pinned, action: showPinned)
                        .buttonStyle(.plain)
                        .foregroundStyle(.secondary)
                        .tip("Show this login's models")
                    Text("·").foregroundStyle(.tertiary)
                    Button("Unpin") {
                        settings.unpin()
                        close()
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.primary)
                    .tip("Let the pool pick the login again")
                }
                .font(.system(size: zoomed(11)))
            }
        }
        .padding(.horizontal, zoomed(12))
        .padding(.vertical, zoomed(10))
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// A model: its provider's logo in a tile, its name and the CLI's line
/// about it, and a star when it's the default. The one in use is filled
/// in rather than ticked (Mike's pick, 5 Nov: docs/model-picker-logos-design,
/// B). The logo is on every row, even where a list is all one provider's,
/// so a mixed pool's Claude and Codex models read apart at a glance.
private struct ModelRow: View {
    let row: ModelPicker.Row
    let provider: String
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: zoomed(10)) {
                ProviderMark(provider: provider, symbol: ModelPicker.providerSymbol(provider), side: zoomed(15))
                    .foregroundStyle(row.isSelected ? .primary : .secondary)
                    .frame(width: zoomed(26), height: zoomed(26))
                    .background(
                        RoundedRectangle(cornerRadius: zoomed(7), style: .continuous)
                            .fill(Color.primary.opacity(0.07))
                    )
                    .opacity(row.isOlder ? 0.6 : 1)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: zoomed(1)) {
                    Text(row.title)
                        .font(.system(size: zoomed(13), weight: .medium))
                        .foregroundStyle(.primary)
                    if let subtitle = row.subtitle, !subtitle.isEmpty {
                        Text(subtitle)
                            .font(.system(size: zoomed(11)))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: zoomed(8))
                if row.isDefault {
                    Image(systemName: "star.fill")
                        .font(.system(size: zoomed(9)))
                        .foregroundStyle(.tertiary)
                        .tip("The default")
                        .accessibilityLabel("Default")
                }
            }
            .padding(.leading, zoomed(6))
            .padding(.trailing, zoomed(10))
            .padding(.vertical, zoomed(5))
            .background(
                RoundedRectangle(cornerRadius: zoomed(8), style: .continuous)
                    .fill(Color.primary.opacity(row.isSelected ? 0.1 : hovering ? 0.06 : 0))
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        // The id the CLI is given, which the name hides.
        .tip(row.id)
        .accessibilityLabel(row.title + (row.isSelected ? ", chosen" : ""))
    }
}

/// A provider's logo (ProviderLogo), or its SF Symbol where the app has
/// none, `side` points across. Takes the foreground style around it.
private struct ProviderMark: View {
    let provider: String
    let symbol: String
    let side: CGFloat

    var body: some View {
        if let logo = ProviderLogo.image(provider, side: side) {
            Image(nsImage: logo)
                .renderingMode(.template)
                .resizable()
                .frame(width: side, height: side)
        } else {
            Image(systemName: symbol)
                .font(.system(size: side * 0.85, weight: .medium))
                .frame(width: side, height: side)
        }
    }
}

/// The effort level as a row of segments, the chosen one filled, with
/// Goldilocks's word for it alongside.
private struct EffortRow: View {
    let levels: [String]
    let chosen: String?
    let choose: (String) -> Void

    var body: some View {
        // Just the levels: the "Effort" heading and the porridge line over
        // them were dropped as clutter (28 Oct); the porridge is in each
        // level's tip.
        HStack(spacing: zoomed(2)) {
            ForEach(levels, id: \.self) { level in
                Segment(title: ComposerChips.effortTitle(level), active: level == chosen) { choose(level) }
                    .tip(ComposerChips.effortPorridge(level) ?? ComposerChips.effortTitle(level))
            }
        }
        .padding(zoomed(2))
        .background(
            RoundedRectangle(cornerRadius: zoomed(7), style: .continuous)
                .fill(Color.primary.opacity(0.05))
        )
        .padding(.horizontal, zoomed(12))
        .padding(.vertical, zoomed(10))
    }

    private struct Segment: View {
        let title: String
        let active: Bool
        let action: () -> Void
        @State private var hovering = false

        var body: some View {
            Button(action: action) {
                Text(title)
                    .font(.system(size: zoomed(11), weight: active ? .semibold : .regular))
                    .foregroundStyle(active ? .primary : .secondary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                    .frame(maxWidth: .infinity)
                    .frame(height: zoomed(22))
                    .background(
                        RoundedRectangle(cornerRadius: zoomed(5), style: .continuous)
                            .fill(active ? Color(nsColor: .controlBackgroundColor) : Color.primary.opacity(hovering ? 0.05 : 0))
                            .shadow(color: .black.opacity(active ? 0.12 : 0), radius: 1, y: 0.5)
                    )
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .onHover { hovering = $0 }
        }
    }
}

// MARK: - Account picker

/// The account picker: the logins grouped by provider, each by its email
/// with its note and the room it has left under it, and where the numbers
/// came from at the bottom. A popover rather than a menu, like the model
/// picker beside it, so its rows can say more than a title.
struct AccountPickerView: View {
    @Environment(AppModel.self) private var app
    /// Nil for the new-thread composer.
    let threadId: String?
    let close: () -> Void

    static var width: CGFloat { zoomed(360) }

    private var settings: ThreadSettings { ThreadSettings(app: app, thread: threadId.flatMap { app.threads[$0] }) }

    var body: some View {
        let settings = settings
        let sections = settings.accountSections
        VStack(alignment: .leading, spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: zoomed(1)) {
                    ForEach(sections) { section in
                        Text(section.title)
                            .font(.system(size: zoomed(11), weight: .medium))
                            .foregroundStyle(.tertiary)
                            .padding(.horizontal, zoomed(10))
                            .padding(.top, zoomed(section.id == sections.first?.id ? 2 : 10))
                            .padding(.bottom, zoomed(2))
                            .accessibilityAddTraits(.isHeader)
                        ForEach(section.items) { item in
                            LoginRow(item: item) {
                                settings.setAccount(item.id)
                                close()
                            }
                        }
                    }
                    if sections.isEmpty {
                        Text("No accounts yet")
                            .font(.system(size: zoomed(13)))
                            .foregroundStyle(.secondary)
                            .padding(zoomed(10))
                    }
                }
                .padding(zoomed(6))
            }
            .frame(maxHeight: max(zoomed(160), min(zoomed(420), (AppWindow.roomAboveAnchor ?? (AppWindow.contentHeight ?? 800) - zoomed(170)) - zoomed(130))))
            .fixedSize(horizontal: false, vertical: true)
            if let footer = settings.accountFooter {
                Divider()
                Text(footer)
                    .font(.system(size: zoomed(11)))
                    .foregroundStyle(.tertiary)
                    .padding(.horizontal, zoomed(16))
                    .padding(.vertical, zoomed(8))
            }
        }
        .frame(width: Self.width)
    }
}

/// A login: its email, its note and room under it (coloured when it's
/// running out), and a tick when it's the one chosen.
private struct LoginRow: View {
    let item: AccountMenu.Item
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: zoomed(8)) {
                VStack(alignment: .leading, spacing: zoomed(1)) {
                    Text(item.title)
                        .font(.system(size: zoomed(13), weight: .medium))
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                    if let subtitle = item.subtitle {
                        // Two lines rather than "resets t…".
                        Text(subtitle)
                            .font(.system(size: zoomed(11)))
                            .foregroundStyle(subtitleStyle)
                            .lineLimit(2)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: zoomed(8))
                Image(systemName: "checkmark")
                    .font(.system(size: zoomed(11), weight: .semibold))
                    .foregroundStyle(.primary)
                    .opacity(item.isSelected ? 1 : 0)
                    .accessibilityHidden(!item.isSelected)
            }
            .padding(.horizontal, zoomed(10))
            .padding(.vertical, zoomed(5))
            .background(
                RoundedRectangle(cornerRadius: zoomed(6), style: .continuous)
                    .fill(Color.primary.opacity(hovering ? 0.06 : 0))
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .tip(item.subtitle ?? item.title)
        .accessibilityLabel(item.title + (item.isSelected ? ", chosen" : ""))
    }

    /// The usage line is grey, unless the account is running out (as
    /// the chip shows it): then the colour says so.
    private var subtitleStyle: AnyShapeStyle {
        switch item.badge {
        case .blocked?: return AnyShapeStyle(Color.red)
        case .low?: return AnyShapeStyle(Color.orange)
        case nil: return AnyShapeStyle(.secondary)
        }
    }
}
