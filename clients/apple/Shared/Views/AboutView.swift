import SwiftUI

/// 关于羽见：版本、版权、许可证，以及「开源许可」（第三方组件的许可证原文，与网页版一致）。
/// 放在 NavigationStack 里使用，「开源许可」推入下一页。
struct AboutView: View {
    private static let sourceURL = URL(string: "https://github.com/karllee830/OpenHane")!
    private static let designerURL = URL(string: "https://github.com/Kubai087")!

    private var version: String {
        let info = Bundle.main.infoDictionary
        let full = info?["HaneVersion"] as? String
        let short = (full?.isEmpty == false ? full : nil) ?? info?["CFBundleShortVersionString"] as? String ?? "?"
        let build = info?["CFBundleVersion"] as? String ?? "?"
        return "\(short) (\(build))"
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 14) {
                BrandMark(size: 80)
                VStack(spacing: 4) {
                    Text("羽见").font(.title2.bold())
                    Text("版本 \(version)").font(.callout).foregroundStyle(.secondary)
                }
                Text("自托管的语音、视频与屏幕共享")
                VStack(spacing: 4) {
                    Text(verbatim: "Copyright © 2026 Karl Lee (@karllee830)")
                    Text("以 GNU AGPL-3.0 授权的自由软件。「羽见」名称和图标保留所有权利。")
                    HStack(spacing: 0) {
                        Text("图标设计：")
                        Link("Kubai087", destination: Self.designerURL)
                    }
                }
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                HStack(spacing: 12) {
                    Link(destination: Self.sourceURL) { Label("源代码", systemImage: "arrow.up.right.square") }
                        .buttonStyle(.bordered)
                    NavigationLink { LicensesView() } label: { Text("开源许可") }
                        .buttonStyle(.borderedProminent)
                        .accessibilityIdentifier("about-licenses")
                }
                .padding(.top, 4)
            }
            .padding(24)
            .frame(maxWidth: .infinity)
        }
        .navigationTitle("关于羽见")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
    }
}

/// 第三方组件的许可证清单（scripts/licenses/generate.mjs 生成的 Shared/Licenses.json）。正文相同的组件合为一组。
struct LicensesView: View {
    private struct LicenseList: Decodable {
        let components: Int
        let groups: [LicenseGroup]
    }
    private struct LicenseGroup: Decodable, Identifiable {
        let license: String
        let packages: [String]
        let text: String
        var id: String { packages.joined(separator: "\n") }
    }

    @State private var list: LicenseList?
    @State private var failed = false

    var body: some View {
        List {
            if let list {
                Section {
                    ForEach(list.groups) { g in
                        DisclosureGroup {
                            Text(verbatim: g.text)
                                .font(.caption.monospaced())
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(verbatim: g.packages.joined(separator: ", "))
                                Text(verbatim: g.license).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                } header: {
                    Text("羽见使用了以下 \(list.components) 个开源组件，感谢它们的作者。点击可以查看许可证原文。")
                        .textCase(nil)
                }
            } else if failed {
                Text("无法加载开源许可清单。").foregroundStyle(.secondary)
            } else {
                ProgressView()
            }
        }
        .navigationTitle("开源许可")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .task {
            guard list == nil else { return }
            // 清单约 1 MB，在后台解码
            let loaded = await Task.detached(priority: .userInitiated) { () -> LicenseList? in
                guard let url = Bundle.main.url(forResource: "Licenses", withExtension: "json"),
                      let data = try? Data(contentsOf: url) else { return nil }
                return try? JSONDecoder().decode(LicenseList.self, from: data)
            }.value
            if let loaded { list = loaded } else { failed = true }
        }
    }
}
