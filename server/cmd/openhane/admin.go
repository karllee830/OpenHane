package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"strconv"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/karllee830/OpenHane/server/internal/adminsock"
	"github.com/karllee830/OpenHane/server/internal/hub"
	"github.com/karllee830/OpenHane/server/internal/perm"
	"github.com/karllee830/OpenHane/server/internal/settings"
	"github.com/karllee830/OpenHane/server/internal/store"
)

func fmtTime(ms int64) string {
	if ms == 0 {
		return "-"
	}
	return time.UnixMilli(ms).Format("2006-01-02 15:04")
}

func tokenCmd(args []string) error {
	if len(args) == 0 {
		return errors.New("usage: openhane token create|list|revoke")
	}
	ctx := context.Background()
	switch args[0] {
	case "create":
		fs := flag.NewFlagSet("token create", flag.ExitOnError)
		roleName := fs.String("role", "admin", "admin 或 moderator")
		uses := fs.Int("uses", 1, "可用次数，0 表示不限")
		expires := fs.Duration("expires", 0, "有效期，如 24h；0 表示不过期")
		note := fs.String("note", "", "备注")
		fs.Parse(args[1:])
		role, err := perm.ParseRole(*roleName)
		if err != nil {
			return err
		}
		s, _, err := openStore(ctx)
		if err != nil {
			return err
		}
		defer s.Close()
		plain, t, err := hub.CreatePrivilegeToken(ctx, s, role, *uses, *expires, *note, "cli")
		if err != nil {
			return err
		}
		s.InsertAudit(ctx, &store.AuditEntry{Action: "token.create", Target: t.ID, Detail: map[string]any{"role": role.String(), "via": "cli"}})
		fmt.Printf("%s 令牌（ID %s）：\n\n    %s\n\n在客户端中：菜单 → 使用权限令牌\n", role, t.ID, plain)
		return nil
	case "list":
		s, _, err := openStore(ctx)
		if err != nil {
			return err
		}
		defer s.Close()
		list, err := s.ListTokens(ctx)
		if err != nil {
			return err
		}
		w := tabwriter.NewWriter(os.Stdout, 0, 2, 2, ' ', 0)
		fmt.Fprintln(w, "ID\tROLE\tUSED\tMAX\tEXPIRES\tCREATED BY\tCREATED\tREVOKED\tNOTE")
		for _, t := range list {
			max := fmt.Sprint(t.MaxUses)
			if t.MaxUses == 0 {
				max = "∞"
			}
			fmt.Fprintf(w, "%s\t%s\t%d\t%s\t%s\t%s\t%s\t%s\t%s\n", t.ID, t.Role, t.UsedCount, max, fmtTime(t.ExpiresAt),
				t.CreatedBy, fmtTime(t.CreatedAt), fmtTime(t.RevokedAt), t.Note)
		}
		return w.Flush()
	case "revoke":
		if len(args) != 2 {
			return errors.New("usage: openhane token revoke <id>")
		}
		s, _, err := openStore(ctx)
		if err != nil {
			return err
		}
		defer s.Close()
		if err := s.RevokeToken(ctx, args[1]); err != nil {
			return err
		}
		s.InsertAudit(ctx, &store.AuditEntry{Action: "token.revoke", Target: args[1], Detail: map[string]string{"via": "cli"}})
		fmt.Println("revoked", args[1])
		return nil
	}
	return fmt.Errorf("unknown token command %q", args[0])
}

func userCmd(args []string) error {
	if len(args) == 0 {
		return errors.New("usage: openhane user list|set-role")
	}
	ctx := context.Background()
	switch args[0] {
	case "list":
		fs := flag.NewFlagSet("user list", flag.ExitOnError)
		roleName := fs.String("role", "", "只列出该角色")
		fs.Parse(args[1:])
		var role perm.Role
		if *roleName != "" {
			r, err := perm.ParseRole(*roleName)
			if err != nil {
				return err
			}
			role = r
		}
		s, _, err := openStore(ctx)
		if err != nil {
			return err
		}
		defer s.Close()
		list, total, err := s.ListIdentities(ctx, role, 500, 0)
		if err != nil {
			return err
		}
		w := tabwriter.NewWriter(os.Stdout, 0, 2, 2, ' ', 0)
		fmt.Fprintln(w, "UID\tROLE\tNICKNAME\tLAST SEEN\tLAST IP\tCLIENT")
		for _, i := range list {
			fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\t%s\n", i.UID, i.Role, i.Nickname, fmtTime(i.LastSeenAt), i.LastIP, i.LastClient)
		}
		w.Flush()
		fmt.Printf("\n%d identities\n", total)
		return nil
	case "set-role":
		if len(args) != 3 {
			return errors.New("usage: openhane user set-role <uid> <admin|moderator|member>")
		}
		role, err := perm.ParseRole(args[2])
		if err != nil {
			return err
		}
		// 服务运行中：经管理套接字修改，在线用户立即生效
		if res, err := callRunning("user.set_role", args[1], args[2]); !errors.Is(err, adminsock.ErrNotRunning) {
			return printResult(res, err)
		}
		s, _, err := openStore(ctx)
		if err != nil {
			return err
		}
		defer s.Close()
		if err := s.SetRole(ctx, args[1], role); err != nil {
			return err
		}
		s.InsertAudit(ctx, &store.AuditEntry{Action: "user.set_role", Target: args[1], Detail: map[string]string{"role": role.String(), "via": "cli"}})
		fmt.Printf("%s is now %s\n", args[1], role)
		return nil
	}
	return fmt.Errorf("unknown user command %q", args[0])
}

// callRunning 经本地管理套接字调用运行中的服务；服务未运行时返回 adminsock.ErrNotRunning。
func callRunning(cmd string, args ...string) (json.RawMessage, error) {
	cfg, err := loadConfig()
	if err != nil {
		return nil, err
	}
	return adminsock.Call(adminsock.Path(cfg.DataDir), cmd, args...)
}

func printResult(res json.RawMessage, err error) error {
	if err != nil {
		return err
	}
	var v any
	if json.Unmarshal(res, &v) == nil {
		out, _ := json.MarshalIndent(v, "", "  ")
		fmt.Println(string(out))
	}
	return nil
}

func settingsCmd(args []string) error {
	if len(args) == 0 {
		return errors.New("usage: openhane settings get [key] | set <key> <json>")
	}
	switch args[0] {
	case "get":
		res, err := callRunning("settings.get", args[1:]...)
		if errors.Is(err, adminsock.ErrNotRunning) {
			// 服务未运行：直接读数据库
			ctx := context.Background()
			s, _, err := openStore(ctx)
			if err != nil {
				return err
			}
			defer s.Close()
			stored, err := s.LoadSettings(ctx)
			if err != nil {
				return err
			}
			cur, _ := settings.FromStored(stored)
			values := cur.Public()
			if len(args) == 2 {
				v, ok := values[args[1]]
				if !ok {
					return fmt.Errorf("unknown setting %q", args[1])
				}
				values = map[string]string{args[1]: v}
			}
			b, _ := json.Marshal(values)
			return printResult(b, nil)
		}
		return printResult(res, err)
	case "set":
		if len(args) != 3 {
			return errors.New("usage: openhane settings set <key> <json>，例如 settings set server.name '\"我的服务器\"'")
		}
		res, err := callRunning("settings.set", args[1], args[2])
		if errors.Is(err, adminsock.ErrNotRunning) {
			ctx := context.Background()
			s, _, err := openStore(ctx)
			if err != nil {
				return err
			}
			defer s.Close()
			stored, err := s.LoadSettings(ctx)
			if err != nil {
				return err
			}
			cur, _ := settings.FromStored(stored)
			_, kv, err := cur.Apply(settings.Patch{args[1]: args[2]}, settings.HashPassword)
			if err != nil {
				return err
			}
			if err := s.PutSettings(ctx, kv, "cli"); err != nil {
				return err
			}
			fmt.Println("saved (server not running; takes effect on next start)")
			return nil
		}
		return printResult(res, err)
	}
	return fmt.Errorf("unknown settings command %q", args[0])
}

func banCmd(args []string) error {
	if len(args) == 0 {
		return errors.New("usage: openhane ban add <uid|ip|cidr> [duration|permanent] [reason] | list | remove <id>")
	}
	ctx := context.Background()
	switch args[0] {
	case "add":
		res, err := callRunning("ban.add", args[1:]...)
		if errors.Is(err, adminsock.ErrNotRunning) {
			return errors.New("server is not running: start it first (bans also kick online users immediately)")
		}
		return printResult(res, err)
	case "list":
		s, _, err := openStore(ctx)
		if err != nil {
			return err
		}
		defer s.Close()
		bans, err := s.ListBans(ctx)
		if err != nil {
			return err
		}
		w := tabwriter.NewWriter(os.Stdout, 0, 2, 2, ' ', 0)
		fmt.Fprintln(w, "ID\tUID\tIP\tEXPIRES\tREASON\tBY\tCREATED")
		for _, b := range bans {
			fmt.Fprintf(w, "%d\t%s\t%s\t%s\t%s\t%s\t%s\n", b.ID, b.UID, b.IPCIDR, fmtTime(b.ExpiresAt), b.Reason, b.CreatedBy, fmtTime(b.CreatedAt))
		}
		return w.Flush()
	case "remove":
		if len(args) != 2 {
			return errors.New("usage: openhane ban remove <id>")
		}
		res, err := callRunning("ban.remove", args[1])
		if errors.Is(err, adminsock.ErrNotRunning) {
			s, _, err := openStore(ctx)
			if err != nil {
				return err
			}
			defer s.Close()
			id, err := strconv.ParseInt(args[1], 10, 64)
			if err != nil {
				return err
			}
			return s.RemoveBan(ctx, id)
		}
		return printResult(res, err)
	}
	return fmt.Errorf("unknown ban command %q", args[0])
}

func diagCmd() error {
	res, err := callRunning("diag")
	if errors.Is(err, adminsock.ErrNotRunning) {
		return errors.New("server is not running")
	}
	return printResult(res, err)
}

func noticeCmd(args []string) error {
	if len(args) == 0 {
		return errors.New("usage: openhane notice <text>")
	}
	return printResult(callRunning("notice", strings.Join(args, " ")))
}
