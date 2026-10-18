// Package perm 定义角色和权限检查。
package perm

import (
	"fmt"

	"github.com/karllee830/OpenHane/server/internal/pb"
)

// Role 按权限从低到高排序，可以直接比较大小。
type Role int

const (
	Member Role = iota + 1
	Moderator
	Admin
)

func (r Role) String() string {
	switch r {
	case Member:
		return "member"
	case Moderator:
		return "moderator"
	case Admin:
		return "admin"
	}
	return fmt.Sprintf("role(%d)", int(r))
}

func ParseRole(s string) (Role, error) {
	switch s {
	case "member":
		return Member, nil
	case "moderator":
		return Moderator, nil
	case "admin":
		return Admin, nil
	}
	return 0, fmt.Errorf("unknown role %q", s)
}

func (r Role) Proto() pb.Role {
	switch r {
	case Member:
		return pb.Role_ROLE_MEMBER
	case Moderator:
		return pb.Role_ROLE_MODERATOR
	case Admin:
		return pb.Role_ROLE_ADMIN
	}
	return pb.Role_ROLE_UNSPECIFIED
}

func FromProto(r pb.Role) (Role, bool) {
	switch r {
	case pb.Role_ROLE_MEMBER:
		return Member, true
	case pb.Role_ROLE_MODERATOR:
		return Moderator, true
	case pb.Role_ROLE_ADMIN:
		return Admin, true
	}
	return 0, false
}
