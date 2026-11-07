import AVFoundation
import SwiftUI

/// The camera, looking for a QR code. Calls `onCode` once with the first
/// code whose text `accept` likes, so a stray code on the desk doesn't end
/// the scan. AVFoundation rather than VisionKit's DataScanner, since this
/// only needs QR codes and works the same on the XS Max.
struct QRScanner: UIViewControllerRepresentable {
    var accept: (String) -> Bool
    var onCode: (String) -> Void

    func makeUIViewController(context: Context) -> ScannerController {
        let controller = ScannerController()
        controller.accept = accept
        controller.onCode = onCode
        return controller
    }

    func updateUIViewController(_ controller: ScannerController, context: Context) {}

    final class ScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
        var accept: (String) -> Bool = { _ in true }
        var onCode: (String) -> Void = { _ in }
        private let session = AVCaptureSession()
        private var preview: AVCaptureVideoPreviewLayer?
        private var found = false

        override func viewDidLoad() {
            super.viewDidLoad()
            view.backgroundColor = .black
            guard let camera = AVCaptureDevice.default(for: .video),
                  let input = try? AVCaptureDeviceInput(device: camera), session.canAddInput(input) else { return }
            session.addInput(input)
            let output = AVCaptureMetadataOutput()
            guard session.canAddOutput(output) else { return }
            session.addOutput(output)
            output.setMetadataObjectsDelegate(self, queue: .main)
            output.metadataObjectTypes = [.qr]
            let layer = AVCaptureVideoPreviewLayer(session: session)
            layer.videoGravity = .resizeAspectFill
            view.layer.addSublayer(layer)
            preview = layer
        }

        override func viewDidLayoutSubviews() {
            super.viewDidLayoutSubviews()
            preview?.frame = view.bounds
        }

        override func viewWillAppear(_ animated: Bool) {
            super.viewWillAppear(animated)
            let session = session
            // startRunning blocks, so off the main thread.
            DispatchQueue.global(qos: .userInitiated).async { session.startRunning() }
        }

        override func viewWillDisappear(_ animated: Bool) {
            super.viewWillDisappear(animated)
            let session = session
            DispatchQueue.global(qos: .userInitiated).async { session.stopRunning() }
        }

        nonisolated func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput objects: [AVMetadataObject], from connection: AVCaptureConnection) {
            let codes = objects.compactMap { ($0 as? AVMetadataMachineReadableCodeObject)?.stringValue }
            MainActor.assumeIsolated {
                guard !found, let code = codes.first(where: accept) else { return }
                found = true
                UINotificationFeedbackGenerator().notificationOccurred(.success)
                onCode(code)
            }
        }
    }
}

/// The scanner as a sheet: the camera full screen, a frame to aim with, and
/// a line saying what to point it at. Asks for the camera first and says so
/// plainly if it's been turned off.
struct ScanSheet: View {
    @Environment(\.dismiss) private var dismiss
    var accept: (String) -> Bool
    var onCode: (String) -> Void
    @State private var allowed: Bool?

    var body: some View {
        NavigationStack {
            ZStack {
                Color.black.ignoresSafeArea()
                switch allowed {
                case .some(true):
                    QRScanner(accept: accept) { code in
                        dismiss()
                        onCode(code)
                    }
                    .ignoresSafeArea()
                    RoundedRectangle(cornerRadius: 24, style: .continuous)
                        .strokeBorder(.white.opacity(0.85), lineWidth: 3)
                        .frame(width: 250, height: 250)
                        .accessibilityHidden(true)
                    VStack {
                        Spacer()
                        Text("Point it at the code on your Mac")
                            .font(.subheadline)
                            .foregroundStyle(.white)
                            .padding(.horizontal, 16)
                            .padding(.vertical, 10)
                            .background(.black.opacity(0.5), in: Capsule())
                            .padding(.bottom, 40)
                    }
                case .some(false):
                    VStack(spacing: 16) {
                        Text("Threadbear can't use the camera")
                            .font(.headline)
                        Text("Turn it on in Settings to scan the pairing code.")
                            .multilineTextAlignment(.center)
                        Button("Open Settings") {
                            // The app's own Settings page, not a link from anywhere.
                            if let url = URL(string: UIApplication.openSettingsURLString) { LinkGate.shared.openOwn(url) }
                        }
                        .buttonStyle(.borderedProminent)
                    }
                    .foregroundStyle(.white)
                    .padding(32)
                case .none:
                    ProgressView().tint(.white)
                }
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }.tint(.white)
                }
            }
            .toolbarBackground(.hidden, for: .navigationBar)
        }
        .task {
            switch AVCaptureDevice.authorizationStatus(for: .video) {
            case .authorized: allowed = true
            case .notDetermined: allowed = await AVCaptureDevice.requestAccess(for: .video)
            default: allowed = false
            }
        }
    }
}
