// Package settings 定义服务器设置（管理面板中可修改的运营类配置），各项说明见管理员手册（https://github.com/karllee830/OpenHane/wiki/Admin-Guide）第 10 节。
//
// 存储格式：settings 表中的「键 → JSON 值」，只保存改过的键；其余取默认值。
// 设置是不可变快照：修改时生成新的 *Settings，旧快照仍可安全读取。
package settings

import (
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"slices"
	"sort"
	"strings"

	"github.com/karllee830/OpenHane/server/internal/identity"
)

type Settings struct {
	ServerName     string `json:"server.name"`
	WelcomeMessage string `json:"server.welcome_message"`
	// ServerPassword 保存 Argon2id 哈希（PHC 格式）；为空表示不需要密码。
	ServerPassword string `json:"server.password"`
	MaxClients     int    `json:"server.max_clients"`

	JoinForceMute bool `json:"join.force_mute"`

	MinSecurityLevel int `json:"identity.min_security_level"`

	AudioPreset         string `json:"audio.preset"`
	AudioMaxBitrateKbps int    `json:"audio.max_bitrate_kbps"`
	AudioAllowMusicMode bool   `json:"audio.allow_music_mode"`
	AudioLowLatency     bool   `json:"audio.low_latency"`

	CameraEnabled       bool   `json:"camera.enabled"`
	CameraMaxResolution string `json:"camera.max_resolution"`
	CameraMaxFps        int    `json:"camera.max_fps"`

	ScreenEnabled        bool   `json:"screen.enabled"`
	ScreenMinRole        string `json:"screen.min_role"`
	ScreenMaxResolution  string `json:"screen.max_resolution"`
	ScreenMaxFps         int    `json:"screen.max_fps"`
	ScreenMaxBitrateKbps int    `json:"screen.max_bitrate_kbps"`
	ScreenMaxConcurrent  int    `json:"screen.max_concurrent"`
	ScreenAllowAudio     bool   `json:"screen.allow_audio"`

	// 屏幕共享编码器：auto（按设备硬件自动选）/ compat（只用 H.264，排查硬件编码器问题时用；管理面板不显示，用命令行设置）
	VideoCodecPolicy string `json:"video.codec_policy"`

	// 屏幕共享连接的传输方式：tcp（TCP 优先，TCP 不通时用 UDP）/ udp（UDP 优先，UDP 不稳定时自动改走 TCP）。语音和摄像头始终走 UDP
	MediaShareTransport string `json:"media.share_transport"`

	SecurityE2EEPolicy string `json:"security.e2ee_policy"`

	RoomsCreateMinRole string `json:"rooms.create_min_role"`
	RoomsMaxTemporary  int    `json:"rooms.max_temporary"`
	RoomsEmptyTimeout  int    `json:"rooms.empty_timeout_sec"`
	RoomsMainName      string `json:"rooms.main_name"`
	ChatRetentionDays  int    `json:"chat.retention_days"`
	ChatMaxLength      int    `json:"chat.max_length"`
	// 聊天图片：单张大小上限（0 表示不允许发送图片）和所有图片占用空间的上限
	ChatImageMaxMB      int  `json:"chat.image_max_mb"`
	ChatImageStorageMB  int  `json:"chat.image_storage_mb"`
	AuditRetentionDays  int  `json:"audit.retention_days"`
	PrivacyStoreIP      bool `json:"privacy.store_ip"`
	BandwidthBudgetMbps int  `json:"bandwidth.egress_budget_mbps"`
}

// MaxServerNameRunes 是服务器名称的长度上限（客户端的服务器列表和会议侧栏里显示）。
const MaxServerNameRunes = 32

// defaultServerName 是管理员没有设置名称时用的名称：HANE_SERVER_NAME，没有设置环境变量时是「OpenHane」。
// 管理员在管理面板里设置的名称优先；恢复默认就回到这里。只在启动时由 SetDefaultServerName 设置一次
var defaultServerName = "OpenHane"

// SetDefaultServerName 设置管理员没有设置名称时用的名称（HANE_SERVER_NAME），按服务器名称的规则检查。
func SetDefaultServerName(name string) error {
	n, ok := identity.NormalizeDisplayName(name, MaxServerNameRunes)
	if !ok {
		return errServerName
	}
	defaultServerName = n
	return nil
}

var errServerName = fmt.Errorf("server.name: must be 1–%d characters without control or invisible characters", MaxServerNameRunes)

func Defaults() *Settings {
	return &Settings{
		ServerName:           defaultServerName,
		MaxClients:           100,
		AudioPreset:          "standard",
		AudioMaxBitrateKbps:  32,
		AudioAllowMusicMode:  true,
		CameraEnabled:        true,
		CameraMaxResolution:  "720p",
		CameraMaxFps:         30,
		ScreenEnabled:        true,
		ScreenMinRole:        "member",
		ScreenMaxResolution:  "1440p",
		ScreenMaxFps:         60,
		ScreenMaxBitrateKbps: 8000,
		ScreenMaxConcurrent:  2,
		ScreenAllowAudio:     true,
		VideoCodecPolicy:     "auto",
		MediaShareTransport:  "tcp",
		SecurityE2EEPolicy:   "optional",
		RoomsCreateMinRole:   "moderator",
		RoomsMaxTemporary:    20,
		RoomsEmptyTimeout:    300,
		RoomsMainName:        "主会议",
		ChatRetentionDays:    7,
		ChatMaxLength:        2000,
		ChatImageMaxMB:       10,
		ChatImageStorageMB:   2048,
		AuditRetentionDays:   90,
		PrivacyStoreIP:       true,
	}
}

// AudioPresetBitrate 是各语音预设对应的码率（kbps）；custom 使用 audio.max_bitrate_kbps。
var AudioPresetBitrate = map[string]int{"economy": 16, "standard": 32, "hd": 64, "music": 128}

// PasswordKey 是唯一的密码类设置：写入时哈希，读取时脱敏。
const PasswordKey = "server.password"

// MaskedPassword 是读取已设置密码时返回的值。
const MaskedPassword = `"********"`

var fieldIndex = func() map[string]int {
	m := map[string]int{}
	t := reflect.TypeOf(Settings{})
	for i := range t.NumField() {
		m[t.Field(i).Tag.Get("json")] = i
	}
	return m
}()

// Keys 返回所有设置键（排序后）。
func Keys() []string {
	keys := make([]string, 0, len(fieldIndex))
	for k := range fieldIndex {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// FromStored 由数据库中保存的键值构造设置。未知键（旧版本遗留）忽略；无法解析的值回退默认并返回错误说明。
func FromStored(stored map[string]string) (*Settings, error) {
	s := Defaults()
	var errs []error
	for k, raw := range stored {
		if err := s.set(k, raw); err != nil && !errors.Is(err, errUnknownKey) {
			errs = append(errs, err)
		}
	}
	if s.VideoCodecPolicy == "quality" { // 旧版本的「画质优先」（允许软件 AV1 / VP9）已取消
		s.VideoCodecPolicy = "auto"
	}
	if err := s.Validate(); err != nil {
		return Defaults(), errors.Join(append(errs, err)...)
	}
	return s, errors.Join(errs...)
}

var errUnknownKey = errors.New("unknown setting")

func (s *Settings) set(key, raw string) error {
	i, ok := fieldIndex[key]
	if !ok {
		return fmt.Errorf("%w %q", errUnknownKey, key)
	}
	f := reflect.ValueOf(s).Elem().Field(i)
	if raw == "null" {
		f.Set(reflect.ValueOf(Defaults()).Elem().Field(i))
		return nil
	}
	dec := json.NewDecoder(strings.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(f.Addr().Interface()); err != nil {
		return fmt.Errorf("%s: invalid value %s: %w", key, raw, err)
	}
	return nil
}

// Get 返回某个键的 JSON 值；密码只返回是否已设置。
func (s *Settings) Get(key string) (string, bool) {
	i, ok := fieldIndex[key]
	if !ok {
		return "", false
	}
	if key == PasswordKey {
		if s.ServerPassword == "" {
			return "null", true
		}
		return MaskedPassword, true
	}
	b, _ := json.Marshal(reflect.ValueOf(s).Elem().Field(i).Interface())
	return string(b), true
}

// Public 返回所有设置（密码脱敏），用于管理面板和 CLI。
func (s *Settings) Public() map[string]string {
	out := make(map[string]string, len(fieldIndex))
	for k := range fieldIndex {
		out[k], _ = s.Get(k)
	}
	return out
}

// Patch 是一次修改：键 → JSON 值，"null" 表示恢复默认。
type Patch map[string]string

// Apply 返回应用修改后的新快照，以及需要写入数据库的键值（值为空字符串表示删除该键）。
// hashPassword 用于把明文密码转成哈希（便于测试注入）。
func (s *Settings) Apply(p Patch, hashPassword func(string) (string, error)) (*Settings, map[string]string, error) {
	next := *s
	stored := map[string]string{}
	for k, raw := range p {
		raw = strings.TrimSpace(raw)
		if k == PasswordKey && raw != "null" {
			var plain string
			if err := json.Unmarshal([]byte(raw), &plain); err != nil {
				return nil, nil, fmt.Errorf("%s: must be a JSON string or null", k)
			}
			if plain == "" {
				raw = "null"
			} else {
				hash, err := hashPassword(plain)
				if err != nil {
					return nil, nil, err
				}
				b, _ := json.Marshal(hash)
				raw = string(b)
			}
		}
		if err := next.set(k, raw); err != nil {
			return nil, nil, err
		}
		if k == "server.name" && raw != "null" {
			n, ok := identity.NormalizeDisplayName(next.ServerName, MaxServerNameRunes)
			if !ok {
				return nil, nil, errServerName
			}
			next.ServerName = n
		}
		if raw == "null" {
			stored[k] = ""
		} else {
			// 规范化存储格式
			v, _ := json.Marshal(reflect.ValueOf(&next).Elem().Field(fieldIndex[k]).Interface())
			stored[k] = string(v)
		}
	}
	if err := next.Validate(); err != nil {
		return nil, nil, err
	}
	return &next, stored, nil
}

func oneOf(key, v string, allowed ...string) error {
	if slices.Contains(allowed, v) {
		return nil
	}
	return fmt.Errorf("%s: %q is not one of %s", key, v, strings.Join(allowed, " / "))
}

func between(key string, v, min, max int) error {
	if v < min || v > max {
		return fmt.Errorf("%s: %d is out of range %d–%d", key, v, min, max)
	}
	return nil
}

func (s *Settings) Validate() error {
	roles := []string{"member", "moderator", "admin"}
	return errors.Join(
		func() error {
			if _, ok := identity.NormalizeDisplayName(s.ServerName, MaxServerNameRunes); !ok {
				return errServerName
			}
			return nil
		}(),
		func() error {
			if len([]rune(s.WelcomeMessage)) > 2000 {
				return errors.New("server.welcome_message: at most 2000 characters")
			}
			return nil
		}(),
		between("server.max_clients", s.MaxClients, 1, 10000),
		between("identity.min_security_level", s.MinSecurityLevel, 0, 32),
		oneOf("audio.preset", s.AudioPreset, "economy", "standard", "hd", "music", "custom"),
		between("audio.max_bitrate_kbps", s.AudioMaxBitrateKbps, 8, 510),
		oneOf("camera.max_resolution", s.CameraMaxResolution, "360p", "540p", "720p", "1080p"),
		between("camera.max_fps", s.CameraMaxFps, 5, 60),
		oneOf("screen.min_role", s.ScreenMinRole, roles...),
		oneOf("screen.max_resolution", s.ScreenMaxResolution, "1080p", "1440p", "2160p", "native"),
		between("screen.max_fps", s.ScreenMaxFps, 5, 120),
		between("screen.max_bitrate_kbps", s.ScreenMaxBitrateKbps, 300, 50000),
		between("screen.max_concurrent", s.ScreenMaxConcurrent, 1, 16),
		oneOf("video.codec_policy", s.VideoCodecPolicy, "auto", "compat"),
		oneOf("media.share_transport", s.MediaShareTransport, "tcp", "udp"),
		oneOf("security.e2ee_policy", s.SecurityE2EEPolicy, "off", "optional", "required"),
		oneOf("rooms.create_min_role", s.RoomsCreateMinRole, roles...),
		between("rooms.max_temporary", s.RoomsMaxTemporary, 0, 200),
		between("rooms.empty_timeout_sec", s.RoomsEmptyTimeout, 0, 86400),
		func() error {
			if n := len([]rune(strings.TrimSpace(s.RoomsMainName))); n == 0 || n > 64 {
				return errors.New("rooms.main_name: must be 1–64 characters")
			}
			return nil
		}(),
		between("chat.retention_days", s.ChatRetentionDays, 0, 36500),
		between("chat.max_length", s.ChatMaxLength, 1, 10000),
		between("chat.image_max_mb", s.ChatImageMaxMB, 0, 50),
		between("chat.image_storage_mb", s.ChatImageStorageMB, 100, 1<<20),
		between("audit.retention_days", s.AuditRetentionDays, 1, 36500),
		between("bandwidth.egress_budget_mbps", s.BandwidthBudgetMbps, 0, 100000),
	)
}

// EffectiveAudioKbps 返回语音码率上限。
func (s *Settings) EffectiveAudioKbps() int {
	if kbps, ok := AudioPresetBitrate[s.AudioPreset]; ok {
		return kbps
	}
	return s.AudioMaxBitrateKbps
}
