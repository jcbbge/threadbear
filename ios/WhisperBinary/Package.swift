// swift-tools-version: 6.0
// whisper.cpp's prebuilt framework on its own, for the phone's Whisper
// dictation (Threadbear/Whisper). Release b5454, the exact binary Voice Type
// on the Mac runs and its benchmark measured, so the phone hears the same
// way. SwiftPM downloads it into the derived data; no binaries go in git.
//
// To update: `swift package compute-checksum whisper-<tag>-xcframework.zip`
// on the release's zip gives the checksum.
import PackageDescription

let package = Package(
    name: "WhisperBinary",
    products: [
        .library(name: "whisper", targets: ["whisper"]),
    ],
    targets: [
        .binaryTarget(
            name: "whisper",
            url: "https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-b5454-xcframework.zip",
            checksum: "e57f8c48933000acabc13bb913fbe82805d483a2deff692cc6738836bd92393b"
        ),
    ]
)
