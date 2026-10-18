package privdrop

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"syscall"
)

// Drop 以 root 运行且设置了 PUID 时：确保数据目录存在并属于目标用户，然后放弃 root（附加组、GID、UID）。
// 必须在启动其他 goroutine 之前调用。Go 的 Setuid / Setgid 会作用于进程的所有线程。
func Drop(dataDir string, getenv func(string) string) error {
	uid, gid, ok, err := Target(getenv)
	if err != nil || !ok {
		return err
	}
	if os.Getuid() != 0 {
		// 设置了 PUID（在镜像里）却不是以 root 启动：容器被指定了运行用户。
		// 常见于 NAS 的 Docker 界面更新镜像时沿用了旧容器的 user: 设置
		if !writable(dataDir) {
			return fmt.Errorf("数据目录 %s 不可写：容器被指定以 uid=%d gid=%d 运行（docker 的 --user / user: 设置），所以没有自动修正目录属主。\n"+
				"请去掉容器的运行用户设置（从旧版本升级时，NAS 的 Docker 界面可能沿用了旧镜像的 nonroot），"+
				"需要时用 PUID / PGID 指定运行用户；或者把宿主机上的数据目录属主改成 %d:%d",
				dataDir, os.Getuid(), os.Getgid(), os.Getuid(), os.Getgid())
		}
		return nil
	}
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return fmt.Errorf("创建数据目录 %s: %w", dataDir, err)
	}
	// 改不了属主（例如 NFS 的 root_squash、SMB 挂载、去掉了 CHOWN 权限）时继续：
	// 目录本身可能已经可写；不可写时打开数据库会给出明确的错误。
	if err := chownTree(dataDir, uid, gid); err != nil {
		fmt.Fprintf(os.Stderr, "warning: 无法把数据目录 %s 的属主改成 %d:%d：%v\n", dataDir, uid, gid, err)
	}
	if err := syscall.Setgroups([]int{}); err != nil {
		return fmt.Errorf("降权（setgroups）失败：%w；如需保持 root 运行，设置 PUID=0", err)
	}
	if err := syscall.Setgid(gid); err != nil {
		return fmt.Errorf("降权到 GID %d 失败：%w；如需保持 root 运行，设置 PUID=0", gid, err)
	}
	if err := syscall.Setuid(uid); err != nil {
		return fmt.Errorf("降权到 UID %d 失败：%w；如需保持 root 运行，设置 PUID=0", uid, err)
	}
	if !writable(dataDir) {
		return fmt.Errorf("数据目录 %s 对运行用户 %d:%d 不可写（无法修改属主，或者目录由 ACL 管理）。\n"+
			"请把 PUID / PGID 设成宿主机上对这个目录有写权限的用户（在宿主机上用 id <用户名> 查看），或者在宿主机上给 %d:%d 授权",
			dataDir, uid, gid, uid, gid)
	}
	return nil
}

func writable(dir string) bool {
	f, err := os.CreateTemp(dir, ".writecheck-*")
	if err != nil {
		return false
	}
	f.Close()
	os.Remove(f.Name())
	return true
}

// chownTree 把目录下属主不对的文件改成 uid:gid（不跟随符号链接）。属主已经正确时不写入，每次启动的开销只是遍历一遍。
func chownTree(root string, uid, gid int) error {
	return filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		if st, ok := info.Sys().(*syscall.Stat_t); ok && int(st.Uid) == uid && int(st.Gid) == gid {
			return nil
		}
		return os.Lchown(path, uid, gid)
	})
}
