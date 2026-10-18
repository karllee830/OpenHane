package hub

import (
	"google.golang.org/protobuf/encoding/protowire"
	"google.golang.org/protobuf/proto"

	"github.com/karllee830/OpenHane/server/internal/pb"
)

// 广播事件的编码：事件内容（Event 中除 seq 以外的部分）只序列化一次，每个接收者在前面拼上自己的 seq 和 Envelope 的字段头。
// protobuf 的线格式允许字段以任意顺序出现，拼接结果与逐个 proto.Marshal 的消息等价（encode_test.go 验证）。
var (
	envelopeEventField = (&pb.Envelope{}).ProtoReflect().Descriptor().Fields().ByName("event").Number()
	eventSeqField      = (&pb.Event{}).ProtoReflect().Descriptor().Fields().ByName("seq").Number()
)

type eventEncoder struct {
	body []byte // Event{Body: …} 的序列化结果（seq 为 0，不出现在线格式中）
}

func newEventEncoder(ev *pb.Event) *eventEncoder {
	body, err := proto.Marshal(&pb.Event{Body: ev.Body})
	if err != nil {
		return nil
	}
	return &eventEncoder{body: body}
}

// envelope 返回带指定 seq 的完整 Envelope 字节
func (e *eventEncoder) envelope(seq uint64) []byte {
	seqLen := protowire.SizeTag(eventSeqField) + protowire.SizeVarint(seq)
	eventLen := seqLen + len(e.body)
	b := make([]byte, 0, protowire.SizeTag(envelopeEventField)+protowire.SizeVarint(uint64(eventLen))+eventLen)
	b = protowire.AppendTag(b, envelopeEventField, protowire.BytesType)
	b = protowire.AppendVarint(b, uint64(eventLen))
	b = protowire.AppendTag(b, eventSeqField, protowire.VarintType)
	b = protowire.AppendVarint(b, seq)
	return append(b, e.body...)
}
