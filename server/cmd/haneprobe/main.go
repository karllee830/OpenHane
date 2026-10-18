// haneprobe 是开发用的命令行探针：用参考客户端连接服务器，打印握手结果，可选兑换令牌、发送聊天。
//
//	go run ./cmd/haneprobe -url wss://localhost:9800/ws -nick probe [-token HANE-...] [-chat 你好] [-seed 01]
package main

import (
	"context"
	"encoding/hex"
	"flag"
	"fmt"
	"os"
	"time"

	"github.com/karllee830/OpenHane/server/internal/client"
	"github.com/karllee830/OpenHane/server/internal/pb"
	"github.com/karllee830/OpenHane/server/internal/tlsmgr"
)

func main() {
	url := flag.String("url", "wss://localhost:9800/ws", "控制协议地址")
	nick := flag.String("nick", "probe", "昵称")
	seedHex := flag.String("seed", "01", "主种子（十六进制，不足 32 字节右侧补零）")
	password := flag.String("password", "", "服务器密码")
	token := flag.String("token", "", "要兑换的权限令牌")
	chat := flag.String("chat", "", "要发送的聊天消息")
	flag.Parse()

	seed := make([]byte, 32)
	b, err := hex.DecodeString(*seedHex)
	if err != nil {
		fail(err)
	}
	copy(seed, b)

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	start := time.Now()
	c, err := client.Dial(ctx, client.Options{URL: *url, MasterSeed: seed, Nickname: *nick, Password: *password})
	if err != nil {
		fail(err)
	}
	defer c.Close()
	w := c.Welcome
	var spki [32]byte
	copy(spki[:], c.SPKI)
	fmt.Printf("connected in %v\n", time.Since(start).Round(time.Millisecond))
	fmt.Printf("server:      %s (%s)  fingerprint %s\n", w.GetSnapshot().GetInfo().GetName(), w.GetSnapshot().GetInfo().GetVersion(), tlsmgr.FormatFingerprint(spki))
	fmt.Printf("me:          %s  uid %s  role %s  session %s\n", w.GetNickname(), w.GetUid(), w.GetRole(), w.GetSessionId())
	fmt.Printf("room:        %s  media token %d bytes, expires %s\n", w.GetAutoJoin().GetRoomId(), len(w.GetAutoJoin().GetMedia().GetToken()),
		time.UnixMilli(w.GetAutoJoin().GetMedia().GetExpiresAtMs()).Format(time.TimeOnly))
	for _, p := range w.GetSnapshot().GetParticipants() {
		fmt.Printf("participant: %s (%s) %s\n", p.GetNickname(), p.GetRole(), p.GetPlatform())
	}
	if pong, err := c.Ping(ctx); err == nil {
		fmt.Printf("ping:        %d ms\n", time.Now().UnixMilli()-pong.GetClientTimeMs())
	}
	if *token != "" {
		resp, err := c.Request(ctx, &pb.Request{Body: &pb.Request_RedeemToken{RedeemToken: &pb.RedeemToken{Token: *token}}})
		if err != nil {
			fail(err)
		}
		fmt.Printf("redeemed:    role %s\n", resp.GetRedeemToken().GetRole())
	}
	if *chat != "" {
		if _, err := c.Request(ctx, &pb.Request{Body: &pb.Request_SendChat{SendChat: &pb.SendChat{RoomId: "main", Text: *chat}}}); err != nil {
			fail(err)
		}
		fmt.Println("chat sent")
	}
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "error:", err)
	os.Exit(1)
}
