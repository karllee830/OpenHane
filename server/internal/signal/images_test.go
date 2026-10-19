package signal_test

import (
	"bytes"
	"crypto/tls"
	"encoding/binary"
	"encoding/json"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"io"
	"net/http"
	"testing"
	"time"

	"github.com/karllee830/OpenHane/server/internal/client"
	"github.com/karllee830/OpenHane/server/internal/pb"
)

func testPNG(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for x := range w {
		img.SetNRGBA(x, 0, color.NRGBA{255, 0, 0, 255})
	}
	var b bytes.Buffer
	if err := png.Encode(&b, img); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

// rotatedJPEG 是 w×h 的 JPEG，EXIF 里写着方向 6（显示时要顺时针转 90°）
func rotatedJPEG(t *testing.T, w, h int) []byte {
	t.Helper()
	var b bytes.Buffer
	if err := jpeg.Encode(&b, image.NewRGBA(image.Rect(0, 0, w, h)), nil); err != nil {
		t.Fatal(err)
	}
	tiff := make([]byte, 26)
	copy(tiff, "MM")
	binary.BigEndian.PutUint16(tiff[2:], 42)
	binary.BigEndian.PutUint32(tiff[4:], 8)
	binary.BigEndian.PutUint16(tiff[8:], 1)
	binary.BigEndian.PutUint16(tiff[10:], 0x0112)
	binary.BigEndian.PutUint16(tiff[12:], 3)
	binary.BigEndian.PutUint32(tiff[14:], 1)
	binary.BigEndian.PutUint16(tiff[18:], 6)
	seg := append([]byte("Exif\x00\x00"), tiff...)
	app1 := []byte{0xFF, 0xE1, 0, 0}
	binary.BigEndian.PutUint16(app1[2:], uint16(len(seg)+2))
	out := append([]byte{0xFF, 0xD8}, app1...)
	out = append(out, seg...)
	return append(out, b.Bytes()[2:]...)
}

func (e *env) http() *http.Client {
	return &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}}
}

func (e *env) upload(token, room string, body []byte) (int, map[string]any) {
	e.t.Helper()
	req, _ := http.NewRequest("POST", e.base+"/api/v1/chat/images?room="+room, bytes.NewReader(body))
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := e.http().Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	defer resp.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

func (e *env) download(token, path string) (int, []byte) {
	e.t.Helper()
	req, _ := http.NewRequest("GET", e.base+"/api/v1/chat/images/"+path, nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := e.http().Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, b
}

func sendImage(t *testing.T, c *client.Client, id, text string) (*pb.Response, error) {
	return c.Request(ctx(t), &pb.Request{Body: &pb.Request_SendChat{SendChat: &pb.SendChat{RoomId: "main", Text: text, ImageId: id}}})
}

func TestChatImages(t *testing.T) {
	e := setup(t)
	a := e.mustDial(1, "Alice")
	b := e.mustDial(2, "Bob")
	ta, tb := a.Welcome.GetApiToken(), b.Welcome.GetApiToken()
	if len(ta) < 40 || ta == tb {
		t.Fatalf("api tokens: %q %q", ta, tb)
	}
	if got := a.Welcome.GetSnapshot().GetInfo().GetChatImageMaxBytes(); got != 10<<20 {
		t.Fatalf("chat_image_max_bytes = %d", got)
	}

	// 没有凭据、不在这个房间、不是图片
	if code, _ := e.upload("", "main", testPNG(t, 10, 10)); code != http.StatusUnauthorized {
		t.Fatalf("no token: %d", code)
	}
	if code, _ := e.upload(ta, "r_other", testPNG(t, 10, 10)); code != http.StatusForbidden {
		t.Fatalf("other room: %d", code)
	}
	if code, _ := e.upload(ta, "main", []byte("<svg xmlns='http://www.w3.org/2000/svg'/>")); code != http.StatusUnsupportedMediaType {
		t.Fatalf("svg: %d", code)
	}

	// 超过 4096 的缩小；带 EXIF 方向的 JPEG 转正
	code, up := e.upload(ta, "main", testPNG(t, 5000, 100))
	if code != http.StatusOK || up["width"] != 4096.0 || up["height"] != 82.0 {
		t.Fatalf("png upload: %d %v", code, up)
	}
	id := up["id"].(string)
	if code, j := e.upload(ta, "main", rotatedJPEG(t, 40, 20)); code != http.StatusOK || j["width"] != 20.0 || j["height"] != 40.0 {
		t.Fatalf("jpeg upload: %d %v", code, j)
	}

	// 别人不能发我上传的图片
	if _, err := sendImage(t, b, id, ""); client.Code(err) != pb.ErrorCode_ERROR_CODE_INVALID_ARGUMENT {
		t.Fatal("someone else's image should be rejected", err)
	}
	resp, err := sendImage(t, a, id, "")
	if err != nil || resp.GetSendChat().GetMessage().GetImage().GetWidth() != 4096 {
		t.Fatal(resp, err)
	}
	ev, err := b.WaitEvent(ctx(t), func(ev *pb.Event) bool { return ev.GetChatMessage().GetImage() != nil })
	if err != nil || ev.GetChatMessage().GetImage().GetId() != id {
		t.Fatal(ev, err)
	}
	if _, err := sendImage(t, a, id, "again"); client.Code(err) != pb.ErrorCode_ERROR_CODE_INVALID_ARGUMENT {
		t.Fatal("an image can only be sent once", err)
	}
	hist, err := b.Request(ctx(t), &pb.Request{Body: &pb.Request_GetChatHistory{GetChatHistory: &pb.GetChatHistory{RoomId: "main"}}})
	if err != nil || hist.GetGetChatHistory().GetMessages()[0].GetImage().GetHeight() != 82 {
		t.Fatal("history should include the image", hist, err)
	}

	// 同房间的人凭自己的凭据读取；没有凭据、路径不对的都读不到
	code, data := e.download(tb, "main/"+id)
	if code != http.StatusOK {
		t.Fatalf("download: %d", code)
	}
	if cfg, err := png.DecodeConfig(bytes.NewReader(data)); err != nil || cfg.Width != 4096 {
		t.Fatal("downloaded image", cfg, err)
	}
	for path, want := range map[string]int{
		"main/" + id:          http.StatusForbidden, // 没有凭据
		"main/../../etc":      http.StatusNotFound,
		"main/" + id[:10]:     http.StatusNotFound,
		"r_other/" + id:       http.StatusForbidden,
		"main/" + id + "x":    http.StatusNotFound,
		"main/" + id + "/..":  http.StatusNotFound,
		"main%2F..%2F" + id:   http.StatusNotFound,
		"main/" + id + ".tmp": http.StatusNotFound,
	} {
		token := tb
		if path == "main/"+id {
			token = ""
		}
		if code, _ := e.download(token, path); code != want && !(want == http.StatusNotFound && code >= 400) {
			t.Errorf("%s: %d, want %d", path, code, want)
		}
	}

	// 清理聊天记录时返回附带的图片
	n, images, err := e.store.PurgeChat(ctx(t), time.Now().Add(time.Hour).UnixMilli())
	if err != nil || n != 1 || len(images) != 1 || images[0].ID != id {
		t.Fatal("purge", n, images, err)
	}

	// 上传了还没发的图片，会话离开时删掉
	code, up = e.upload(tb, "main", testPNG(t, 20, 20))
	if code != http.StatusOK {
		t.Fatalf("bob upload: %d", code)
	}
	if f, _, err := e.images.Open("main", up["id"].(string)); err != nil {
		t.Fatal("pending image should exist", err)
	} else {
		f.Close()
	}
	b.Close()
	deadline := time.Now().Add(3 * time.Second)
	for {
		f, _, err := e.images.Open("main", up["id"].(string))
		if err != nil {
			break
		}
		f.Close()
		if time.Now().After(deadline) {
			t.Fatal("pending image should be removed when the session leaves")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if code, _ := e.upload(tb, "main", testPNG(t, 10, 10)); code != http.StatusUnauthorized {
		t.Fatalf("token of a closed session: %d", code)
	}
}

func TestChatImageRateLimit(t *testing.T) {
	e := setup(t)
	a := e.mustDial(1, "Alice")
	limited := false
	for range 8 {
		code, _ := e.upload(a.Welcome.GetApiToken(), "main", testPNG(t, 10, 10))
		if code == http.StatusTooManyRequests {
			limited = true
			break
		}
	}
	if !limited {
		t.Fatal("uploads should be limited (pending images and rate)")
	}
}
