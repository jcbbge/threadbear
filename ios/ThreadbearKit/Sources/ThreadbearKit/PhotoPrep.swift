import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// Gets a photo ready to send: a JPEG no longer than `maxPixels` on its long
/// edge, the right way up. A 12 MP HEIC is far bigger than a model looks at
/// and would be slow on mobile data. Drawing it afresh also leaves its
/// metadata behind, so a photo's location never goes up to Convex.
public enum PhotoPrep {
    public static let maxPixels = 2048
    /// How many photos one message takes (phone.ts, MAX_COMMAND_IMAGES).
    public static let maxPhotos = 6

    /// The most a photo can be before it's prepared: past these it's
    /// refused before anything decodes it. A pasted picture can be a small
    /// file that unpacks to a huge one (a 16,000 px square PNG is 750 KB
    /// and 768 MB of pixels), and decoding that froze the phone or got it
    /// killed for its memory (Daybreak, 7 Nov 2026). The camera's 48 MP
    /// photos and its panoramas fit.
    public static let maxSourceBytes = 100 * 1024 * 1024
    public static let maxSourcePixels = 100_000_000

    /// The long edge of a composer's thumbnail: its 64 pt tile at 3x, for a
    /// 3:2 photo's short side, and plenty for a chip.
    public static let thumbnailPixels = 320

    /// A photo ready to go in a composer. All of it is decoded here, so
    /// this belongs off the main thread and showing the thumbnail costs it
    /// nothing: a composer never touches the 2048 px picture.
    public struct Prepared: Sendable {
        public let jpeg: Data
        public let thumbnail: CGImage
    }

    /// `prepared(from:)`, two photos at a time at most, so six big ones
    /// added together don't all hold their pixels at once.
    public static func preparedInTurn(from data: Data) async -> Prepared? {
        await inTurn { prepared(from: data) }
    }

    /// `work`, two at a time at most across the app (the same turns as
    /// `preparedInTurn`'s).
    public static func inTurn<T: Sendable>(_ work: @Sendable () async -> T) async -> T {
        await gate.enter()
        let result = await work()
        await gate.leave()
        return result
    }

    private static let gate = Gate(width: 2)

    private actor Gate {
        private var free: Int
        private var waiting: [CheckedContinuation<Void, Never>] = []
        init(width: Int) { free = width }

        func enter() async {
            if free > 0 { free -= 1; return }
            await withCheckedContinuation { waiting.append($0) }
        }

        func leave() {
            if waiting.isEmpty { free += 1 } else { waiting.removeFirst().resume() }
        }
    }

    public static func prepared(from data: Data) -> Prepared? {
        guard let jpeg = jpeg(from: data), let source = CGImageSourceCreateWithData(jpeg as CFData, nil) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceThumbnailMaxPixelSize: thumbnailPixels,
            // Decode now rather than on first draw, which is on the main thread.
            kCGImageSourceShouldCacheImmediately: true,
        ]
        guard let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        return Prepared(jpeg: jpeg, thumbnail: thumbnail)
    }

    /// Whether a picture is small enough to prepare, from its size and the
    /// width and height its header gives, before any of it is decoded.
    public static func fits(_ data: Data) -> Bool {
        guard data.count <= maxSourceBytes, let source = CGImageSourceCreateWithData(data as CFData, nil) else { return false }
        return fits(source)
    }

    static func fits(_ source: CGImageSource) -> Bool {
        guard CGImageSourceGetCount(source) > 0,
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = (properties[kCGImagePropertyPixelWidth] as? NSNumber)?.doubleValue,
              let height = (properties[kCGImagePropertyPixelHeight] as? NSNumber)?.doubleValue,
              width >= 1, height >= 1, width * height <= Double(maxSourcePixels) else { return false }
        return true
    }

    public static func jpeg(from data: Data, maxPixels: Int = maxPixels, quality: Double = 0.85) -> Data? {
        guard data.count <= maxSourceBytes, let source = CGImageSourceCreateWithData(data as CFData, nil), fits(source) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixels,
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        // On white, as JPEG has no transparency and a clear PNG would go black.
        guard let context = CGContext(data: nil, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: 0,
                                      space: CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB(),
                                      bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
        let rect = CGRect(x: 0, y: 0, width: image.width, height: image.height)
        context.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
        context.fill(rect)
        context.draw(image, in: rect)
        guard let flat = context.makeImage() else { return nil }
        let out = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(destination, flat, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
        return CGImageDestinationFinalize(destination) ? out as Data : nil
    }
}
