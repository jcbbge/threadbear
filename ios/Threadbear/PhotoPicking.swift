import PhotosUI
import SwiftUI
import ThreadbearKit
import UniformTypeIdentifiers

/// A photo waiting in a composer, already prepared off the main thread
/// (PhotoPrep.prepared). `upload` is its copy in file storage, which goes
/// back if this is dropped before it's sent, and which trying a failed send
/// again reuses rather than leaving a second one in Convex.
@MainActor final class PickedPhoto: Identifiable {
    nonisolated let id = UUID()
    let jpeg: Data
    let thumbnail: UIImage
    var upload: PhotoUpload?
    /// Which connection `upload` started on (AppModel.startUpload).
    var uploadConnection = 0

    init(_ prepared: PhotoPrep.Prepared) {
        jpeg = prepared.jpeg
        thumbnail = UIImage(cgImage: prepared.thumbnail)
    }
}

/// Where a composer's cursor is, in its words (UTF-16). A plain reference,
/// so moving the cursor doesn't redraw the composer; the text field keeps
/// it up to date and puts the cursor back there after the words change.
final class TextCursor {
    var range = NSRange(location: NSNotFound, length: 0)
}

/// A composer's words and photos together: each photo a chip in the words,
/// a mark there (InlinePictures), and the photos in the marks' order.
@MainActor struct PhotoWords {
    var text: Binding<String>
    var photos: Binding<[PickedPhoto]>
    /// Photos being read and prepared, which the strip shows as spinners.
    /// Reading one can take seconds when iCloud has the original.
    var adding: Binding<Int>
    var cursor: TextCursor

    /// How many more it can take, counting the ones on their way.
    var room: Int { max(0, PhotoPrep.maxPhotos - photos.wrappedValue.count - adding.wrappedValue) }

    /// Reads and prepares each photo off the main thread, shows it as soon
    /// as it's ready and starts uploading it. All at once, so one waiting on
    /// iCloud doesn't hold up the rest, but they go in in the order given.
    /// `inTurn` reads each in the same turn it's prepared in, two at a time,
    /// for pasted ones, whose sizes nobody chose: then no more than two
    /// pictures' bytes are held at once.
    func add(_ loads: [@Sendable () async -> Data?], model: AppModel, inTurn: Bool = false) {
        let loads = Array(loads.prefix(room))
        guard !loads.isEmpty else { return }
        adding.wrappedValue += loads.count
        let reading = loads.map { load in
            Task.detached(priority: .userInitiated) { () -> PhotoPrep.Prepared? in
                if inTurn {
                    return await PhotoPrep.inTurn {
                        guard let data = await load() else { return nil }
                        return PhotoPrep.prepared(from: data)
                    }
                }
                guard let data = await load() else { return nil }
                return await PhotoPrep.preparedInTurn(from: data)
            }
        }
        Task {
            for task in reading {
                let prepared = await task.value
                adding.wrappedValue -= 1
                if let prepared {
                    let photo = PickedPhoto(prepared)
                    model.startUpload(photo)
                    insert([photo])
                } else {
                    model.report(TransportError.server("Couldn't read that photo."))
                }
            }
        }
    }

    /// Photos pasted in, as many as still fit, each read off the main
    /// thread as the file it was copied as and prepared as a picked one is.
    /// Never a UIImage made into a full-size JPEG first: a small file that
    /// unpacks to a huge picture did all that work before any limit could
    /// look at it (Daybreak, 7 Nov 2026).
    func addPasted(_ items: [NSItemProvider], model: AppModel) {
        add(items.map { PastedItem(provider: $0) }.map { item in { await Self.pastedData(item) } }, model: model, inTurn: true)
    }

    /// NSItemProvider isn't marked Sendable, but it's made to be read from
    /// any thread (its loads call back on one of their own).
    nonisolated private struct PastedItem: @unchecked Sendable { let provider: NSItemProvider }

    /// The picture's own bytes, or nil past PhotoPrep's limits (by its
    /// file's size, before reading it; its width and height are checked
    /// when it's prepared). Only ever as a file: its data in memory could
    /// be any size before anything could look (cross-lab review, 7 Nov).
    nonisolated private static func pastedData(_ pasted: PastedItem) async -> Data? {
        let item = pasted.provider
        let type = UTType.image.identifier
        return await withCheckedContinuation { done in
            _ = item.loadFileRepresentation(forTypeIdentifier: type) { url, _ in
                guard let url, let size = (try? url.resourceValues(forKeys: [.fileSizeKey]))?.fileSize,
                      size <= PhotoPrep.maxSourceBytes else { return done.resume(returning: nil) }
                done.resume(returning: try? Data(contentsOf: url))
            }
        }
    }

    /// New photos as chips where the cursor is (the end, before it's been
    /// in the box), as many as still fit.
    func insert(_ new: [PickedPhoto]) {
        let have = photos.wrappedValue
        let new = Array(new.prefix(max(0, PhotoPrep.maxPhotos - have.count)))
        guard !new.isEmpty else { return }
        let words = InlinePictures.normalized(text.wrappedValue, count: have.count)
        let at = cursor.range.location == NSNotFound ? NSRange(location: (words as NSString).length, length: 0) : cursor.range
        let result = InlinePictures.inserting(new.count, in: words, replacing: at)
        var all = have
        all.insert(contentsOf: new, at: min(result.firstIndex, all.count))
        cursor.range = NSRange(location: result.cursor, length: 0)
        photos.wrappedValue = all
        text.wrappedValue = result.text
    }

    /// The strip's remove button: the photo and its chip.
    func remove(_ photo: PickedPhoto) {
        var all = photos.wrappedValue
        guard let index = all.firstIndex(where: { $0.id == photo.id }) else { return }
        let words = InlinePictures.normalized(text.wrappedValue, count: all.count)
        all.remove(at: index)
        photos.wrappedValue = all
        text.wrappedValue = InlinePictures.removingMark(index, from: words)
    }

    /// What's sent: the words with each chip as a [Picture N] marker, or
    /// none when there are only photos.
    var message: String {
        InlinePictures.sentText(InlinePictures.normalized(text.wrappedValue, count: photos.wrappedValue.count))
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

/// The menu that adds a photo: take one or choose from the library. The
/// library picker runs outside the app, so it needs no permission; the camera
/// asks the first time. Left out where there's no camera (the simulator).
struct PhotoMenu<Label: View>: View {
    @Environment(AppModel.self) private var model
    var words: PhotoWords
    @ViewBuilder var label: () -> Label
    @State private var choosing = false
    @State private var chosen: [PhotosPickerItem] = []
    @State private var takingPhoto = false

    var body: some View {
        Menu {
            if UIImagePickerController.isSourceTypeAvailable(.camera) {
                Button("Take Photo", systemImage: "camera") { takingPhoto = true }
            }
            Button("Choose Photo", systemImage: "photo.on.rectangle") { choosing = true }
        } label: {
            label()
        }
        .disabled(words.room == 0)
        // .current: as it's stored. The default can have the system convert
        // each HEIC first, and PhotoPrep reads HEIC and makes its own JPEG anyway.
        .photosPicker(isPresented: $choosing, selection: $chosen, maxSelectionCount: max(1, words.room), matching: .images, preferredItemEncoding: .current)
        .onChange(of: chosen) {
            let items = chosen
            guard !items.isEmpty else { return }
            chosen = []
            words.add(items.map { item in { try? await item.loadTransferable(type: Data.self) } }, model: model)
        }
        .fullScreenCover(isPresented: $takingPhoto) {
            CameraPicker { image in
                // Encoding a full-size photo takes a moment too, so not on the main thread.
                words.add([{ image.jpegData(compressionQuality: 1) }], model: model)
            }
            .ignoresSafeArea()
        }
    }
}

/// The photos waiting to go, each with a button to take it out.
struct PhotoStrip: View {
    var words: PhotoWords

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(words.photos.wrappedValue) { photo in
                    Image(uiImage: photo.thumbnail)
                        .resizable()
                        .scaledToFill()
                        .frame(width: 64, height: 64)
                        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                        .overlay(alignment: .topTrailing) {
                            Button {
                                words.remove(photo)
                            } label: {
                                Image(systemName: "xmark.circle.fill")
                                    .symbolRenderingMode(.palette)
                                    .foregroundStyle(.white, .black.opacity(0.6))
                                    .font(.system(size: 20))
                                    .padding(3)
                            }
                            .accessibilityLabel("Remove photo")
                        }
                        .accessibilityLabel("Photo to send")
                }
                ForEach(0..<words.adding.wrappedValue, id: \.self) { _ in
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        // A fill, not a background colour: a Form's row is already that, and the tile vanished.
                        .fill(Color(.tertiarySystemFill))
                        .frame(width: 64, height: 64)
                        .overlay { ProgressView() }
                        .accessibilityLabel("Adding a photo")
                }
            }
        }
    }
}

/// The system camera. There's no SwiftUI one, so UIKit's picker, as QRScanner
/// wraps UIKit for the pairing code.
private struct CameraPicker: UIViewControllerRepresentable {
    var onPhoto: (UIImage) -> Void
    @Environment(\.dismiss) private var dismiss

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        private let parent: CameraPicker
        init(_ parent: CameraPicker) { self.parent = parent }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let image = info[.originalImage] as? UIImage { parent.onPhoto(image) }
            parent.dismiss()
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { parent.dismiss() }
    }
}
