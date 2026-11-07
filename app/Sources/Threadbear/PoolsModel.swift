import AppKit
import ThreadbearCore

/// Pools on AppModel (docs/pools-plan.md, "App pieces"): which pool and
/// provider a new thread starts on, what a pick in the model picker does to
/// a thread, pinning and unpinning, and Settings › Pools' saves. With a
/// runner older than pools (`usesPools` false) none of this is used.
extension AppModel {
    /// The composer shows pools rather than accounts.
    var usesPools: Bool { poolsSupported && !pools.isEmpty }

    func pool(_ id: String) -> Pool? { pools.first { $0.id == id } }

    /// The pool Mike last picked; the runner's default until he has.
    var lastPoolId: String? {
        UserDefaults.standard.string(forKey: Self.lastPoolKey) ?? defaults.poolId
    }

    /// The provider Mike last picked a model of in each pool.
    var lastPoolProviders: [String: String] {
        (UserDefaults.standard.dictionary(forKey: Self.lastPoolProvidersKey) as? [String: String]) ?? [:]
    }

    /// Remembered across launches: the next thread outside a pool's folders
    /// starts here, on this provider.
    func rememberPool(_ poolId: String, provider: String?) {
        UserDefaults.standard.set(poolId, forKey: Self.lastPoolKey)
        guard let provider else { return }
        var providers = lastPoolProviders
        providers[poolId] = provider
        UserDefaults.standard.set(providers, forKey: Self.lastPoolProvidersKey)
    }

    /// The pool the next new thread starts on: Mike's pick for the draft,
    /// else its folder's, else the last one he picked. Nil when it's pinned
    /// to a login, or with no pools.
    var newThreadPoolId: String? {
        guard newThreadUsesPools, newThreadAccount == nil else { return nil }
        // Another runner's pools and default for a draft on it.
        let logins = draftLogins
        return Pools.newThreadPool(logins.pools, picked: newThreadPool, cwd: newThreadCwd ?? logins.defaults.cwd, home: NSHomeDirectory(),
                                   last: lastPoolId, runnerDefault: logins.defaults.poolId)
    }

    /// The new-thread composer shows pools: this Mac's runner's, or the
    /// chosen runner's (one that sends pools in its hello has them).
    var newThreadUsesPools: Bool {
        guard newThreadRunnerId != nil else { return usesPools }
        return !(newThreadLogins?.pools.isEmpty ?? true)
    }

    /// Which of a pool's providers a new thread in it runs on: the one
    /// picked for this draft, else the one last picked in that pool, else
    /// the pool's first.
    func newThreadProvider(in poolId: String) -> String {
        let logins = draftLogins
        guard let pool = logins.pool(poolId) else { return "claude" }
        let providers = Pools.providers(pool, accounts: logins.accounts)
        for candidate in [newThreadProvider, lastPoolProviders[poolId]] {
            if let candidate, providers.contains(candidate) { return candidate }
        }
        return providers.first ?? "claude"
    }

    /// `threads.create` for the new-thread composer. With pools it names
    /// the pool, or the login when the draft is pinned; in a mixed pool the
    /// model is always named, since that's how the runner knows which
    /// provider Mike meant.
    func newThreadRequest(text: String, images: [ImageRef]) -> NewThreadRequest {
        // This Mac's logins, or the chosen runner's for a draft on it.
        let logins = draftLogins
        let ask = newThreadPermission
        // Another runner that hasn't said hello yet: its own defaults,
        // in the folder typed for it if any (the runner checks it).
        if newThreadRunnerId != nil, newThreadLogins == nil {
            return NewThreadRequest(text: text, images: [], cwd: newThreadCwd, permissionMode: ask)
        }
        let cwd = newThreadCwd ?? logins.defaults.cwd
        if let poolId = newThreadPoolId, let pool = logins.pool(poolId) {
            let provider = newThreadProvider(in: poolId)
            var model = lastModels[provider]
            if model == nil, Pools.providers(pool, accounts: logins.accounts).count > 1 {
                model = logins.defaults.model(for: provider) ?? logins.account(newThreadAccountId)?.defaultModel
            }
            return NewThreadRequest(text: text, images: images, cwd: cwd, poolId: poolId, model: model,
                                    effort: lastEfforts[provider], permissionMode: ask)
        }
        let account = newThreadAccountId
        let provider = logins.account(account)?.provider ?? "claude"
        return NewThreadRequest(text: text, images: images, cwd: cwd, accountId: account,
                                model: lastModels[provider], effort: lastEfforts[provider], permissionMode: ask)
    }

    /// A model picked in a pool's column of the picker. For a new thread
    /// the draft moves to that pool and provider; for a thread, it moves
    /// into the pool (`moveThread(_:toPool:provider:model:)`). Either way
    /// the model is remembered under its provider, and the pool as the
    /// last one picked.
    func choosePool(_ poolId: String, provider: String, model: String?, threadId: String?) {
        rememberPool(poolId, provider: provider)
        if let threadId {
            moveThread(threadId, toPool: poolId, provider: provider, model: model)
        } else {
            newThreadAccount = nil
            newThreadPool = poolId
            newThreadProvider = provider
            remember(model: model, provider: provider)
        }
    }

    /// Moves a thread into a pool, onto `provider`. On its own provider
    /// it's one `threads.update` with the pool and the model; the runner
    /// moves it onto one of the pool's logins if its own isn't in it. For
    /// another provider it's two, in order: pin it to the pool's best login
    /// of that provider with the model and that provider's effort (a
    /// provider change, as the account picker always did), then put it in
    /// the pool, which keeps it on that login. The protocol has no one call
    /// for "this pool, on that provider".
    func moveThread(_ threadId: String, toPool poolId: String, provider: String, model: String?) {
        // Its runner's pools and logins: another Mac's for one of its threads.
        guard let client = client(for: threadId), let thread = threads[threadId], let logins = logins(for: thread), let pool = logins.pool(poolId) else { return }
        remember(model: model, provider: provider)
        if thread.provider == provider {
            return update(threadId, ThreadUpdate(model: .some(model), poolId: .some(poolId)))
        }
        guard let login = Pools.pickLogin(pool, accounts: logins.accounts, provider: provider, current: lastAccountId(provider: provider)) else { return }
        var change = ThreadUpdate(accountId: login, model: .some(model))
        if let effort = lastEfforts[provider] { change.effort = .some(effort) }
        let moving = BusyKey.moving(threadId)
        beginBusy(moving)
        Task {
            defer { endBusy(moving) }
            do {
                _ = try await client.updateThread(threadId, change)
                threads[threadId] = try await client.updateThread(threadId, ThreadUpdate(poolId: .some(poolId)))
            } catch {
                show(error)
            }
        }
    }

    /// Pins a thread to one login, so the runner never moves it. A login of
    /// another provider takes that provider's remembered model and effort,
    /// as a provider change always has.
    func pinThread(_ threadId: String, to accountId: String) {
        guard let thread = threads[threadId] else { return }
        let provider = provider(ofAccount: accountId)
        if provider != thread.provider {
            moveThread(threadId, toAccount: accountId, model: lastModels[provider])
        } else {
            setAccount(threadId, accountId)
        }
    }

    /// Puts a pinned thread back in a pool: one that has its login, so it
    /// stays where it is until that login runs dry.
    func unpinThread(_ threadId: String) {
        guard let thread = threads[threadId], let logins = logins(for: thread),
              let target = Pools.unpinTarget(logins.pools, accountId: thread.accountId, cwd: thread.cwd, home: NSHomeDirectory(), last: lastPoolId)
        else { return }
        update(threadId, ThreadUpdate(poolId: .some(target)))
    }

    /// Replaces the runner's pool list (Settings › Pools). True once saved.
    @discardableResult
    func savePools(_ list: [Pool]) async -> Bool {
        guard let client else {
            poolsError = "Not connected to the runner."
            return false
        }
        if let problem = Pools.problem(list, accounts: accounts) {
            poolsError = problem
            return false
        }
        do {
            pools = try await client.savePools(list)
            poolsError = nil
            return true
        } catch {
            poolsError = error.localizedDescription
            AppLog.write("rpc", "pools.save failed: \(error.localizedDescription)")
            return false
        }
    }
}
