package store

import (
	"context"
	"database/sql"
	"errors"

	"github.com/karllee830/OpenHane/server/internal/perm"
)

type Identity struct {
	UID         string
	PublicKey   []byte
	Role        perm.Role
	Nickname    string
	FirstSeenAt int64
	LastSeenAt  int64
	LastIP      string
	LastClient  string
	Note        string
}

// TouchIdentity 在鉴权通过时写入或更新身份记录，返回当前角色。
// ip 为空表示不保存 IP（privacy.store_ip 关闭）。
func (s *Store) TouchIdentity(ctx context.Context, uid string, pub []byte, nickname, ip, client string) (perm.Role, error) {
	now := s.nowMs()
	var role string
	err := s.w.QueryRowContext(ctx, `
		INSERT INTO identities(uid, public_key, last_nickname, first_seen_at, last_seen_at, last_ip, last_client)
		VALUES(?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(uid) DO UPDATE SET
		  last_nickname = excluded.last_nickname,
		  last_seen_at  = excluded.last_seen_at,
		  last_ip       = excluded.last_ip,
		  last_client   = excluded.last_client
		RETURNING role`,
		uid, pub, nickname, now, now, nullStr(ip), nullStr(client)).Scan(&role)
	if err != nil {
		return 0, err
	}
	return perm.ParseRole(role)
}

func (s *Store) GetIdentity(ctx context.Context, uid string) (*Identity, error) {
	row := s.r.QueryRowContext(ctx, `SELECT `+identityCols+` FROM identities WHERE uid = ?`, uid)
	id, err := scanIdentity(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return id, err
}

// SetRole 修改角色。降级最后一名管理员会被拒绝（服务器必须至少保留一名管理员）。
func (s *Store) SetRole(ctx context.Context, uid string, role perm.Role) error {
	tx, err := s.w.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var cur string
	if err := tx.QueryRowContext(ctx, "SELECT role FROM identities WHERE uid = ?", uid).Scan(&cur); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		return err
	}
	if cur == perm.Admin.String() && role != perm.Admin {
		var admins int
		if err := tx.QueryRowContext(ctx, "SELECT count(*) FROM identities WHERE role = 'admin'").Scan(&admins); err != nil {
			return err
		}
		if admins <= 1 {
			return ErrLastAdmin
		}
	}
	if _, err := tx.ExecContext(ctx, "UPDATE identities SET role = ? WHERE uid = ?", role.String(), uid); err != nil {
		return err
	}
	return tx.Commit()
}

// ErrLastAdmin 表示操作会让服务器没有管理员。
var ErrLastAdmin = errors.New("server must keep at least one admin")

func (s *Store) CountAdmins(ctx context.Context) (int, error) {
	var n int
	err := s.r.QueryRowContext(ctx, "SELECT count(*) FROM identities WHERE role = 'admin'").Scan(&n)
	return n, err
}

// ListIdentities 按最近在线时间倒序列出身份；role 为 0 表示全部。
func (s *Store) ListIdentities(ctx context.Context, role perm.Role, limit, offset int) ([]*Identity, int, error) {
	where, args := "", []any{}
	if role != 0 {
		where, args = " WHERE role = ?", append(args, role.String())
	}
	var total int
	if err := s.r.QueryRowContext(ctx, "SELECT count(*) FROM identities"+where, args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	rows, err := s.r.QueryContext(ctx, `SELECT `+identityCols+` FROM identities`+where+
		` ORDER BY last_seen_at DESC LIMIT ? OFFSET ?`, append(args, limit, offset)...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	var out []*Identity
	for rows.Next() {
		id, err := scanIdentity(rows)
		if err != nil {
			return nil, 0, err
		}
		out = append(out, id)
	}
	return out, total, rows.Err()
}

const identityCols = `uid, public_key, role, last_nickname, first_seen_at, last_seen_at,
	coalesce(last_ip, ''), coalesce(last_client, ''), coalesce(note, '')`

func scanIdentity(row interface{ Scan(...any) error }) (*Identity, error) {
	var id Identity
	var role string
	if err := row.Scan(&id.UID, &id.PublicKey, &role, &id.Nickname, &id.FirstSeenAt, &id.LastSeenAt,
		&id.LastIP, &id.LastClient, &id.Note); err != nil {
		return nil, err
	}
	r, err := perm.ParseRole(role)
	id.Role = r
	return &id, err
}
