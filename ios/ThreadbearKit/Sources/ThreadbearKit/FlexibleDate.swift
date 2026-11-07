import Foundation

/// Dates in Convex rows. The runner's own JSON uses ISO strings, and Convex
/// code tends to store milliseconds, so either is read. Written back as
/// milliseconds.
@propertyWrapper
public struct FlexibleDate: Codable, Sendable, Hashable {
    public var wrappedValue: Date

    public init(wrappedValue: Date) { self.wrappedValue = wrappedValue }

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let ms = try? c.decode(Double.self) {
            // Held to JavaScript's own dates (±8.64e15 ms): a runner writes
            // these, and 1e300 made "5m ago" trap in Int(_:). Held rather
            // than refused, as one thread's bad date mustn't empty the inbox.
            guard ms.isFinite else { throw DecodingError.dataCorruptedError(in: c, debugDescription: "Not a date: \(ms)") }
            wrappedValue = Date(timeIntervalSince1970: min(max(ms, -8.64e15), 8.64e15) / 1000)
        } else {
            let text = try c.decode(String.self)
            guard let date = ISODate.parse(text) else {
                throw DecodingError.dataCorruptedError(in: c, debugDescription: "Not a date: \(text)")
            }
            wrappedValue = date
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(wrappedValue.timeIntervalSince1970 * 1000)
    }
}

@propertyWrapper
public struct OptionalFlexibleDate: Codable, Sendable, Hashable {
    public var wrappedValue: Date?

    public init(wrappedValue: Date?) { self.wrappedValue = wrappedValue }

    public init(from decoder: Decoder) throws {
        // Lenient: a value this build can't read is treated as absent rather
        // than failing the whole list.
        let c = try decoder.singleValueContainer()
        wrappedValue = c.decodeNil() ? nil : (try? FlexibleDate(from: decoder))?.wrappedValue
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        if let wrappedValue { try c.encode(wrappedValue.timeIntervalSince1970 * 1000) } else { try c.encodeNil() }
    }
}

// An absent key should decode as nil rather than throwing keyNotFound.
extension KeyedDecodingContainer {
    public func decode(_ type: OptionalFlexibleDate.Type, forKey key: Key) throws -> OptionalFlexibleDate {
        try decodeIfPresent(type, forKey: key) ?? OptionalFlexibleDate(wrappedValue: nil)
    }
}

extension KeyedEncodingContainer {
    public mutating func encode(_ value: OptionalFlexibleDate, forKey key: Key) throws {
        if let date = value.wrappedValue { try encode(date.timeIntervalSince1970 * 1000, forKey: key) }
    }
}

public enum ISODate {
    public static func parse(_ text: String) -> Date? {
        if let date = try? Date(text, strategy: .iso8601) { return date }
        // The runner writes fractional seconds ("2026-10-27T08:23:19.962Z").
        let style = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
        return try? style.parse(text)
    }

    public static func string(_ date: Date) -> String {
        date.formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true))
    }
}
