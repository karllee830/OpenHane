import Foundation
import Observation
import Sparkle

/// 应用自动更新（Sparkle）。更新清单的地址和验签公钥在 Info.plist（SUFeedURL、SUPublicEDKey）。
/// Dev 版和 Debug 构建不检查更新。
@MainActor @Observable
final class AppUpdater: NSObject, SPUUpdaterDelegate {
    static let shared = AppUpdater()
    nonisolated static let betaKey = "updates.beta"

    let enabled: Bool
    private(set) var canCheck = false
    var beta: Bool {
        didSet { UserDefaults.standard.set(beta, forKey: Self.betaKey) }
    }
    var automaticChecks: Bool {
        get { controller?.updater.automaticallyChecksForUpdates ?? false }
        set { controller?.updater.automaticallyChecksForUpdates = newValue }
    }

    @ObservationIgnored private var controller: SPUStandardUpdaterController?
    @ObservationIgnored private var canCheckObservation: NSKeyValueObservation?

    private override init() {
        let version = Bundle.main.object(forInfoDictionaryKey: "HaneVersion") as? String ?? ""
        #if DEBUG
        enabled = false
        #else
        enabled = !version.contains("-dev")
        #endif
        UserDefaults.standard.register(defaults: [Self.betaKey: version.contains("-beta")])
        beta = UserDefaults.standard.bool(forKey: Self.betaKey)
        super.init()
        guard enabled else { return }
        let controller = SPUStandardUpdaterController(startingUpdater: true, updaterDelegate: self, userDriverDelegate: nil)
        self.controller = controller
        canCheckObservation = controller.updater.observe(\.canCheckForUpdates, options: [.initial, .new]) { [weak self] updater, _ in
            let can = updater.canCheckForUpdates
            Task { @MainActor in self?.canCheck = can }
        }
    }

    func checkForUpdates() {
        controller?.checkForUpdates(nil)
    }

    /// 打开「接收公测版」时，也接受 appcast 里标记为 beta 频道的版本
    nonisolated func allowedChannels(for updater: SPUUpdater) -> Set<String> {
        UserDefaults.standard.bool(forKey: Self.betaKey) ? ["beta"] : []
    }
}
