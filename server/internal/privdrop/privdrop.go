// Package privdrop 实现 Docker 镜像里的「以 root 启动 → 修正数据目录属主 → 降为普通用户运行」，
// 与 PostgreSQL 等官方镜像的入口脚本（chown + su-exec / gosu）做法相同。
// 镜像是 distroless、没有 shell，所以由二进制自己完成。
//
// 只在以 root 运行且设置了 PUID 时生效（镜像里默认 PUID=PGID=65532）：
//   - 绑定挂载的宿主机目录通常属于 root，降权前把它交给运行用户，开箱即用；
//   - PUID / PGID 可以改成 NAS 上的用户，方便在宿主机上管理数据文件；
//   - PUID=0 表示保持 root 运行；用 docker run --user / compose 的 user: 指定非 root 身份时什么都不做。
package privdrop

import (
	"fmt"
	"strconv"
)

// Target 从 PUID / PGID 读取要降到的用户。PUID 未设置或为 0 时 ok=false（不降权）；PGID 未设置时与 PUID 相同。
func Target(getenv func(string) string) (uid, gid int, ok bool, err error) {
	ps := getenv("PUID")
	if ps == "" {
		return 0, 0, false, nil
	}
	uid, err = strconv.Atoi(ps)
	if err != nil || uid < 0 {
		return 0, 0, false, fmt.Errorf("PUID=%q 不是有效的用户 ID", ps)
	}
	gid = uid
	if gs := getenv("PGID"); gs != "" {
		gid, err = strconv.Atoi(gs)
		if err != nil || gid < 0 {
			return 0, 0, false, fmt.Errorf("PGID=%q 不是有效的组 ID", gs)
		}
	}
	return uid, gid, uid != 0, nil
}
