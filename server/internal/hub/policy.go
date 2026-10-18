package hub

import (
	"github.com/karllee830/OpenHane/server/internal/pb"
	"github.com/karllee830/OpenHane/server/internal/perm"
	"github.com/karllee830/OpenHane/server/internal/settings"
)

var resolutions = map[string][2]uint32{
	"360p":   {640, 360},
	"540p":   {960, 540},
	"720p":   {1280, 720},
	"1080p":  {1920, 1080},
	"1440p":  {2560, 1440},
	"2160p":  {3840, 2160},
	"native": {0, 0}, // 0 表示不限制
}

// policyFor 计算会话在当前房间的有效媒体策略 = 服务器设置 ∩ 房间覆盖。
// 「仅主持人可共享 / 开摄像头」按会话在该房间的角色（含房间主持）计算，所以策略是按会话的。
func (h *Hub) policyFor(s *Session) *pb.MediaPolicy {
	st := h.Settings()
	p := buildPolicy(st)
	p.Codecs.RoomDecodable = h.roomDecodable(s.RoomID)
	p.Transport.TcpAvailable = h.media.TCPAvailable()
	room := h.rooms[s.RoomID]
	if room == nil {
		return p
	}
	o := room.Overrides
	moderator := h.roleIn(s, room) >= perm.Moderator
	if o.GetCameraModeratorOnly() && !moderator {
		p.Camera.Allowed = false
	}
	if o.GetScreenModeratorOnly() && !moderator {
		p.Screen.Allowed = false
	}
	if k := o.GetAudioMaxKbps(); k > 0 && k*1000 < p.Audio.MaxBitrateBps {
		p.Audio.MaxBitrateBps = k * 1000
	}
	p.E2Ee.RoomEnabled = room.e2ee(st)
	return p
}

// pushPolicy 把房间内每个成员的有效策略推送给本人（设置、房间覆盖或可解码集合变化后），客户端立刻重新应用。
func (h *Hub) pushPolicy(roomID string) {
	for _, s := range h.sessions {
		if s.RoomID == roomID && s.conn != nil {
			s.sendEvent(&pb.Event{Body: &pb.Event_PolicyUpdated{PolicyUpdated: &pb.PolicyUpdated{RoomId: roomID, Policy: h.policyFor(s)}}})
		}
	}
}

func buildPolicy(s *settings.Settings) *pb.MediaPolicy {
	cam := resolutions[s.CameraMaxResolution]
	scr := resolutions[s.ScreenMaxResolution]
	return &pb.MediaPolicy{
		Audio: &pb.AudioPolicy{
			Preset:           audioPreset(s.AudioPreset),
			MaxBitrateBps:    uint32(s.EffectiveAudioKbps()) * 1000,
			MusicModeAllowed: s.AudioAllowMusicMode,
			LowLatency:       s.AudioLowLatency,
			Red:              true,
			Dtx:              true,
			ForceMuteOnJoin:  s.JoinForceMute,
		},
		Camera: &pb.CameraPolicy{
			Allowed:   s.CameraEnabled,
			MaxWidth:  cam[0],
			MaxHeight: cam[1],
			MaxFps:    uint32(s.CameraMaxFps),
		},
		Screen: &pb.ScreenPolicy{
			Allowed:       s.ScreenEnabled,
			MaxWidth:      scr[0],
			MaxHeight:     scr[1],
			MaxFps:        uint32(s.ScreenMaxFps),
			MaxBitrateBps: uint32(s.ScreenMaxBitrateKbps) * 1000,
			AudioAllowed:  s.ScreenAllowAudio,
			MaxConcurrent: uint32(s.ScreenMaxConcurrent),
		},
		Codecs:    &pb.CodecPolicy{Mode: codecMode(s.VideoCodecPolicy)},
		E2Ee:      &pb.E2EEPolicy{Mode: e2eeMode(s.SecurityE2EEPolicy)},
		Transport: &pb.TransportPolicy{ShareTransport: shareTransport(s.MediaShareTransport)},
	}
}

func audioPreset(p string) pb.AudioPreset {
	switch p {
	case "economy":
		return pb.AudioPreset_AUDIO_PRESET_ECONOMY
	case "standard":
		return pb.AudioPreset_AUDIO_PRESET_STANDARD
	case "hd":
		return pb.AudioPreset_AUDIO_PRESET_HD
	case "music":
		return pb.AudioPreset_AUDIO_PRESET_MUSIC
	case "custom":
		return pb.AudioPreset_AUDIO_PRESET_CUSTOM
	}
	return pb.AudioPreset_AUDIO_PRESET_UNSPECIFIED
}

func shareTransport(v string) pb.ShareTransport {
	if v == "udp" {
		return pb.ShareTransport_SHARE_TRANSPORT_UDP
	}
	return pb.ShareTransport_SHARE_TRANSPORT_TCP
}

func codecMode(p string) pb.CodecMode {
	switch p {
	case "auto":
		return pb.CodecMode_CODEC_MODE_AUTO
	case "compat":
		return pb.CodecMode_CODEC_MODE_COMPAT
	}
	return pb.CodecMode_CODEC_MODE_UNSPECIFIED
}

func e2eeMode(p string) pb.E2EEMode {
	switch p {
	case "off":
		return pb.E2EEMode_E2EE_MODE_OFF
	case "optional":
		return pb.E2EEMode_E2EE_MODE_OPTIONAL
	case "required":
		return pb.E2EEMode_E2EE_MODE_REQUIRED
	}
	return pb.E2EEMode_E2EE_MODE_UNSPECIFIED
}
