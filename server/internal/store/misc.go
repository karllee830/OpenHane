package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/netip"
	"strings"
)

// ---------- settings ----------

// LoadSettings 返回所有已修改过的设置（键 → JSON 值）；未出现的键使用默认值。
func (s *Store) LoadSettings(ctx context.Context) (map[string]string, error) {
	rows, err := s.r.QueryContext(ctx, "SELECT key, value FROM settings")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err != nil {
			return nil, err
		}
		out[k] = v
	}
	return out, rows.Err()
}

// PutSettings 在一个事务中写入一组设置；值为空字符串表示删除（恢复默认）。
func (s *Store) PutSettings(ctx context.Context, values map[string]string, by string) error {
	tx, err := s.w.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	now := s.nowMs()
	for k, v := range values {
		if v == "" {
			_, err = tx.ExecContext(ctx, "DELETE FROM settings WHERE key = ?", k)
		} else {
			_, err = tx.ExecContext(ctx, `INSERT INTO settings(key, value, updated_at, updated_by) VALUES(?, ?, ?, ?)
				ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
				k, v, now, nullStr(by))
		}
		if err != nil {
			return err
		}
	}
	return tx.Commit()
}

// ---------- chat ----------

type ChatMessage struct {
	ID         int64
	RoomID     string
	SenderUID  string
	SenderName string
	Body       string
	ReplyTo    int64
	CreatedAt  int64
	// 附带的图片（没有时 ImageID 为空）
	ImageID     string
	ImageWidth  int64
	ImageHeight int64
	ImageSize   int64
}

// InsertChat 写入一条聊天消息。m.ID 不为 0 时使用调用方分配的 ID（控制面统一分配，保证与广播顺序一致）。
func (s *Store) InsertChat(ctx context.Context, m *ChatMessage) error {
	if m.CreatedAt == 0 {
		m.CreatedAt = s.nowMs()
	}
	return s.w.QueryRowContext(ctx, `INSERT INTO chat_messages(id, room_id, sender_uid, sender_name, body, reply_to, created_at,
		image_id, image_width, image_height, image_size)
		VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
		nullInt(m.ID), m.RoomID, nullStr(m.SenderUID), m.SenderName, m.Body, nullInt(m.ReplyTo), m.CreatedAt,
		nullStr(m.ImageID), nullInt(m.ImageWidth), nullInt(m.ImageHeight), nullInt(m.ImageSize)).Scan(&m.ID)
}

// MaxChatID 返回已有聊天消息的最大 ID（没有消息时为 0）。
func (s *Store) MaxChatID(ctx context.Context) (int64, error) {
	var id int64
	err := s.r.QueryRowContext(ctx, "SELECT coalesce(max(id), 0) FROM chat_messages").Scan(&id)
	return id, err
}

// ChatHistory 返回 beforeID 之前（不含）的最多 limit 条消息，按 id 升序；beforeID 为 0 表示从最新开始。
func (s *Store) ChatHistory(ctx context.Context, roomID string, beforeID int64, limit int) ([]*ChatMessage, bool, error) {
	if beforeID <= 0 {
		beforeID = 1<<63 - 1
	}
	rows, err := s.r.QueryContext(ctx, `SELECT id, room_id, coalesce(sender_uid, ''), sender_name, body, coalesce(reply_to, 0), created_at,
		coalesce(image_id, ''), coalesce(image_width, 0), coalesce(image_height, 0), coalesce(image_size, 0)
		FROM chat_messages WHERE room_id = ? AND id < ? AND deleted_at IS NULL ORDER BY id DESC LIMIT ?`,
		roomID, beforeID, limit+1)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()
	var out []*ChatMessage
	for rows.Next() {
		var m ChatMessage
		if err := rows.Scan(&m.ID, &m.RoomID, &m.SenderUID, &m.SenderName, &m.Body, &m.ReplyTo, &m.CreatedAt,
			&m.ImageID, &m.ImageWidth, &m.ImageHeight, &m.ImageSize); err != nil {
			return nil, false, err
		}
		out = append(out, &m)
	}
	if err := rows.Err(); err != nil {
		return nil, false, err
	}
	more := len(out) > limit
	if more {
		out = out[:limit]
	}
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return out, more, nil
}

// ChatImage 是聊天记录里引用的一张图片。
type ChatImage struct{ RoomID, ID string }

// PurgeChat 删除 before（Unix 毫秒）之前的聊天记录，返回删除的条数和这些消息附带的图片（调用方删除图片文件）。
func (s *Store) PurgeChat(ctx context.Context, before int64) (int64, []ChatImage, error) {
	tx, err := s.w.BeginTx(ctx, nil)
	if err != nil {
		return 0, nil, err
	}
	defer tx.Rollback()
	rows, err := tx.QueryContext(ctx, "SELECT room_id, image_id FROM chat_messages WHERE created_at < ? AND image_id IS NOT NULL", before)
	if err != nil {
		return 0, nil, err
	}
	var images []ChatImage
	for rows.Next() {
		var img ChatImage
		if err := rows.Scan(&img.RoomID, &img.ID); err != nil {
			rows.Close()
			return 0, nil, err
		}
		images = append(images, img)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, nil, err
	}
	res, err := tx.ExecContext(ctx, "DELETE FROM chat_messages WHERE created_at < ?", before)
	if err != nil {
		return 0, nil, err
	}
	n, _ := res.RowsAffected()
	return n, images, tx.Commit()
}

// ChatImages 返回聊天记录里引用的所有图片（启动时据此清理没有被引用的图片文件）。
func (s *Store) ChatImages(ctx context.Context) ([]ChatImage, error) {
	rows, err := s.r.QueryContext(ctx, "SELECT room_id, image_id FROM chat_messages WHERE image_id IS NOT NULL")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ChatImage
	for rows.Next() {
		var img ChatImage
		if err := rows.Scan(&img.RoomID, &img.ID); err != nil {
			return nil, err
		}
		out = append(out, img)
	}
	return out, rows.Err()
}

// ---------- audit ----------

type AuditEntry struct {
	ID       int64
	At       int64
	ActorUID string // 空表示系统或 CLI
	Action   string
	Target   string
	Detail   any // 序列化为 JSON
	IP       string
	// 查询时填写：操作者最后使用的昵称
	ActorName string
}

func (s *Store) InsertAudit(ctx context.Context, e *AuditEntry) error {
	if e.At == 0 {
		e.At = s.nowMs()
	}
	var detail sql.NullString
	if e.Detail != nil {
		b, err := json.Marshal(e.Detail)
		if err != nil {
			return err
		}
		detail = sql.NullString{String: string(b), Valid: true}
	}
	return s.w.QueryRowContext(ctx, `INSERT INTO audit_log(at, actor_uid, action, target, detail, ip) VALUES(?, ?, ?, ?, ?, ?) RETURNING id`,
		e.At, nullStr(e.ActorUID), e.Action, nullStr(e.Target), detail, nullStr(e.IP)).Scan(&e.ID)
}

// ListAudit 按时间倒序返回 beforeID 之前的审计记录（Detail 为原始 JSON 字符串）。
func (s *Store) ListAudit(ctx context.Context, beforeID int64, limit int) ([]*AuditEntry, error) {
	return s.QueryAudit(ctx, AuditQuery{BeforeID: beforeID, Limit: limit})
}

type AuditQuery struct {
	BeforeID     int64
	Limit        int
	ActionPrefix string // 例如 "moderate."
	ActorUID     string
}

// QueryAudit 按条件查询审计记录（时间倒序），附带操作者最后使用的昵称。
func (s *Store) QueryAudit(ctx context.Context, q AuditQuery) ([]*AuditEntry, error) {
	if q.BeforeID <= 0 {
		q.BeforeID = 1<<63 - 1
	}
	where, args := "a.id < ?", []any{q.BeforeID}
	if q.ActionPrefix != "" {
		where += " AND a.action LIKE ? ESCAPE '\\'"
		args = append(args, strings.NewReplacer("%", "\\%", "_", "\\_").Replace(q.ActionPrefix)+"%")
	}
	if q.ActorUID != "" {
		where += " AND a.actor_uid = ?"
		args = append(args, q.ActorUID)
	}
	args = append(args, q.Limit)
	rows, err := s.r.QueryContext(ctx, `SELECT a.id, a.at, coalesce(a.actor_uid, ''), a.action, coalesce(a.target, ''), coalesce(a.detail, ''),
		coalesce(a.ip, ''), coalesce(i.last_nickname, '')
		FROM audit_log a LEFT JOIN identities i ON i.uid = a.actor_uid WHERE `+where+` ORDER BY a.id DESC LIMIT ?`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*AuditEntry
	for rows.Next() {
		var e AuditEntry
		var detail string
		if err := rows.Scan(&e.ID, &e.At, &e.ActorUID, &e.Action, &e.Target, &detail, &e.IP, &e.ActorName); err != nil {
			return nil, err
		}
		if detail != "" {
			e.Detail = json.RawMessage(detail)
		}
		out = append(out, &e)
	}
	return out, rows.Err()
}

func (s *Store) PurgeAudit(ctx context.Context, before int64) (int64, error) {
	res, err := s.w.ExecContext(ctx, "DELETE FROM audit_log WHERE at < ?", before)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// ---------- bans ----------

type Ban struct {
	ID        int64
	UID       string
	IPCIDR    string
	Reason    string
	CreatedBy string
	CreatedAt int64
	ExpiresAt int64 // 0 表示永久
	// ListBans 时填写：被封禁身份最后使用的昵称
	Nickname string
}

// FindActiveBan 返回匹配 uid 或 ip 的有效封禁；没有时返回 ErrNotFound。
func (s *Store) FindActiveBan(ctx context.Context, uid string, ip netip.Addr) (*Ban, error) {
	rows, err := s.r.QueryContext(ctx, `SELECT id, coalesce(uid, ''), coalesce(ip_cidr, ''), coalesce(reason, ''), created_by, created_at, coalesce(expires_at, 0)
		FROM bans WHERE (expires_at IS NULL OR expires_at > ?) AND (uid = ? OR ip_cidr IS NOT NULL)`, s.nowMs(), uid)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var b Ban
		if err := rows.Scan(&b.ID, &b.UID, &b.IPCIDR, &b.Reason, &b.CreatedBy, &b.CreatedAt, &b.ExpiresAt); err != nil {
			return nil, err
		}
		if b.UID != "" && b.UID == uid {
			return &b, nil
		}
		if b.IPCIDR != "" && ip.IsValid() {
			if p, err := netip.ParsePrefix(b.IPCIDR); err == nil && p.Contains(ip.Unmap()) {
				return &b, nil
			}
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return nil, ErrNotFound
}

func (s *Store) InsertBan(ctx context.Context, b *Ban) error {
	if b.UID == "" && b.IPCIDR == "" {
		return errors.New("ban needs uid or ip")
	}
	if b.CreatedAt == 0 {
		b.CreatedAt = s.nowMs()
	}
	return s.w.QueryRowContext(ctx, `INSERT INTO bans(uid, ip_cidr, reason, created_by, created_at, expires_at) VALUES(?, ?, ?, ?, ?, ?) RETURNING id`,
		nullStr(b.UID), nullStr(b.IPCIDR), nullStr(b.Reason), b.CreatedBy, b.CreatedAt, nullInt(b.ExpiresAt)).Scan(&b.ID)
}

// ListBans 返回所有封禁（含已过期的，按创建时间倒序），附带被封禁身份最后使用的昵称。
func (s *Store) ListBans(ctx context.Context) ([]*Ban, error) {
	rows, err := s.r.QueryContext(ctx, `SELECT b.id, coalesce(b.uid, ''), coalesce(b.ip_cidr, ''), coalesce(b.reason, ''), b.created_by, b.created_at,
		coalesce(b.expires_at, 0), coalesce(i.last_nickname, '')
		FROM bans b LEFT JOIN identities i ON i.uid = b.uid ORDER BY b.id DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Ban
	for rows.Next() {
		var b Ban
		if err := rows.Scan(&b.ID, &b.UID, &b.IPCIDR, &b.Reason, &b.CreatedBy, &b.CreatedAt, &b.ExpiresAt, &b.Nickname); err != nil {
			return nil, err
		}
		out = append(out, &b)
	}
	return out, rows.Err()
}

func (s *Store) RemoveBan(ctx context.Context, id int64) error {
	res, err := s.w.ExecContext(ctx, "DELETE FROM bans WHERE id = ?", id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}
