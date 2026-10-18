package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"

	"github.com/karllee830/OpenHane/server/internal/perm"
)

// 邀请码：免服务器密码入场，可附带角色（使用后提升到该角色，只升不降）。

type Invite struct {
	Code           string
	BypassPassword bool
	Role           perm.Role // Member 表示不改变角色
	MaxUses        int       // 0 表示不限
	UsedCount      int
	ExpiresAt      int64 // 0 表示不过期
	CreatedBy      string
	CreatedAt      int64
}

type inviteGrants struct {
	BypassPassword bool   `json:"bypass_password,omitempty"`
	Role           string `json:"role,omitempty"`
}

var (
	ErrInviteInvalid = errors.New("invite invalid")
	ErrInviteExpired = errors.New("invite expired")
	ErrInviteUsedUp  = errors.New("invite used up")
)

func (s *Store) CreateInvite(ctx context.Context, inv *Invite) error {
	if inv.CreatedAt == 0 {
		inv.CreatedAt = s.nowMs()
	}
	g := inviteGrants{BypassPassword: inv.BypassPassword}
	if inv.Role > perm.Member {
		g.Role = inv.Role.String()
	}
	b, _ := json.Marshal(g)
	_, err := s.w.ExecContext(ctx, `INSERT INTO invites(code, grants, max_uses, used_count, expires_at, created_by, created_at) VALUES(?, ?, ?, 0, ?, ?, ?)`,
		inv.Code, string(b), inv.MaxUses, nullInt(inv.ExpiresAt), inv.CreatedBy, inv.CreatedAt)
	return err
}

const inviteCols = `code, grants, max_uses, used_count, coalesce(expires_at, 0), created_by, created_at`

func scanInvite(row interface{ Scan(...any) error }) (*Invite, error) {
	var inv Invite
	var grants string
	if err := row.Scan(&inv.Code, &grants, &inv.MaxUses, &inv.UsedCount, &inv.ExpiresAt, &inv.CreatedBy, &inv.CreatedAt); err != nil {
		return nil, err
	}
	var g inviteGrants
	_ = json.Unmarshal([]byte(grants), &g)
	inv.BypassPassword = g.BypassPassword
	inv.Role = perm.Member
	if g.Role != "" {
		if r, err := perm.ParseRole(g.Role); err == nil {
			inv.Role = r
		}
	}
	return &inv, nil
}

func (s *Store) ListInvites(ctx context.Context) ([]*Invite, error) {
	rows, err := s.r.QueryContext(ctx, `SELECT `+inviteCols+` FROM invites ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Invite
	for rows.Next() {
		inv, err := scanInvite(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, inv)
	}
	return out, rows.Err()
}

func (s *Store) DeleteInvite(ctx context.Context, code string) error {
	res, err := s.w.ExecContext(ctx, "DELETE FROM invites WHERE code = ?", code)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// UseInvite 校验并消耗一次邀请码（一个事务中完成），返回邀请码的内容。
// PeekInvite 检查邀请码是否可用，不扣减使用次数（握手时先确认，所有校验通过后再用 UseInvite 扣减）。
func (s *Store) PeekInvite(ctx context.Context, code string) (*Invite, error) {
	inv, err := scanInvite(s.r.QueryRowContext(ctx, `SELECT `+inviteCols+` FROM invites WHERE code = ?`, code))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrInviteInvalid
	}
	if err != nil {
		return nil, err
	}
	switch {
	case inv.ExpiresAt != 0 && s.nowMs() >= inv.ExpiresAt:
		return nil, ErrInviteExpired
	case inv.MaxUses != 0 && inv.UsedCount >= inv.MaxUses:
		return nil, ErrInviteUsedUp
	}
	return inv, nil
}

func (s *Store) UseInvite(ctx context.Context, code string) (*Invite, error) {
	tx, err := s.w.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	inv, err := scanInvite(tx.QueryRowContext(ctx, `SELECT `+inviteCols+` FROM invites WHERE code = ?`, code))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrInviteInvalid
	}
	if err != nil {
		return nil, err
	}
	switch {
	case inv.ExpiresAt != 0 && s.nowMs() >= inv.ExpiresAt:
		return nil, ErrInviteExpired
	case inv.MaxUses != 0 && inv.UsedCount >= inv.MaxUses:
		return nil, ErrInviteUsedUp
	}
	if _, err := tx.ExecContext(ctx, "UPDATE invites SET used_count = used_count + 1 WHERE code = ?", code); err != nil {
		return nil, err
	}
	inv.UsedCount++
	return inv, tx.Commit()
}
