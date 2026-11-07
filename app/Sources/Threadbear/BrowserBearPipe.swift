import Foundation
import Network

/// BrowserBear's existing private Unix socket, with replies and page frames on
/// one connection. No TCP listener or access to Chrome's profile files.
final class BrowserBearPipe: @unchecked Sendable {
    private let queue = DispatchQueue(label: "threadbear.browserbear")
    private let connection: NWConnection
    private var buffer = Data()
    private var nextId = 1
    private var waiting: [Int: ([String: Any]) -> Void] = [:]
    private var failures: [Int: (String) -> Void] = [:]
    private var closed = false
    var onEvent: (([String: Any]) -> Void)?
    var onError: ((String) -> Void)?
    var onRequestError: ((String) -> Void)?

    init(path: String = BrowserBear.socket) {
        connection = NWConnection(to: .unix(path: path), using: .tcp)
        connection.stateUpdateHandler = { [weak self] state in
            if case .failed(let error) = state { self?.fail(error.localizedDescription) }
            if case .waiting(let error) = state { self?.fail(error.localizedDescription) }
        }
        connection.start(queue: queue)
        receive()
    }

    func request(_ cmd: String, _ args: [String: Any] = [:], thread: String? = nil, failure: ((String) -> Void)? = nil, reply: (([String: Any]) -> Void)? = nil) {
        queue.async { [weak self] in
            guard let self, !self.closed else { return }
            let id = self.nextId
            self.nextId += 1
            if let reply { self.waiting[id] = reply }
            self.failures[id] = failure ?? { [weak self] in self?.onRequestError?($0) }
            var message: [String: Any] = ["id": id, "cmd": cmd, "args": args]
            if let thread { message["thread"] = thread }
            guard var data = try? JSONSerialization.data(withJSONObject: message) else { return }
            data.append(0x0A)
            self.connection.send(content: data, completion: .contentProcessed { [weak self] error in
                if let error { self?.fail(error.localizedDescription) }
            })
            self.queue.asyncAfter(deadline: .now() + 45) { [weak self] in
                guard let self, !self.closed, let failure = self.failures.removeValue(forKey: id) else { return }
                let reply = self.waiting.removeValue(forKey: id)
                failure("BrowserBear didn't answer in time.")
                reply?(["_error": "BrowserBear didn't answer in time."])
            }
        }
    }

    func close() {
        queue.async { [self] in
            closed = true
            waiting.removeAll()
            failures.removeAll()
            connection.cancel()
        }
    }

    private func fail(_ message: String) {
        guard !closed else { return }
        closed = true
        waiting.removeAll()
        failures.removeAll()
        connection.cancel()
        onError?(message)
    }

    private func receive() {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 1024 * 1024) { [weak self] data, _, complete, error in
            guard let self, !self.closed else { return }
            if let data { self.buffer.append(data) }
            guard self.buffer.count <= 16 * 1024 * 1024 else { return self.fail("BrowserBear sent an oversized frame.") }
            // A frame is hundreds of KB and comes in many reads, and the panel
            // gets up to 60 a second: look for its end only in what's new,
            // and take all the lines in one cut rather than one copy each.
            var start = self.buffer.startIndex
            var from = max(start, self.buffer.endIndex - (data?.count ?? 0))
            while let newline = self.buffer[from...].firstIndex(of: 0x0A) {
                let line = self.buffer[start..<newline]
                start = newline + 1
                from = start
                let message = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any]
                guard let message else { return self.fail("BrowserBear sent an unreadable response.") }
                if let id = message["id"] as? Int {
                    let reply = self.waiting.removeValue(forKey: id)
                    let failure = self.failures.removeValue(forKey: id)
                    if message["ok"] as? Bool == false {
                        let error = message["error"] as? String ?? "BrowserBear couldn't open this page."
                        failure?(error)
                        reply?(["_error": error])
                    }
                    else { reply?(message["result"] as? [String: Any] ?? [:]) }
                } else { self.onEvent?(message) }
            }
            if start > self.buffer.startIndex { self.buffer.removeSubrange(self.buffer.startIndex..<start) }
            if let error { self.fail(error.localizedDescription) }
            else if complete { self.fail("BrowserBear disconnected. Reopen the panel to reconnect.") }
            else { self.receive() }
        }
    }
}
