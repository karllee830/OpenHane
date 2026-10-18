import HaneCore
import SwiftUI

/// 房间聊天。同一个人五分钟内连续发的消息合在一起，只显示一次头像和名字。
struct ChatView: View {
    @Environment(AppModel.self) private var model
    @State private var text = ""
    @State private var error: String?

    /// 连续消息合并显示的时间窗口
    private static let groupWindowMs: Int64 = 5 * 60 * 1000

    private var canSend: Bool { !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        let state = model.session.state
        let room = state.media?.roomID ?? "main"
        let messages = state.chat[room] ?? []
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        if state.chatHasMore[room] == true {
                            Button("加载更早的消息") {
                                Task { try? await model.session.loadChatHistory(room: room, before: messages.first?.id ?? 0) }
                            }
                            #if os(macOS)
                            .buttonStyle(.link)
                            #endif
                            .font(.callout)
                            .frame(maxWidth: .infinity)
                            .padding(.top, 10)
                        }
                        if messages.isEmpty {
                            emptyState
                        }
                        ForEach(Array(messages.enumerated()), id: \.element.id) { i, m in
                            let grouped = i > 0 && messages[i - 1].senderUid == m.senderUid && m.createdAtMs - messages[i - 1].createdAtMs < Self.groupWindowMs
                            MessageRow(m: m, showHeader: !grouped, isMe: m.senderUid == state.me?.uid)
                                .padding(.top, grouped ? 3 : 14)
                                .id(m.id)
                        }
                    }
                    .padding(.horizontal, 14)
                    .padding(.bottom, 14)
                }
                .defaultScrollAnchor(.bottom)
                .onChange(of: messages.last?.id) { _, id in
                    if let id { withAnimation { proxy.scrollTo(id, anchor: .bottom) } }
                }
            }
            Divider()
            composer
        }
    }

    private var emptyState: some View {
        VStack(spacing: 8) {
            Image(systemName: "bubble.left.and.bubble.right")
                .font(.system(size: 30))
                .foregroundStyle(.tertiary)
            Text("还没有消息")
                .font(.callout.weight(.medium))
                .foregroundStyle(.secondary)
            Text("在这里发送的消息，房间里的人都能看到。")
                .font(.caption)
                .foregroundStyle(.tertiary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 56)
        .padding(.horizontal, 12)
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let error {
                Label(error, systemImage: "exclamationmark.circle.fill")
                    .font(.caption)
                    .foregroundStyle(.red)
            }
            HStack(alignment: .bottom, spacing: 8) {
                TextField("发送消息…", text: $text, axis: .vertical)
                    .lineLimit(1 ... 5)
                    .textFieldStyle(.plain)
                    .onSubmit(send)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(RoundedRectangle(cornerRadius: 18, style: .continuous).fill(Color.primary.opacity(0.06)))
                    .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(Color.primary.opacity(0.08)))
                Button(action: send) {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 14, weight: .bold))
                        .foregroundStyle(.white)
                        .frame(width: 32, height: 32)
                        .background(Circle().fill(canSend ? Color.accentColor : Color.secondary.opacity(0.35)))
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .disabled(!canSend)
                .help("发送")
                .accessibilityLabel("发送")
                .padding(.bottom, 1)
            }
        }
        .padding(10)
        .animation(.easeOut(duration: 0.15), value: canSend)
    }

    private func send() {
        let body = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty else { return }
        text = ""
        error = nil
        Task {
            do { try await model.session.sendChat(body) } catch let e as HaneError {
                text = body
                error = describe(e)
            } catch {}
        }
    }
}

/// 一条消息：第一条带头像、名字和时间，后面连续的几条只有内容
private struct MessageRow: View {
    let m: ChatMessage
    let showHeader: Bool
    let isMe: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            if showHeader {
                AvatarView(name: m.senderName, uid: m.senderUid, size: 30)
            } else {
                Color.clear.frame(width: 30, height: 1)
            }
            VStack(alignment: .leading, spacing: 3) {
                if showHeader {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(m.senderName)
                            .font(.callout.weight(.semibold))
                            .foregroundStyle(isMe ? AnyShapeStyle(.tint) : AnyShapeStyle(.primary))
                            .lineLimit(1)
                        Text(Date(timeIntervalSince1970: Double(m.createdAtMs) / 1000), style: .time)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                Text(m.text)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
    }
}
