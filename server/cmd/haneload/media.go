package main

import (
	"crypto/rand"
	"fmt"
	"net/url"
	"sync"
	"sync/atomic"
	"time"

	"github.com/livekit/protocol/livekit"
	protologger "github.com/livekit/protocol/logger"
	lksdk "github.com/livekit/server-sdk-go/v2"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"

	"github.com/karllee830/OpenHane/server/internal/client"
)

// 媒体压测：每个模拟客户端用握手时拿到的媒体令牌连上内嵌 SFU 并订阅其他人，
// 前 speakers 个客户端持续发送音频（每 20 ms 一个包，大小与 32 kbps Opus 相当；SFU 只转发、不解码）。
// 统计送达率（实际收到 / 应收到）、掉线次数，配合服务端内存和 CPU 的采样判断能否长时间稳定运行。

const audioPacketInterval = 20 * time.Millisecond

type mediaLoad struct {
	rooms    []*lksdk.Room
	received atomic.Int64 // 所有客户端收到的 RTP 包
	sent     atomic.Int64 // 所有发言者发出的包
	drops    atomic.Int64 // 媒体连接断开次数
	reconn   atomic.Int64
	speakers int
	stop     chan struct{}
	wg       sync.WaitGroup
}

// mediaURL：控制地址 ws(s)://host:port/ws → 媒体信令地址 ws(s)://host:port
func mediaURL(control string) (string, error) {
	u, err := url.Parse(control)
	if err != nil {
		return "", err
	}
	u.Path = ""
	return u.String(), nil
}

func startMedia(control string, clients []*client.Client, speakers int) (*mediaLoad, error) {
	base, err := mediaURL(control)
	if err != nil {
		return nil, err
	}
	lksdk.SetLogger(protologger.GetDiscardLogger()) // SDK 的日志太多，会淹没压测结果
	m := &mediaLoad{speakers: speakers, stop: make(chan struct{})}
	var mu sync.Mutex
	var firstErr error
	var wg sync.WaitGroup
	sem := make(chan struct{}, 20) // 同时建立的媒体连接数
	for i, c := range clients {
		if c == nil {
			continue
		}
		wg.Add(1)
		sem <- struct{}{}
		go func(i int, c *client.Client) {
			defer wg.Done()
			defer func() { <-sem }()
			room, err := m.connect(base, c, i < speakers)
			mu.Lock()
			defer mu.Unlock()
			if err != nil {
				if firstErr == nil {
					firstErr = fmt.Errorf("client %d: %w", i, err)
				}
				return
			}
			m.rooms = append(m.rooms, room)
		}(i, c)
	}
	wg.Wait()
	return m, firstErr
}

func (m *mediaLoad) connect(base string, c *client.Client, speak bool) (*lksdk.Room, error) {
	grant := c.Welcome.GetAutoJoin().GetMedia()
	if grant.GetToken() == "" {
		return nil, fmt.Errorf("no media token")
	}
	cb := lksdk.NewRoomCallback()
	cb.OnTrackSubscribed = func(track *webrtc.TrackRemote, _ *lksdk.RemoteTrackPublication, _ *lksdk.RemoteParticipant) {
		go func() {
			for {
				if _, _, err := track.ReadRTP(); err != nil {
					return
				}
				m.received.Add(1)
			}
		}()
	}
	cb.OnDisconnected = func() { m.drops.Add(1) }
	cb.OnReconnected = func() { m.reconn.Add(1) }
	room, err := lksdk.ConnectToRoomWithToken(base, grant.GetToken(), cb)
	if err != nil {
		return nil, err
	}
	if speak {
		track, err := lksdk.NewLocalSampleTrack(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2})
		if err != nil {
			return nil, err
		}
		if _, err := room.LocalParticipant.PublishTrack(track, &lksdk.TrackPublicationOptions{Name: "microphone", Source: livekit.TrackSource_MICROPHONE, DisableDTX: true}); err != nil {
			return nil, fmt.Errorf("publish: %w", err)
		}
		m.wg.Add(1)
		go func() {
			defer m.wg.Done()
			frame := make([]byte, 80) // 32 kbps × 20 ms
			_, _ = rand.Read(frame)
			frame[0] = 0xfc // TOC：CELT 全频带 20 ms（内容无所谓，SFU 不解码）
			t := time.NewTicker(audioPacketInterval)
			defer t.Stop()
			for {
				select {
				case <-m.stop:
					return
				case <-t.C:
					if track.WriteSample(media.Sample{Data: frame, Duration: audioPacketInterval}, nil) == nil {
						m.sent.Add(1)
					}
				}
			}
		}()
	}
	return room, nil
}

// expectedPerSecond：每个发言者的包应送到其余所有在线的客户端
func (m *mediaLoad) expectedPerSecond() float64 {
	n := len(m.rooms)
	return float64(m.speakers*(n-1)) * float64(time.Second/audioPacketInterval)
}

func (m *mediaLoad) close() {
	close(m.stop)
	m.wg.Wait()
	for _, r := range m.rooms {
		r.Disconnect()
	}
}
