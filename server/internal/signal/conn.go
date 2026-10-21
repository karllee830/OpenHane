// Package signal 管理控制协议的 WebSocket 连接：帧编解码、发送队列与背压、心跳超时，以及握手鉴权流程。
package signal

import (
	"encoding/binary"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
	"google.golang.org/protobuf/proto"

	"github.com/karllee830/OpenHane/server/internal/pb"
)

const (
	Subprotocol   = "hane.v1"
	MaxFrameBytes = 64 << 10 // 单帧大小上限
	sendQueueLen  = 256      // 发送队列满即判定为慢消费者并断开
	writeTimeout  = 10 * time.Second
	// IdleTimeout：45 秒内没收到任何数据即判定断线（客户端每 15 秒发一次 Ping）。
	IdleTimeout = 45 * time.Second
	// rttInterval：服务端发 WebSocket 协议层 ping 测往返延迟的间隔（浏览器和系统库都会自动回 pong）
	rttInterval = 10 * time.Second
)

// Conn 是一个控制连接。Send / Close 并发安全且不阻塞。
type Conn struct {
	ws  *websocket.Conn
	log *slog.Logger

	out     chan []byte
	closing chan struct{}
	done    chan struct{} // 写协程退出后关闭

	closeOnce sync.Once
	closed    atomic.Bool
	goodbye   []byte // Close 时要发送的 Goodbye 帧

	rtt atomic.Int64 // 最近一次测得的往返延迟（纳秒），0 表示还没测到
}

func newConn(ws *websocket.Conn, log *slog.Logger) *Conn {
	ws.SetReadLimit(MaxFrameBytes)
	c := &Conn{ws: ws, log: log, out: make(chan []byte, sendQueueLen), closing: make(chan struct{}), done: make(chan struct{})}
	ws.SetPongHandler(func(data string) error {
		if len(data) == 8 {
			sent := time.Unix(0, int64(binary.BigEndian.Uint64([]byte(data))))
			if d := time.Since(sent); d > 0 && d < time.Minute {
				c.rtt.Store(int64(d))
			}
		}
		return nil
	})
	go c.writeLoop()
	go c.pingLoop()
	return c
}

// RTT 返回最近一次测得的往返延迟，0 表示还没测到。
func (c *Conn) RTT() time.Duration { return time.Duration(c.rtt.Load()) }

// pingLoop 定时发送带发送时间的 ping 帧，收到 pong 时由 SetPongHandler 计算往返延迟
func (c *Conn) pingLoop() {
	t := time.NewTicker(rttInterval)
	defer t.Stop()
	for {
		var b [8]byte
		binary.BigEndian.PutUint64(b[:], uint64(time.Now().UnixNano()))
		// WriteControl 可以和 writeLoop 的 WriteMessage 并发调用
		if c.ws.WriteControl(websocket.PingMessage, b[:], time.Now().Add(writeTimeout)) != nil {
			return
		}
		select {
		case <-t.C:
		case <-c.closing:
			return
		}
	}
}

// Send 序列化并放入发送队列（在调用方协程中序列化，消息可以共享子对象）。
func (c *Conn) Send(env *pb.Envelope) {
	if c.closed.Load() {
		return
	}
	b, err := proto.Marshal(env)
	if err != nil {
		c.log.Error("marshal envelope failed", "err", err)
		return
	}
	c.SendRaw(b)
}

// SendRaw 发送已经序列化好的 Envelope。
func (c *Conn) SendRaw(b []byte) {
	if c.closed.Load() {
		return
	}
	select {
	case c.out <- b:
	default:
		c.log.Warn("send queue full, disconnecting slow consumer")
		c.Close(&pb.Error{Code: pb.ErrorCode_ERROR_CODE_SLOW_CONSUMER}, true)
	}
}

// Close 发送 Goodbye（e 不为 nil 时）后关闭连接。已排队的消息会先发完。
func (c *Conn) Close(e *pb.Error, reconnect bool) {
	c.closeOnce.Do(func() {
		if e != nil {
			c.goodbye, _ = proto.Marshal(&pb.Envelope{Msg: &pb.Envelope_Goodbye{Goodbye: &pb.Goodbye{Error: e, Reconnect: reconnect}}})
		}
		c.closed.Store(true)
		close(c.closing)
	})
}

// Done 在连接彻底关闭后关闭。
func (c *Conn) Done() <-chan struct{} { return c.done }

func (c *Conn) write(b []byte) error {
	c.ws.SetWriteDeadline(time.Now().Add(writeTimeout))
	return c.ws.WriteMessage(websocket.BinaryMessage, b)
}

func (c *Conn) writeLoop() {
	defer close(c.done)
	defer c.ws.Close()
	for {
		select {
		case b := <-c.out:
			if err := c.write(b); err != nil {
				c.closeOnce.Do(func() { c.closed.Store(true); close(c.closing) })
				return
			}
		case <-c.closing:
			// 先把已排队的消息发完（例如 ServerNotice），再发 Goodbye 和关闭帧
			for {
				select {
				case b := <-c.out:
					if c.write(b) != nil {
						return
					}
					continue
				default:
				}
				break
			}
			if c.goodbye != nil {
				c.write(c.goodbye)
			}
			c.ws.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""), time.Now().Add(time.Second))
			return
		}
	}
}

// Read 读取下一帧并解码。超过 IdleTimeout 没有数据时返回错误。
func (c *Conn) Read(timeout time.Duration) (*pb.Envelope, error) {
	c.ws.SetReadDeadline(time.Now().Add(timeout))
	for {
		typ, b, err := c.ws.ReadMessage()
		if err != nil {
			return nil, err
		}
		if typ != websocket.BinaryMessage {
			continue // 忽略文本帧
		}
		env := &pb.Envelope{}
		if err := proto.Unmarshal(b, env); err != nil {
			return nil, err
		}
		return env, nil
	}
}
