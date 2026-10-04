// swift-tools-version: 6.0
import PackageDescription
let package = Package(
    name: "NativeAttachmentPolicy",
    platforms: [.iOS(.v18)],
    products: [.library(name: "NativeAttachmentPolicy", targets: ["NativeAttachmentPolicy"])],
    targets: [
        .target(name: "NativeAttachmentPolicy"),
        .testTarget(name: "NativeAttachmentPolicyTests", dependencies: ["NativeAttachmentPolicy"])
    ]
)
