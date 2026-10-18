// swift-tools-version: 6.0
// OpenHaneKit：苹果客户端（macOS / iOS）共享的业务逻辑。
import Foundation
import PackageDescription

// AI 降噪（DeepFilterNet3）：库和模型由 clients/deepfilter/build.sh apple 生成（scripts/setup.sh 会在装了 Rust 时调用），不入库。
// 没有生成时照常构建，只是不提供 AI 降噪。
let fm = FileManager.default
let hasDeepFilter = fm.fileExists(atPath: Context.packageDirectory + "/Binaries/HaneDeepFilter.xcframework")
    && fm.fileExists(atPath: Context.packageDirectory + "/Sources/HaneMedia/Resources/deepfilternet3.bin")
let hasResources = fm.fileExists(atPath: Context.packageDirectory + "/Sources/HaneMedia/Resources")

let package = Package(
    name: "OpenHaneKit",
    defaultLocalization: "zh-Hans",
    platforms: [.macOS(.v14), .iOS(.v17)],
    products: [
        .library(name: "HaneCore", targets: ["HaneCore"]),
        .library(name: "HaneMedia", targets: ["HaneMedia"]),
    ],
    dependencies: [
        .package(url: "https://github.com/apple/swift-protobuf.git", exact: "1.38.1"),
        // 打过补丁的 LiveKit SDK，由 clients/apple/scripts/setup.sh 准备
        .package(path: "../../.vendor/client-sdk-swift"),
    ],
    targets: [
        .target(
            name: "HaneProtocol",
            dependencies: [.product(name: "SwiftProtobuf", package: "swift-protobuf")],
            path: "Sources/HaneProtocol"
        ),
        .target(name: "HaneCore", dependencies: ["HaneProtocol"]),
        .target(
            name: "HaneMedia",
            dependencies: ["HaneCore", .product(name: "LiveKit", package: "client-sdk-swift")] + (hasDeepFilter ? ["HaneDeepFilter"] : []),
            exclude: !hasDeepFilter && hasResources ? ["Resources"] : [],
            resources: hasDeepFilter ? [.copy("Resources/deepfilternet3.bin")] : [],
            swiftSettings: hasDeepFilter ? [.define("HANE_DEEPFILTER")] : []
        ),
        .testTarget(name: "HaneCoreTests", dependencies: ["HaneCore"]),
        .testTarget(name: "HaneIntegrationTests", dependencies: ["HaneCore", "HaneMedia"]),
    ] + (hasDeepFilter ? [.binaryTarget(name: "HaneDeepFilter", path: "Binaries/HaneDeepFilter.xcframework")] : [])
)
