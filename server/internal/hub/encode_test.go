package hub

import (
	"bytes"
	"testing"

	"google.golang.org/protobuf/proto"

	"github.com/karllee830/OpenHane/server/internal/pb"
)

func TestEventEncoderMatchesMarshal(t *testing.T) {
	events := []*pb.Event{
		{Body: &pb.Event_ParticipantUpdated{ParticipantUpdated: &pb.ParticipantUpdated{Participant: &pb.Participant{
			SessionId: "s_1", Uid: "u_abc", Nickname: "张三", RoomId: "main", PublicKey: bytes.Repeat([]byte{7}, 32),
			E2EeKey: &pb.SignedPublicKey{PublicKey: bytes.Repeat([]byte{1}, 32), Signature: bytes.Repeat([]byte{2}, 64)},
		}}}},
		{Body: &pb.Event_ChatMessage{ChatMessage: &pb.ChatMessage{Id: 42, RoomId: "r_x", Text: "你好"}}},
		{Body: &pb.Event_ParticipantLeft{ParticipantLeft: &pb.ParticipantLeft{SessionId: "s_2"}}},
	}
	for _, ev := range events {
		enc := newEventEncoder(ev)
		for _, seq := range []uint64{1, 127, 128, 300, 1 << 40} {
			want, err := proto.Marshal(&pb.Envelope{Msg: &pb.Envelope_Event{Event: &pb.Event{Seq: seq, Body: ev.Body}}})
			if err != nil {
				t.Fatal(err)
			}
			got := enc.envelope(seq)
			if !bytes.Equal(got, want) {
				t.Fatalf("seq %d: bytes differ\n got %x\nwant %x", seq, got, want)
			}
			var env pb.Envelope
			if err := proto.Unmarshal(got, &env); err != nil || env.GetEvent().GetSeq() != seq || !proto.Equal(env.GetEvent().ProtoReflect().Interface(), (&pb.Event{Seq: seq, Body: ev.Body}).ProtoReflect().Interface()) {
				t.Fatalf("seq %d: round trip failed: %v", seq, err)
			}
		}
	}
}

func BenchmarkBroadcastEncode(b *testing.B) {
	ev := &pb.Event{Body: &pb.Event_ParticipantUpdated{ParticipantUpdated: &pb.ParticipantUpdated{Participant: &pb.Participant{
		SessionId: "s_1", Uid: "u_abc", Nickname: "张三", RoomId: "main", PublicKey: bytes.Repeat([]byte{7}, 32),
		E2EeKey: &pb.SignedPublicKey{PublicKey: bytes.Repeat([]byte{1}, 32), Signature: bytes.Repeat([]byte{2}, 64)},
	}}}}
	b.Run("marshal-each", func(b *testing.B) {
		for i := range b.N {
			_, _ = proto.Marshal(&pb.Envelope{Msg: &pb.Envelope_Event{Event: &pb.Event{Seq: uint64(i), Body: ev.Body}}})
		}
	})
	b.Run("encode-once", func(b *testing.B) {
		enc := newEventEncoder(ev)
		for i := range b.N {
			_ = enc.envelope(uint64(i))
		}
	})
}
