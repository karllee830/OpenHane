package store

import (
	"context"
	"database/sql"
	"errors"

	"github.com/karllee830/OpenHane/server/internal/perm"
)

type PrivilegeToken struct {
	ID        string
	Hash      []byte
	Role      perm.Role
	MaxUses   int // 0 表示不限
	UsedCount int
	ExpiresAt int64 // 0 表示不过期
	CreatedBy string
	CreatedAt int64
	RevokedAt int64
	Note      string
}

// SystemCreator 是服务端自动生成的令牌（首个管理员令牌）的创建者。
const SystemCreator = "system"

var (
	ErrTokenInvalid = errors.New("token invalid")
	ErrTokenExpired = errors.New("token expired")
	ErrTokenUsedUp  = errors.New("token used up")
)

func (s *Store) CreateToken(ctx context.Context, t *PrivilegeToken) error {
	if t.CreatedAt == 0 {
		t.CreatedAt = s.nowMs()
	}
	_, err := s.w.ExecContext(ctx, `
		INSERT INTO privilege_tokens(id, token_hash, role, max_uses, expires_at, created_by, created_at, note)
		VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
		t.ID, t.Hash, t.Role.String(), t.MaxUses, nullInt(t.ExpiresAt), t.CreatedBy, t.CreatedAt, nullStr(t.Note))
	return err
}

// RevokeUnusedSystemTokens 作废所有尚未兑换的系统令牌（每次重新生成首个管理员令牌前调用）。
func (s *Store) RevokeUnusedSystemTokens(ctx context.Context) error {
	_, err := s.w.ExecContext(ctx, `UPDATE privilege_tokens SET revoked_at = ?
		WHERE created_by = ? AND revoked_at IS NULL AND used_count = 0`, s.nowMs(), SystemCreator)
	return err
}

// RedeemResult 是兑换的结果。
type RedeemResult struct {
	Token    *PrivilegeToken
	OldRole  perm.Role
	NewRole  perm.Role
	Consumed bool // 只有角色确实提升时才消耗令牌（只升不降）
}

// RedeemToken 在一个事务中校验令牌并提升 uid 的角色。
func (s *Store) RedeemToken(ctx context.Context, hash []byte, uid string) (*RedeemResult, error) {
	tx, err := s.w.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	t, err := scanToken(tx.QueryRowContext(ctx, `SELECT `+tokenCols+` FROM privilege_tokens WHERE token_hash = ?`, hash))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrTokenInvalid
	}
	if err != nil {
		return nil, err
	}
	now := s.nowMs()
	switch {
	case t.RevokedAt != 0:
		return nil, ErrTokenInvalid
	case t.ExpiresAt != 0 && now >= t.ExpiresAt:
		return nil, ErrTokenExpired
	case t.MaxUses != 0 && t.UsedCount >= t.MaxUses:
		return nil, ErrTokenUsedUp
	}

	var cur string
	if err := tx.QueryRowContext(ctx, "SELECT role FROM identities WHERE uid = ?", uid).Scan(&cur); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	old, err := perm.ParseRole(cur)
	if err != nil {
		return nil, err
	}
	res := &RedeemResult{Token: t, OldRole: old, NewRole: old}
	if t.Role > old {
		if _, err := tx.ExecContext(ctx, "UPDATE identities SET role = ? WHERE uid = ?", t.Role.String(), uid); err != nil {
			return nil, err
		}
		if _, err := tx.ExecContext(ctx, "UPDATE privilege_tokens SET used_count = used_count + 1 WHERE id = ?", t.ID); err != nil {
			return nil, err
		}
		t.UsedCount++
		res.NewRole, res.Consumed = t.Role, true
	}
	return res, tx.Commit()
}

func (s *Store) ListTokens(ctx context.Context) ([]*PrivilegeToken, error) {
	rows, err := s.r.QueryContext(ctx, `SELECT `+tokenCols+` FROM privilege_tokens ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*PrivilegeToken
	for rows.Next() {
		t, err := scanToken(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

func (s *Store) RevokeToken(ctx context.Context, id string) error {
	res, err := s.w.ExecContext(ctx, "UPDATE privilege_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", s.nowMs(), id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

const tokenCols = `id, token_hash, role, max_uses, used_count, coalesce(expires_at, 0), created_by, created_at,
	coalesce(revoked_at, 0), coalesce(note, '')`

func scanToken(row interface{ Scan(...any) error }) (*PrivilegeToken, error) {
	var t PrivilegeToken
	var role string
	if err := row.Scan(&t.ID, &t.Hash, &role, &t.MaxUses, &t.UsedCount, &t.ExpiresAt, &t.CreatedBy, &t.CreatedAt,
		&t.RevokedAt, &t.Note); err != nil {
		return nil, err
	}
	r, err := perm.ParseRole(role)
	t.Role = r
	return &t, err
}
