// Package conformance 维护三端共用的协议一致性样例：proto/testdata/conformance/ 下每个样例有
// <名称>.bin（二进制 Envelope）和 <名称>.json（规范 JSON）。Go、TypeScript、Swift 都必须把 .bin 解码成与 .json
// 相同的内容，并且重新编码后仍然一致。
//
// 重新生成：HANE_UPDATE_CONFORMANCE=1 go test ./internal/conformance/
package conformance

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"testing"

	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/encoding/protowire"
	"google.golang.org/protobuf/proto"

	"github.com/karllee830/OpenHane/server/internal/pb"
)

const dir = "../../../proto/testdata/conformance"

func ptr[T any](v T) *T { return &v }

func participant(id, name string, role pb.Role) *pb.Participant {
	return &pb.Participant{
		SessionId: id, Uid: "copdsqhgjnkjc4rardm2", Nickname: name, Role: role, RoomId: "main",
		State: &pb.SelfState{MicMuted: true, HandRaised: true}, Platform: pb.Platform_PLATFORM_MACOS,
		MediaConnected: true, MediaIdentity: "copdsqhgjnkjc4rardm2:" + id, CameraOn: true, ScreenSharing: true,
	}
}

func policy() *pb.MediaPolicy {
	return &pb.MediaPolicy{
		Audio:  &pb.AudioPolicy{Preset: pb.AudioPreset_AUDIO_PRESET_STANDARD, MaxBitrateBps: 32000, MusicModeAllowed: true, Red: true, Dtx: true},
		Camera: &pb.CameraPolicy{Allowed: true, MaxWidth: 1280, MaxHeight: 720, MaxFps: 30},
		Screen: &pb.ScreenPolicy{Allowed: true, MaxWidth: 2560, MaxHeight: 1440, MaxFps: 60, MaxBitrateBps: 8_000_000, AudioAllowed: true, MaxConcurrent: 2},
		Codecs: &pb.CodecPolicy{Mode: pb.CodecMode_CODEC_MODE_AUTO, RoomDecodable: []string{"video/av1", "video/h264"}},
		E2Ee:   &pb.E2EEPolicy{Mode: pb.E2EEMode_E2EE_MODE_OPTIONAL},
	}
}

// cases 覆盖各类消息，以及边界值（中文、emoji、空字符串、最大整数、负数时间戳）。
func cases() map[string]*pb.Envelope {
	seq := func(n uint64, ev *pb.Event) *pb.Envelope {
		ev.Seq = n
		return &pb.Envelope{Msg: &pb.Envelope_Event{Event: ev}}
	}
	return map[string]*pb.Envelope{
		"client_hello": {Msg: &pb.Envelope_ClientHello{ClientHello: &pb.ClientHello{
			ProtocolVersion: 1, Client: &pb.ClientInfo{AppVersion: "1.0.0", Platform: pb.Platform_PLATFORM_WEB, OsVersion: "macOS 26", DeviceName: "卡尔的 MacBook"},
			Caps:         &pb.Capabilities{Codecs: []*pb.CodecCapability{{Mime: "video/av1", Encode: true, Decode: true, Hardware: true}}, E2Ee: true},
			ResumeTicket: []byte{0, 1, 2, 255}, InviteCode: "AbC123",
		}}},
		"server_challenge": {Msg: &pb.Envelope_ServerChallenge{ServerChallenge: &pb.ServerChallenge{
			ProtocolVersion: 1, ServerId: bytes.Repeat([]byte{0x11}, 16), Nonce: bytes.Repeat([]byte{0x22}, 32),
			Info: &pb.ServerInfo{Name: "测试服务器 🎧", Version: "0.1.0", RequiresPassword: true, MinSecurityLevel: 16, WelcomeMessage: "欢迎！\n第二行", ProtocolMin: 1, ProtocolMax: 1},
		}}},
		"client_auth": {Msg: &pb.Envelope_ClientAuth{ClientAuth: &pb.ClientAuth{
			PublicKey: bytes.Repeat([]byte{0x3b}, 32), Signature: bytes.Repeat([]byte{0x44}, 64), SeenSpkiSha256: make([]byte, 32),
			TimestampMs: 1_760_000_000_123, Nickname: "小明", ServerPassword: "p@ss 密码",
			E2EeKey: &pb.SignedPublicKey{PublicKey: bytes.Repeat([]byte{5}, 32), Signature: bytes.Repeat([]byte{6}, 64)}, PowNonce: []byte{9},
		}}},
		"welcome": {Msg: &pb.Envelope_Welcome{Welcome: &pb.Welcome{
			SessionId: "4qy8nkgc2b", Uid: "copdsqhgjnkjc4rardm2", Nickname: "小明 (2)", Role: pb.Role_ROLE_ADMIN, ResumeTicket: []byte("ticket"), Resumed: true,
			Snapshot: &pb.Snapshot{
				Info:         &pb.ServerInfo{Name: "S", ProtocolMin: 1, ProtocolMax: 1},
				Rooms:        []*pb.Room{{Id: "main", Kind: pb.RoomKind_ROOM_KIND_MAIN, Name: "主会议", CreatedAtMs: 1}},
				Participants: []*pb.Participant{participant("4qy8nkgc2b", "小明 (2)", pb.Role_ROLE_ADMIN), participant("y8d433t8xc", "Alice", pb.Role_ROLE_MEMBER)},
				EventSeq:     18446744073709551615,
			},
			AutoJoin: &pb.JoinRoomResult{RoomId: "main", Media: &pb.MediaGrant{Token: "jwt.token.value", ExpiresAtMs: 1_760_000_300_000}, Policy: policy()},
		}}},
		"request_join_room":   {Msg: &pb.Envelope_Request{Request: &pb.Request{Id: 1, Body: &pb.Request_JoinRoom{JoinRoom: &pb.JoinRoom{RoomId: "main"}}}}},
		"request_update_self": {Msg: &pb.Envelope_Request{Request: &pb.Request{Id: 2, Body: &pb.Request_UpdateSelf{UpdateSelf: &pb.UpdateSelf{MicMuted: ptr(false), Nickname: ptr("新名字")}}}}},
		"request_send_chat":   {Msg: &pb.Envelope_Request{Request: &pb.Request{Id: 4294967295, Body: &pb.Request_SendChat{SendChat: &pb.SendChat{RoomId: "main", Text: "你好 👋", ClientMsgId: "c1", ReplyTo: 9}}}}},
		"request_update_settings": {Msg: &pb.Envelope_Request{Request: &pb.Request{Id: 5, Body: &pb.Request_UpdateSettings{UpdateSettings: &pb.UpdateSettings{
			Patch: map[string]string{"server.name": `"名字"`, "audio.preset": `"hd"`},
		}}}}},
		"request_create_token": {Msg: &pb.Envelope_Request{Request: &pb.Request{Id: 6, Body: &pb.Request_CreateToken{CreateToken: &pb.CreateToken{Role: pb.Role_ROLE_MODERATOR, MaxUses: 3, ExpiresInSec: 86400, Note: "给小明"}}}}},
		"response_error": {Msg: &pb.Envelope_Response{Response: &pb.Response{Id: 7, Error: &pb.Error{
			Code: pb.ErrorCode_ERROR_CODE_RATE_LIMITED, Message: "too many requests", RetryAfterMs: 1000,
		}}}},
		"response_chat_history": {Msg: &pb.Envelope_Response{Response: &pb.Response{Id: 8, Body: &pb.Response_GetChatHistory{GetChatHistory: &pb.GetChatHistoryResult{
			Messages: []*pb.ChatMessage{{Id: 1, RoomId: "main", SenderSessionId: "s", SenderUid: "u", SenderName: "A", Text: "第一条", CreatedAtMs: 1}, {Id: 2, RoomId: "main", SenderName: "B", Text: "", CreatedAtMs: -1}},
			HasMore:  true,
		}}}}},
		"response_redeem":        {Msg: &pb.Envelope_Response{Response: &pb.Response{Id: 9, Body: &pb.Response_RedeemToken{RedeemToken: &pb.RedeemTokenResult{Role: pb.Role_ROLE_ADMIN}}}}},
		"event_participant_join": seq(1, &pb.Event{Body: &pb.Event_ParticipantJoined{ParticipantJoined: &pb.ParticipantJoined{Participant: participant("a", "甲", pb.Role_ROLE_MODERATOR)}}}),
		"event_participant_left": seq(2, &pb.Event{Body: &pb.Event_ParticipantLeft{ParticipantLeft: &pb.ParticipantLeft{SessionId: "a"}}}),
		"event_chat":             seq(3, &pb.Event{Body: &pb.Event_ChatMessage{ChatMessage: &pb.ChatMessage{Id: 42, RoomId: "main", SenderName: "乙", Text: "多行\n消息", ReplyTo: 41, CreatedAtMs: 1_760_000_000_000, ClientMsgId: "x"}}}),
		"event_policy":           seq(4, &pb.Event{Body: &pb.Event_PolicyUpdated{PolicyUpdated: &pb.PolicyUpdated{RoomId: "main", Policy: policy()}}}),
		"event_role":             seq(5, &pb.Event{Body: &pb.Event_RoleChanged{RoleChanged: &pb.RoleChanged{Uid: "u", Role: pb.Role_ROLE_ADMIN}}}),
		"event_notice":           seq(6, &pb.Event{Body: &pb.Event_ServerNotice{ServerNotice: &pb.ServerNotice{Kind: pb.ServerNotice_KIND_RESTARTING, Text: "维护"}}}),
		"request_screen_share":   {Msg: &pb.Envelope_Request{Request: &pb.Request{Id: 10, Body: &pb.Request_RequestScreenShare{RequestScreenShare: &pb.RequestScreenShare{Intent: pb.ShareIntent_SHARE_INTENT_CLARITY, WithAudio: true}}}}},
		"response_share_grant": {Msg: &pb.Envelope_Response{Response: &pb.Response{Id: 10, Body: &pb.Response_RequestScreenShare{RequestScreenShare: &pb.ScreenShareGrant{
			GrantId: "g_abc", Limits: policy().Screen, RoomDecodable: []string{"video/h264", "video/vp8"}, CodecMode: pb.CodecMode_CODEC_MODE_AUTO, WithAudio: true,
		}}}}},
		"event_share_state": seq(8, &pb.Event{Body: &pb.Event_ShareStateChanged{ShareStateChanged: &pb.ShareStateChanged{RoomId: "main", Shares: []*pb.ShareInfo{
			{GrantId: "g_abc", SessionId: "s1", Intent: pb.ShareIntent_SHARE_INTENT_SMART, WithAudio: true, StartedAtMs: 1_760_000_000_000},
		}}}}),
		"ping": {Msg: &pb.Envelope_Ping{Ping: &pb.Ping{ClientTimeMs: 1}}},
		"pong": {Msg: &pb.Envelope_Pong{Pong: &pb.Pong{ClientTimeMs: 1, ServerTimeMs: 2}}},
		"goodbye_banned": {Msg: &pb.Envelope_Goodbye{Goodbye: &pb.Goodbye{Error: &pb.Error{
			Code: pb.ErrorCode_ERROR_CODE_BANNED, BanReason: "刷屏", BanExpiresAtMs: 1_760_003_600_000,
		}}}},
		"goodbye_restart": {Msg: &pb.Envelope_Goodbye{Goodbye: &pb.Goodbye{Error: &pb.Error{Code: pb.ErrorCode_ERROR_CODE_SERVER_SHUTTING_DOWN}, Reconnect: true}}},
		// 房间、主持、E2EE
		"request_create_room": {Msg: &pb.Envelope_Request{Request: &pb.Request{Id: 20, Body: &pb.Request_CreateRoom{CreateRoom: &pb.CreateRoom{
			Name: "设计评审", Password: "pw", Locked: true, Capacity: 8, EmptyTimeoutSec: ptr(uint32(0)), Join: true,
			Overrides: &pb.RoomOverrides{ScreenModeratorOnly: true, E2Ee: true, AudioMaxKbps: 24},
		}}}}},
		"event_room_updated": seq(9, &pb.Event{Body: &pb.Event_RoomUpdated{RoomUpdated: &pb.RoomUpdated{Room: &pb.Room{
			Id: "r_abc", Kind: pb.RoomKind_ROOM_KIND_TEMPORARY, Name: "设计评审", HasPassword: true, Capacity: 8, CreatedBy: "copdsqhgjnkjc4rardm2",
			CreatedAtMs: 1_760_000_000_000, Overrides: &pb.RoomOverrides{CameraModeratorOnly: true, E2Ee: true}, E2Ee: true, EmptyTimeoutSec: 300,
		}}}}),
		"event_you_were_moved": seq(10, &pb.Event{Body: &pb.Event_YouWereMoved{YouWereMoved: &pb.YouWereMoved{
			RoomId: "main", Reason: pb.MoveReason_MOVE_REASON_ROOM_CLOSED, ByName: "张三", FromRoomName: "设计评审",
			Joined: &pb.JoinRoomResult{RoomId: "main", Media: &pb.MediaGrant{Url: "wss://h:9800/rtc", Token: "jwt", ExpiresAtMs: 1_760_000_300_000}, Policy: policy()},
		}}}),
		"request_moderate": {Msg: &pb.Envelope_Request{Request: &pb.Request{Id: 21, Body: &pb.Request_Moderate{Moderate: &pb.Moderate{
			SessionId: "s2", Action: pb.ModerationAction_MODERATION_ACTION_BAN, DurationSec: 3600, Reason: "刷屏", BanIp: true,
		}}}}},
		"event_moderation_notice": seq(11, &pb.Event{Body: &pb.Event_ModerationNotice{ModerationNotice: &pb.ModerationNotice{
			Action: pb.ModerationAction_MODERATION_ACTION_FORCE_MUTE, ByName: "主持人", Reason: "请举手发言",
		}}}),
		"request_send_key_package": {Msg: &pb.Envelope_Request{Request: &pb.Request{Id: 22, Body: &pb.Request_SendKeyPackage{SendKeyPackage: &pb.SendKeyPackage{
			ToSessionId: "s3", RoomId: "r_abc", KeyIndex: 2, Enc: bytes.Repeat([]byte{0xab}, 32), Ciphertext: bytes.Repeat([]byte{0xcd}, 48),
		}}}}},
		"event_key_package": seq(12, &pb.Event{Body: &pb.Event_KeyPackage{KeyPackage: &pb.KeyPackage{
			FromSessionId: "s1", RoomId: "r_abc", KeyIndex: 2, Enc: bytes.Repeat([]byte{0xab}, 32), Ciphertext: bytes.Repeat([]byte{0xcd}, 48),
		}}}),
		"goodbye_kicked": {Msg: &pb.Envelope_Goodbye{Goodbye: &pb.Goodbye{Error: &pb.Error{Code: pb.ErrorCode_ERROR_CODE_KICKED, ByName: "管理员", Reason: "请注意言行"}}}},
	}
}

// stableJSON 输出规范 JSON。protojson 会刻意加入随机空白，这里重新排版，保证重新生成的文件稳定不变。
func stableJSON(m proto.Message) []byte {
	raw, err := protojson.Marshal(m)
	if err != nil {
		panic(err)
	}
	var buf bytes.Buffer
	if err := json.Indent(&buf, raw, "", "  "); err != nil {
		panic(err)
	}
	return buf.Bytes()
}

// withUnknownFields 在 Event 和 Participant 中追加未知字段，模拟新版本服务端发来的消息：旧客户端必须照常解码。
func withUnknownFields() []byte {
	ev := &pb.Envelope{Msg: &pb.Envelope_Event{Event: &pb.Event{Seq: 7, Body: &pb.Event_ParticipantUpdated{ParticipantUpdated: &pb.ParticipantUpdated{Participant: participant("z", "未来", pb.Role_ROLE_MEMBER)}}}}}
	p := ev.GetEvent().GetParticipantUpdated().GetParticipant()
	var extra []byte
	extra = protowire.AppendTag(extra, 999, protowire.BytesType)
	extra = protowire.AppendString(extra, "future field")
	p.ProtoReflect().SetUnknown(extra)
	var tail []byte
	tail = protowire.AppendTag(tail, 500, protowire.VarintType)
	tail = protowire.AppendVarint(tail, 12345)
	ev.GetEvent().ProtoReflect().SetUnknown(tail)
	b, _ := proto.MarshalOptions{Deterministic: true}.Marshal(ev)
	return b
}

func TestConformanceSamples(t *testing.T) {
	update := os.Getenv("HANE_UPDATE_CONFORMANCE") == "1"
	all := cases()
	names := make([]string, 0, len(all))
	for n := range all {
		names = append(names, n)
	}
	sort.Strings(names)

	for _, name := range names {
		env := all[name]
		bin, err := proto.MarshalOptions{Deterministic: true}.Marshal(env)
		if err != nil {
			t.Fatal(err)
		}
		js := stableJSON(env)
		if update {
			os.WriteFile(filepath.Join(dir, name+".bin"), bin, 0o644)
			os.WriteFile(filepath.Join(dir, name+".json"), append(js, '\n'), 0o644)
			continue
		}
		checkSample(t, name)
	}
	// 未知字段样例：JSON 中不含未知字段（旧版本看不到它们）
	if update {
		var known pb.Envelope
		proto.Unmarshal(withUnknownFields(), &known)
		known.GetEvent().GetParticipantUpdated().GetParticipant().ProtoReflect().SetUnknown(nil)
		known.GetEvent().ProtoReflect().SetUnknown(nil)
		js := stableJSON(&known)
		os.WriteFile(filepath.Join(dir, "unknown_fields.bin"), withUnknownFields(), 0o644)
		os.WriteFile(filepath.Join(dir, "unknown_fields.json"), append(js, '\n'), 0o644)
		names = append(names, "unknown_fields")
		idx, _ := json.MarshalIndent(names, "", "  ")
		os.WriteFile(filepath.Join(dir, "index.json"), append(idx, '\n'), 0o644)
		t.Logf("wrote %d samples", len(names))
		return
	}
	checkSample(t, "unknown_fields")
}

// checkSample：.bin 解码后与 .json 语义相同；重新编码后再解码仍然相同。
func checkSample(t *testing.T, name string) {
	t.Helper()
	bin, err := os.ReadFile(filepath.Join(dir, name+".bin"))
	if err != nil {
		t.Fatalf("%s: %v (run with HANE_UPDATE_CONFORMANCE=1 to generate)", name, err)
	}
	want, _ := os.ReadFile(filepath.Join(dir, name+".json"))
	var fromBin, fromJSON pb.Envelope
	if err := proto.Unmarshal(bin, &fromBin); err != nil {
		t.Fatalf("%s: decode: %v", name, err)
	}
	if err := protojson.Unmarshal(want, &fromJSON); err != nil {
		t.Fatalf("%s: json: %v", name, err)
	}
	fromBin.ProtoReflect().SetUnknown(nil)
	clearUnknown(&fromBin)
	if !proto.Equal(&fromBin, &fromJSON) {
		t.Fatalf("%s: binary and JSON samples differ", name)
	}
	re, _ := proto.Marshal(&fromJSON)
	var again pb.Envelope
	if err := proto.Unmarshal(re, &again); err != nil || !proto.Equal(&again, &fromJSON) {
		t.Fatalf("%s: re-encode mismatch", name)
	}
}

func clearUnknown(env *pb.Envelope) {
	if ev := env.GetEvent(); ev != nil {
		ev.ProtoReflect().SetUnknown(nil)
		if p := ev.GetParticipantUpdated().GetParticipant(); p != nil {
			p.ProtoReflect().SetUnknown(nil)
		}
	}
}
